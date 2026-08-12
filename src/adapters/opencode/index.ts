import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import {
  API_BASE_URL,
  MODEL_ID,
  PROVIDER_ID,
} from "../../core/constants.ts"
import { kimiHeaders } from "../../core/headers.ts"
import {
  type KimiModelInfo,
  listModels,
  pollDeviceToken,
  startDeviceAuth,
} from "../../core/oauth.ts"
import { isAuthExpiring, isOAuthAuth, refreshAuthWithLock, type OAuthAuth } from "../../core/refresh.ts"
import {
  applyKimiBodyFields,
  hasKimiBodyFields,
  resolveKimiBodyFields,
  type KimiBodyFields,
} from "../../core/body-fields.ts"
import { thinkingConfig } from "../../core/thinking.ts"
import { isSafeModelId } from "../../core/validation.ts"
import { readAuth } from "./auth-store.ts"
import { RELOGIN_HINT, resolveRefreshLockDir } from "./refresh-impl.ts"

// IMPORTANT: this module must have exactly ONE export — the default
// PluginModule object. opencode's plugin loader detects the v1 format
// ({ id, server }) via readV1Plugin *before* falling back to
// getLegacyPlugins — which iterates every export and throws "Plugin export
// is not a function" on any non-callable value. The v1 path is more
// reliable on Windows where Bun standalone dynamic imports can produce
// module namespace objects with unexpected non-function metadata.
// Keep constants in core/constants.ts and import them here.

type ModelWithDiscoveryMetadata = {
  id?: string
  providerID?: string
  api?: {
    id?: string
    [key: string]: unknown
  }
  name?: string
  reasoning?: boolean
  attachment?: boolean
  options?: Record<string, unknown>
  variants?: Record<string, Record<string, unknown>>
  limit?: {
    context?: number
  }
  modalities?: {
    input?: string[]
    output?: string[]
  }
  capabilities?: {
    reasoning?: boolean
    attachment?: boolean
    toolcall?: boolean
    input?: {
      image?: boolean
      video?: boolean
    }
  }
}

type KimiHookInput = {
  sessionID: string
  model: {
    providerID: string
    id: string
    options?: Record<string, unknown>
    variants?: Record<string, Record<string, unknown>>
  }
  message: {
    model: {
      variant?: string
    }
  }
}

type KimiConfigModel = {
  name: string
  reasoning: boolean
  tool_call?: boolean
  options: Record<string, unknown>
  variants: Record<string, Record<string, unknown>>
  limit?: {
    context: number
    output: 0
  }
  attachment?: boolean
  modalities?: {
    input: Array<"text" | "image" | "video">
    output: Array<"text">
  }
}

