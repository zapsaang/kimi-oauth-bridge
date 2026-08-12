// OpenClaw adapter: the ProviderPlugin object.
//
// Wires the host-neutral core (OAuth refresh, thinking/body-fields, header
// fingerprint) into OpenClaw's provider-plugin hooks. Every shared concern is
// reused from `src/core/*`; this module only owns the OpenClaw-specific hook
// shapes (`refreshOAuth`, `wrapStreamFn`, `prepareExtraParams`,
// `resolveDynamicModel`, `catalog`).
//
// OpenClaw refresh & 401 (Oracle CRITICAL #3): `refreshOAuth` is the SINGLE
// refresh path — OpenClaw calls it on token expiry (and, host-permitting, on a
// 401). We do NOT implement a refresh-and-retry inside `wrapStreamFn`; exact
// same-request 401-retry is host-dependent and unverified, so we rely on the
// host here and document the gap in AGENTS.md.

import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-runtime"
import type {
  ProviderPrepareExtraParamsContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/core"
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth"
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/config-types"

import { API_BASE_URL, MODEL_ID, PROVIDER_ID } from "../../core/constants.ts"
import { kimiHeaders } from "../../core/headers.ts"
import { refreshToken } from "../../core/oauth.ts"
import type { KimiModelInfo } from "../../core/oauth.ts"
import { resolveKimiBodyFields } from "../../core/body-fields.ts"
import { supportsThinking } from "../../core/thinking.ts"
import {
  buildColdKimiModel,
  buildKimiProvider,
  catalogScopeKey,
  discoverKimiCatalog,
  getDiscoveredKimiModel,
  projectKimiModel,
  scopeHasWarmCatalog,
} from "./catalog.ts"
import { createKimiDeviceCodeAuthMethod } from "./device-code.ts"

type KimiStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>
type KimiStreamModel = Parameters<KimiStreamFn>[0]
type KimiStreamContext = Parameters<KimiStreamFn>[1]
type KimiStreamOptions = NonNullable<Parameters<KimiStreamFn>[2]>
type KimiThinkingLevel = NonNullable<ProviderPrepareExtraParamsContext["thinkingLevel"]>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// --- refreshOAuth (Oracle CRITICAL #1) ---------------------------------------

export async function refreshKimiOAuth(cred: OAuthCredential): Promise<OAuthCredential> {
  const tokens = await refreshToken(cred.refresh)
  return {
    ...cred,
    type: "oauth",
    provider: PROVIDER_ID,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + tokens.expires_in * 1000,
  }
}

// --- prepareExtraParams ------------------------------------------------------

export function resolveKimiOpenClawExtraParams(input: {
  modelId: string
  thinkingLevel?: KimiThinkingLevel
  info?: KimiModelInfo
  warm?: boolean
}): { reasoning_effort?: string; thinking?: { type: "enabled" | "disabled" } } {
  const { info, thinkingLevel } = input
  // B6: the MODEL_ID cold fallback is allowed ONLY while the scope is
  // genuinely cold (never had a successful nonempty discovery). Once warm,
  // only catalog ids resolve; MODEL_ID no longer synthesizes.
  const allowColdFallback = input.modelId === MODEL_ID && !input.warm

  if (info) {
    if (!supportsThinking(info)) return {}
    const variantOptions: Record<string, unknown> = {}
    if (thinkingLevel === "off") variantOptions.thinking = { type: "disabled" }
    else if (thinkingLevel) variantOptions.reasoning_effort = thinkingLevel
    const fields = resolveKimiBodyFields({ info, variantOptions })
    return {
      ...(fields.reasoning_effort ? { reasoning_effort: fields.reasoning_effort } : {}),
      ...(fields.thinking ? { thinking: fields.thinking } : {}),
    }
  }

  // Cold fallback (kimi-for-coding is an always-thinking K2.7 entry).
  if (allowColdFallback) {
    return { thinking: { type: "enabled" } }
  }

  return {}
}

// --- B5: case-insensitive header stripping ----------------------------------

// The 7 X-Msh-* fingerprint header names + Authorization, lowercased, so we
// can strip caller-supplied variants regardless of case. OpenClaw's openai
// transport normalizes header names, so a mixed-case caller header would
// otherwise survive and merge with the canonical set (comma-separated invalid
// header → 403).
const KIMI_OWNED_HEADER_NAMES_LOWER = new Set([
  "authorization",
  "user-agent",
  "x-msh-platform",
  "x-msh-version",
  "x-msh-device-name",
  "x-msh-device-model",
  "x-msh-device-id",
  "x-msh-os-version",
])

// --- wrapStreamFn ------------------------------------------------------------

export function kimiWrapStreamFn(ctx: ProviderWrapStreamFnContext): KimiStreamFn | null {
  const inner = ctx.streamFn
  if (!inner) return null
  const fingerprint = kimiHeaders()
  // B3: capture the scope at wrapper-build time so the sync catalog lookup
  // consults the same scope the catalog run committed to.
  const scopeRef = { agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir }

  return (model: KimiStreamModel, context: KimiStreamContext, options?: KimiStreamOptions) => {
    const headers: Record<string, string> = {}
    // B5: copy caller headers EXCEPT the ones we own (case-insensitive). This
    // guarantees exactly one canonical Authorization + exactly one of each
    // X-Msh-* header regardless of caller case.
    if (options?.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        if (!KIMI_OWNED_HEADER_NAMES_LOWER.has(name.toLowerCase())) {
          headers[name] = value
        }
      }
    }
    for (const [name, value] of Object.entries(fingerprint)) headers[name] = value

    const info = getDiscoveredKimiModel(model.id, scopeRef)
    const extra = resolveKimiOpenClawExtraParams({
      modelId: model.id,
      thinkingLevel: ctx.thinkingLevel,
      info,
      warm: scopeHasWarmCatalog(scopeRef),
    })
    const priorOnPayload = options?.onPayload

    const needsPayloadPatch = Boolean(extra.thinking)
    if (!needsPayloadPatch) {
      return inner(model, context, { ...options, headers })
    }

    const onPayload = async (payload: unknown, payloadModel: KimiStreamModel) => {
      const base = priorOnPayload ? await priorOnPayload(payload, payloadModel) : payload
      const record = isRecord(base) ? base : isRecord(payload) ? payload : undefined
      if (record && extra.thinking) record.thinking = extra.thinking
      return base
    }

    return inner(model, context, { ...options, headers, onPayload })
  }
}