// Private transport headers used to carry Kimi body fields from chat.headers /
// chat.params into loader.fetch. They are consumed and stripped there and must
// never leak upstream. These are OpenCode adapter internals — NOT in core.
const INTERNAL_PROMPT_CACHE_KEY_HEADER = "x-opencode-kimi-prompt-cache-key"
const INTERNAL_REASONING_EFFORT_HEADER = "x-opencode-kimi-reasoning-effort"
const INTERNAL_THINKING_TYPE_HEADER = "x-opencode-kimi-thinking-type"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function consumeInternalKimiBodyFields(headers: Headers): KimiBodyFields {
  const fields: KimiBodyFields = {}
  const promptCacheKey = headers.get(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  if (promptCacheKey) fields.prompt_cache_key = promptCacheKey
  const reasoningEffort = headers.get(INTERNAL_REASONING_EFFORT_HEADER)
  if (reasoningEffort) fields.reasoning_effort = reasoningEffort
  const thinkingType = headers.get(INTERNAL_THINKING_TYPE_HEADER)
  if (thinkingType === "enabled" || thinkingType === "disabled") {
    fields.thinking = { type: thinkingType }
  }
  headers.delete(INTERNAL_PROMPT_CACHE_KEY_HEADER)
  headers.delete(INTERNAL_REASONING_EFFORT_HEADER)
  headers.delete(INTERNAL_THINKING_TYPE_HEADER)
  return fields
}

function withDiscoveredIdentifier<T extends ModelWithDiscoveryMetadata>(model: T, id: string): T {
  if (model.id === id && model.api?.id === id) return model
  return {
    ...model,
    id,
    ...(model.api ? { api: { ...model.api, id } } : {}),
  }
}

function withDiscoveredContext<T extends ModelWithDiscoveryMetadata>(model: T, contextLength: number | undefined): T {
  if (!contextLength || contextLength <= 0) return model
  return {
    ...model,
    limit: {
      ...model.limit,
      context: contextLength,
    },
  }
}

function withDiscoveredDisplayName<T extends ModelWithDiscoveryMetadata>(model: T, displayName: string | undefined): T {
  if (!displayName || model.name === displayName) return model
  return {
    ...model,
    name: displayName,
  }
}

function kimiSelectorDisplayName(info: KimiModelInfo) {
  switch (info.id) {
    case "kimi-for-coding":
      return "K2.7"
    case "kimi-for-coding-highspeed":
      return "K2.7 HighSpeed"
    case "k3":
      return "K3 (1M)"
    case "k3-256k":
      return "K3 (256K)"
    default:
      return info.display_name ?? info.id
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}

function withDisabledHostReasoningVariants(variants: Record<string, Record<string, unknown>>) {
  const projected = { ...variants }
  for (const key of ["low", "medium", "high"] as const) {
    if (!Object.hasOwn(projected, key)) projected[key] = { disabled: true }
  }
  return projected
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function withDiscoveredMediaInput<T extends ModelWithDiscoveryMetadata>(
  model: T,
  supportsImageIn: boolean | undefined,
  supportsVideoIn: boolean | undefined,
): T {
  if (supportsImageIn === undefined && supportsVideoIn === undefined) return model

  let attachment = model.attachment
  if (supportsImageIn === true || supportsVideoIn === true) {
    attachment = true
  } else if (supportsImageIn === false && supportsVideoIn === false) {
    attachment = false
  }

  const currentInputModalities = model.modalities?.input
  const currentOutputModalities = model.modalities?.output
  const input = uniqueStrings([
    "text",
    ...(currentInputModalities ?? []),
    ...(supportsImageIn === true ? ["image"] : []),
    ...(supportsVideoIn === true ? ["video"] : []),
  ])
    .filter((value) => value !== "image" || supportsImageIn !== false)
    .filter((value) => value !== "video" || supportsVideoIn !== false)

  return {
    ...model,
    ...(attachment === undefined ? {} : { attachment }),
    modalities: {
      ...model.modalities,
      input,
      output: uniqueStrings(["text", ...(currentOutputModalities ?? [])]),
    },
    capabilities: {
      ...model.capabilities,
      ...(attachment === undefined ? {} : { attachment }),
      input: {
        ...model.capabilities?.input,
        ...(supportsImageIn === undefined ? {} : { image: supportsImageIn }),
        ...(supportsVideoIn === undefined ? {} : { video: supportsVideoIn }),
      },
    },
  }
}

function withDiscoveredToolUse<T extends ModelWithDiscoveryMetadata>(model: T, supportsToolUse: boolean | undefined): T {
  if (supportsToolUse === undefined) return model
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      toolcall: supportsToolUse,
    },
  }
}

function withDiscoveredThinking<T extends ModelWithDiscoveryMetadata>(model: T, info: KimiModelInfo): T {
  const config = thinkingConfig(info, model.options)
  return {
    ...model,
    reasoning: config.reasoning,
    options: config.options,
    variants: config.variants,
    capabilities: {
      ...model.capabilities,
      reasoning: config.reasoning,
    },
  }
}

function withDiscoveredModelMetadata<T extends ModelWithDiscoveryMetadata>(model: T, info: KimiModelInfo): T {
  return withDiscoveredThinking(
    withDiscoveredToolUse(
      withDiscoveredMediaInput(
        withDiscoveredContext(
          withDiscoveredDisplayName(withDiscoveredIdentifier(model, info.id), kimiSelectorDisplayName(info)),
          info.context_length,
        ),
        info.supports_image_in,
        info.supports_video_in,
      ),
      info.supports_tool_use,
    ),
    info,
  )
}

function pickCatalogTemplate<T extends Record<string, ModelWithDiscoveryMetadata>>(
  models: T,
) {
  const canonical = models[MODEL_ID]
  if (canonical) return canonical
  return Object.values(models)[0]
}

function applyCatalogToModels<T extends Record<string, ModelWithDiscoveryMetadata>>(
  models: T,
  catalog: readonly KimiModelInfo[],
): T {
  const template = pickCatalogTemplate(models)
  if (!template) return models

  const next = { ...models }
  for (const id of Object.keys(next)) delete next[id]
  for (const info of catalog) {
    // S3: safe-key check at the runtime model-map keying site.
    if (!isSafeModelId(info.id)) continue
    Object.assign(next, {
      [info.id]: withDiscoveredModelMetadata(models[info.id] ?? template, info),
    })
  }
  return next
}

function buildConfigModel(info: KimiModelInfo): KimiConfigModel {
  const config = thinkingConfig(info)
  const modelConfig: KimiConfigModel = {
    name: kimiSelectorDisplayName(info),
    reasoning: config.reasoning,
    ...(info.supports_tool_use === undefined ? {} : { tool_call: info.supports_tool_use }),
    options: config.options,
    variants: withDisabledHostReasoningVariants(config.variants),
  }
  if (isPositiveFiniteNumber(info.context_length)) {
    modelConfig.limit = { context: info.context_length, output: 0 }
  }
  if (info.supports_image_in || info.supports_video_in) {
    // opencode's provider transform gates image parts on model metadata
    // before the request reaches our loader. Mirror Kimi's discovered
    // capability here so pasted images survive into the upstream SDK.
    modelConfig.attachment = true
    const inputModalities: Array<"text" | "image" | "video"> = ["text"]
    if (info.supports_image_in) inputModalities.push("image")
    if (info.supports_video_in) inputModalities.push("video")
    modelConfig.modalities = {
      input: inputModalities,
      output: ["text"],
    }
  }

  return modelConfig
}

function buildConfigModels(catalog: readonly KimiModelInfo[]) {
  const models: Record<string, KimiConfigModel> = {}
  for (const info of catalog) {
    // S3: safe-key check at the config-block keying site.
    if (!isSafeModelId(info.id)) continue
    models[info.id] = buildConfigModel(info)
  }
  return models
}

function buildConfigBlock(catalog: readonly KimiModelInfo[]) {
  const models = buildConfigModels(catalog)
  return JSON.stringify(
    {
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Kimi For Coding (OAuth)",
          options: { baseURL: API_BASE_URL },
          models,
        },
      },
    },
    null,
    2,
  )
}

const plugin: Plugin = async ({ client }) => {
  // --- helpers ---------------------------------------------------------------

  let cachedCatalog: KimiModelInfo[] | undefined
  const catalogByID = new Map<string, KimiModelInfo>()
  const currentCatalogModelIDs = new Set<string>([MODEL_ID])
  let refreshPromise: Promise<OAuthAuth> | undefined

  // S4: a monotonically incremented integer dispatch sequence replaces any
  // Date.now()-based accept logic (Oracle #16 — Date.now can collide within the
  // same ms). A result is accepted only if its dispatch-sequence >=
  // lastAcceptedSequence; lastAcceptedSequence advances only after a successful
  // nonempty response. A newer failed/empty request therefore cannot prevent an
  // older successful nonempty response from warming a cold catalog, and a newer
  // nonempty response always wins over an older one regardless of resolution
  // order.
  let dispatchSequence = 0
  let lastAcceptedSequence = 0

  const syncProcessAuthContent = (auth: OAuthAuth) => {
    if (!process.env.OPENCODE_AUTH_CONTENT) return
    try {
      const parsed = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
      delete parsed[`${PROVIDER_ID}/`]
      parsed[PROVIDER_ID] = auth
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(parsed)
    } catch {}
  }

  const persistAuth = async (auth: OAuthAuth) => {
    await client.auth.set({ path: { id: PROVIDER_ID }, body: auth })
    syncProcessAuthContent(auth)
  }

  const rememberCatalog = (models: KimiModelInfo[], seq: number) => {
    if (models.length === 0) return cachedCatalog
    // S4: reject a result whose dispatch is older than the last accepted one.
    if (seq < lastAcceptedSequence) return cachedCatalog
    // Atomically replace every catalog structure.
    cachedCatalog = [...models]
    catalogByID.clear()
    currentCatalogModelIDs.clear()
    for (const model of cachedCatalog) {
      catalogByID.set(model.id, model)
      currentCatalogModelIDs.add(model.id)
    }
    lastAcceptedSequence = seq
    return cachedCatalog
  }

  const discoverCatalog = async (access: string) => {
    const seq = ++dispatchSequence
    const models = await listModels(access)
    return rememberCatalog(models, seq)
  }

  const projectCatalogToModels = <T extends Record<string, ModelWithDiscoveryMetadata>>(models: T) =>
    cachedCatalog ? applyCatalogToModels(models, cachedCatalog) : models

  const resolveCurrentKimiBodyFields = (input: KimiHookInput): KimiBodyFields | undefined => {
    if (input.model.providerID !== PROVIDER_ID) return undefined
    if (!currentCatalogModelIDs.has(input.model.id)) return undefined
    return resolveKimiBodyFields({
      modelID: input.model.id,
      modelOptions: asRecord(input.model.options),
      variantOptions: input.message.model.variant
        ? asRecord(input.model.variants?.[input.message.model.variant])
        : undefined,
      info: catalogByID.get(input.model.id),
      promptCacheKey: input.sessionID,
    })
  }

  const readLiveAuth = async () => {
    const auth = await readAuth()
    if (auth) syncProcessAuthContent(auth)
    return auth
  }

  const readCurrentAuth = async (readAuth?: () => Promise<unknown>) => {
    const live = await readLiveAuth()
    if (live) return live
    if (!readAuth) return
    const current = await readAuth()
    if (!isOAuthAuth(current)) return
    syncProcessAuthContent(current)
    return current
  }

  const refreshAuth = async (auth: OAuthAuth, force = false) => {
    // opencode can ask both `provider.models` and `loader.fetch` to refresh
    // around the same time, including from separate workspace processes that
    // only inherited a stale `OPENCODE_AUTH_CONTENT` snapshot. Serialize
    // refreshes through a lock and re-read opencode's live auth store before
    // spending the refresh token.
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        const lockDir = await resolveRefreshLockDir()
        return await refreshAuthWithLock(auth, {
          force,
          readLatestAuth: async () => (await readLiveAuth()) ?? null,
          persistAuth,
          lockDir,
          hostReloginHint: RELOGIN_HINT,
        })
      } finally {
        refreshPromise = undefined
      }
    })()
    return refreshPromise
  }

  // --- return hooks ----------------------------------------------------------

  return {
    config: async (cfg) => {
      const provider = cfg.provider?.[PROVIDER_ID]
      if (!provider) return

      try {
        const current = await readLiveAuth()
        if (!current) return
        const auth = isAuthExpiring(current) ? await refreshAuth(current) : current
        const catalog = await discoverCatalog(auth.access)
        if (!catalog || catalog.length === 0) return
        provider.models = buildConfigModels(catalog)
      } catch {
        // Eager startup discovery is optional; retain the configured cold fallback.
        return undefined
      }
    },
    provider: {
      id: PROVIDER_ID,
      models: async (provider, ctx) => {
        if (!isOAuthAuth(ctx.auth)) return provider.models

        const discover = async (auth: OAuthAuth) => {
          await discoverCatalog(auth.access)
          return projectCatalogToModels(provider.models)
        }

        const current = (await readCurrentAuth()) ?? ctx.auth
        let auth = current
        try {
          if (isAuthExpiring(auth)) auth = await refreshAuth(auth)
          return await discover(auth)
        } catch (error) {
          const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined
          if (auth !== current || status !== 401) return projectCatalogToModels(provider.models)
        }

        try {
          return await discover(await refreshAuth(current, true))
        } catch {
          return projectCatalogToModels(provider.models)
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,

      /**
       * Called every time opencode creates an `@ai-sdk/openai-compatible`
       * instance for this provider. We inject a `fetch` that owns all auth
       * and header concerns so no other hook has to worry about them.
       *
       * `readAuth` comes from opencode: it returns the currently persisted
       * credentials for this provider id. opencode workspace processes may
       * hydrate that from a stale `OPENCODE_AUTH_CONTENT` snapshot, so the
       * loader prefers the live auth.json entry on disk and only falls back to
       * `readAuth` when the file is absent. Writes still go through
       * `client.auth.set`.
       */
      loader: async (readAuth) => {
        const ensureDiscovered = async (auth: OAuthAuth) => {
          if (cachedCatalog) return auth
          try {
            await discoverCatalog(auth.access)
          } catch {
            return auth
          }
          return auth
        }

        const ensureFresh = async (force = false): Promise<OAuthAuth> => {
          const current = await readCurrentAuth(readAuth)
          if (!current)
            throw new Error(
              `${PROVIDER_ID}: not logged in — run \`opencode auth login ${PROVIDER_ID}\``,
            )
          if (!force && !isAuthExpiring(current)) return ensureDiscovered(current)
          const next = await refreshAuth(current, force)
          // kimi-cli re-runs `refresh_managed_models` on every successful
          // refresh — we mirror that so entitlement or display-name changes
          // are picked up without a full re-login. Failures here must not
          // block the refresh: a warm in-memory discovery still works for the
          // common case, and the request-path 401 retry will flush a broken
          // access token.
          try {
            await discoverCatalog(next.access)
          } catch {
            return next
          }
          return next
        }

        // B1: on a 401, the forced refresh must receive the EXACT auth object
        // the failing doRequest() used (the REJECTED credential A), NOT a
        // reread of the live store. If we reread and another instance already
        // rotated A→B, we'd see no diff against B and force-rotate B→C,
        // wasting an OAuth exchange. By passing A to refreshAuth, core's
        // Oracle #9 + B2 fix detects B is newer (and not expiring) and
        // returns B WITHOUT rotating.
        const forcedRefreshAndDiscover = async (rejectedAuth: OAuthAuth): Promise<OAuthAuth> => {
          const next = await refreshAuth(rejectedAuth, true)
          try {
            await discoverCatalog(next.access)
          } catch {
            return next
          }
          return next
        }

        return {
          // We own the Authorization header entirely, but opencode still
          // requires a truthy apiKey to wire things up; use a sentinel.
          apiKey: PROVIDER_ID,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const doRequest = async (auth: OAuthAuth) => {
              const headers = new Headers(input instanceof Request ? input.headers : undefined)
              new Headers(init?.headers).forEach((value, key) => {
                headers.set(key, value)
              })
              // opencode currently namespaces providerOptions for
              // @ai-sdk/openai-compatible under the provider id, while the SDK
              // reads them back under the human provider name. Carry Kimi-only
              // body fields through private headers instead so the wire request
              // stays correct regardless of that upstream mismatch.
              const kimiBodyFields = consumeInternalKimiBodyFields(headers)
              // Strip anything the upstream SDK put on. Our values win.
              headers.delete("authorization")
              headers.delete("Authorization")
              for (const [k, v] of Object.entries(kimiHeaders())) headers.set(k, v)
              headers.set("Authorization", `Bearer ${auth.access}`)

              let newInit = init
              const originalBody =
                typeof init?.body === "string"
                  ? init.body
                  : input instanceof Request && init?.body === undefined
                    ? await input
                        .clone()
                        .text()
                        .catch(() => undefined)
                    : undefined
              if (hasKimiBodyFields(kimiBodyFields) && originalBody) {
                try {
                  const parsed: unknown = JSON.parse(originalBody)
                  if (isRecord(parsed)) {
                    applyKimiBodyFields(parsed, kimiBodyFields)
                    newInit = { ...init, body: JSON.stringify(parsed) }
                  }
                } catch {
                  newInit = init
                }
              }

              return fetch(input, { ...newInit, headers })
            }

            let auth = await ensureFresh()
            let res = await doRequest(auth)
            if (res.status === 401) {
              // Token might have been invalidated server-side before its
              // nominal expiry. Force a refresh and retry exactly once.
              // B1: pass the REJECTED auth (not a reread) so core's
              // concurrent-rotation detection works.
              auth = await forcedRefreshAndDiscover(auth)
              res = await doRequest(auth)
            }
            return res
          },
        }
      },

      methods: [
        {
          type: "oauth",
          label: "Kimi Code (device flow)",
          authorize: async () => {
            const device = await startDeviceAuth()
            const url = device.verification_uri_complete ?? device.verification_uri
            return {
              url,
              instructions: `Open the URL above and approve code ${device.user_code}. This window will continue automatically.`,
              method: "auto",
              callback: async () => {
                try {
                  const tokens = await pollDeviceToken(device)
                  const success = {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + tokens.expires_in * 1000,
                  }
                  try {
                    // M2/S4: allocate the dispatch sequence BEFORE the network
                    // call, then commit only on a successful nonempty response.
                    // This matches discoverCatalog and prevents a late-arriving
                    // login discovery from being accepted over a faster
                    // concurrent one.
                    const seq = ++dispatchSequence
                    const catalog = await listModels(tokens.access_token)
                    if (catalog.length > 0) {
                      rememberCatalog(catalog, seq)
                      const block = buildConfigBlock(catalog)
                      const summary = catalog
                        .map((model) => `${model.id}${model.context_length ? `, context ${model.context_length}` : ""}`)
                        .join("; ")
                      console.log(
                        `\n✓ Authorized for Kimi For Coding (models: ${summary})\n\nAdd this to your opencode config (~/.config/opencode/opencode.json) if you haven't already:\n\n${block}\n`,
                      )
                    }
                  } catch {
                    return success
                  }
                  return success
                } catch {
                  return { type: "failed" }
                }
              },
            }
          },
        },
      ],
    },

    "chat.headers": async (input, output) => {
      const fields = resolveCurrentKimiBodyFields(input as KimiHookInput)
      if (!fields) return
      if (fields.prompt_cache_key) {
        output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER] = fields.prompt_cache_key
      }
      if (fields.reasoning_effort) {
        output.headers[INTERNAL_REASONING_EFFORT_HEADER] = fields.reasoning_effort
      }
      if (fields.thinking) {
        output.headers[INTERNAL_THINKING_TYPE_HEADER] = fields.thinking.type
      }
    },

    /**
     * Mirror Kimi-specific body fields into providerOptions when possible.
     *
     * The real load-bearing path is `chat.headers` → `loader.fetch`, because
     * current opencode/openai-compatible builds disagree on the providerOptions
     * namespace. We still normalize `output.options` so the plugin keeps
     * working if upstream aligns those keys later.
     */
    "chat.params": async (input, output) => {
      const fields = resolveCurrentKimiBodyFields(input as KimiHookInput)
      if (!fields) return
      applyKimiBodyFields(output.options, fields)
    },
  }
}

// v1 PluginModule format — bypasses getLegacyPlugins entirely.
// For npm-sourced plugins, id is optional (falls back to package.json name),
// but we set it explicitly for clarity.
export default {
  id: PROVIDER_ID,
  server: plugin,
} satisfies PluginModule