// --- resolveDynamicModel (Oracle #13 + B6 + B7) -----------------------------

// B7: project ONLY the modalities the host transport supports. The runtime
// Model.input type is Array<"text" | "image">. We build the array explicitly
// instead of casting, so "video"/"audio" are never present in the runtime
// value even if the ModelDefinitionConfig.input carried them.
function toRuntimeModel(def: ModelDefinitionConfig): ProviderRuntimeModel {
  const input: Array<"text" | "image"> = []
  for (const m of def.input) {
    if (m === "text" || m === "image") input.push(m)
  }
  if (input.length === 0) input.push("text")
  return {
    id: def.id,
    name: def.name,
    api: def.api ?? "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: API_BASE_URL,
    reasoning: def.reasoning,
    input,
    cost: { ...def.cost },
    contextWindow: def.contextWindow,
    maxTokens: def.maxTokens,
    authHeader: true,
    ...(def.compat ? { compat: def.compat } : {}),
    ...(def.thinkingLevelMap ? { thinkingLevelMap: def.thinkingLevelMap } : {}),
  }
}

/**
 * Oracle #13 + B6: return a runtime model ONLY for the current successfully
 * discovered catalog entry matching `ctx.modelId`, OR the explicit cold
 * `MODEL_ID` fallback — but ONLY while the scope is genuinely cold. Once a
 * scope has a successful nonempty warm catalog that does NOT include
 * `kimi-for-coding`, that stale id is no longer synthesizable. NEVER
 * synthesize arbitrary user-supplied ids.
 */
export function kimiResolveDynamicModel(ctx: ProviderResolveDynamicModelContext): ProviderRuntimeModel | null {
  if (ctx.provider !== PROVIDER_ID) return null
  const id = ctx.modelId
  const scopeRef = { agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir }
  const warm = scopeHasWarmCatalog(scopeRef)

  // B6: cold fallback ONLY while genuinely cold.
  if (id === MODEL_ID && !warm) return toRuntimeModel(buildColdKimiModel())

  const info = getDiscoveredKimiModel(id, scopeRef)
  if (!info) return null
  const def = projectKimiModel(info)
  if (!def) return null
  return toRuntimeModel(def)
}

// --- prepareExtraParams hook -------------------------------------------------

function kimiPrepareExtraParams(ctx: ProviderPrepareExtraParamsContext): Record<string, unknown> | null {
  if (ctx.provider !== PROVIDER_ID) return null
  const scopeRef = { agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir }
  const info = getDiscoveredKimiModel(ctx.modelId, scopeRef)
  const extra = resolveKimiOpenClawExtraParams({
    modelId: ctx.modelId,
    thinkingLevel: ctx.thinkingLevel,
    info,
    warm: scopeHasWarmCatalog(scopeRef),
  })
  if (Object.keys(extra).length === 0) return null
  return extra
}

// --- the ProviderPlugin ------------------------------------------------------

export const kimiProvider: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "Kimi Code (OAuth)",
  auth: [createKimiDeviceCodeAuthMethod()],
  catalog: {
    order: "simple",
    run: async (ctx) => discoverKimiCatalog(ctx),
  },
  refreshOAuth: async (cred: OAuthCredential) => refreshKimiOAuth(cred),
  wrapStreamFn: kimiWrapStreamFn,
  prepareExtraParams: kimiPrepareExtraParams,
  resolveDynamicModel: kimiResolveDynamicModel,
}

// Re-export buildKimiProvider/projectKimiModel so the manifest/tests can reach
// the pure projection without importing catalog internals directly.
export { buildKimiProvider, projectKimiModel, discoverKimiCatalog, catalogScopeKey }
