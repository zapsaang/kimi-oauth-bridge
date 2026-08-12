/// <reference path="./bun-test.d.ts" />

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, expect, afterEach } from "bun:test"
import pluginModule from "../src/index.ts"

const plugin = pluginModule.server
import { MODEL_ID, PROVIDER_ID, REFRESH_SAFETY_WINDOW_MS } from "../src/core/constants.ts"
import { installFetchMock } from "./_util/fetchMock.ts"

// kimiHeaders() → getDeviceId() reads/writes ~/.kimi/device_id; that file is
// shared with kimi-cli by design and writes are idempotent — no HOME
// redirect needed.

const TEST_XDG_DATA_HOME = path.join(os.tmpdir(), `kimi-oauth-bridge-test-${process.pid}`)
process.env.XDG_DATA_HOME = TEST_XDG_DATA_HOME
delete process.env.OPENCODE_AUTH_CONTENT

let mock: ReturnType<typeof installFetchMock> | undefined
afterEach(async () => {
  mock?.restore()
  mock = undefined
  process.env.XDG_DATA_HOME = TEST_XDG_DATA_HOME
  delete process.env.OPENCODE_AUTH_CONTENT
  await fs.rm(TEST_XDG_DATA_HOME, { recursive: true, force: true })
})

async function withTempAuthStore<T>(entry: unknown, run: (root: string) => Promise<T>) {
  const prev = process.env.XDG_DATA_HOME
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-"))
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, entry)
  try {
    return await run(root)
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = prev
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}

function authStorePath(root: string) {
  return path.join(root, "opencode", "auth.json")
}

async function writeAuthStore(root: string, entry: unknown) {
  await fs.mkdir(path.dirname(authStorePath(root)), { recursive: true })
  await fs.writeFile(authStorePath(root), JSON.stringify({ [PROVIDER_ID]: entry }), "utf8")
}

// Fake opencode plugin context. Only `client.auth.set` is used by the
// plugin's writes; reads go through the `readAuth` callback passed to
// `loader`, not through client.
function makeContext() {
  const writes: Array<{ id: string; body: unknown }> = []
  return {
    writes,
    ctx: {
      client: {
        auth: {
          set: async ({ path, body }: { path: { id: string }; body: unknown }) => {
            writes.push({ id: path.id, body })
          },
        },
      },
    } as unknown as Parameters<typeof plugin>[0],
  }
}

async function getHooks() {
  const { ctx, writes } = makeContext()
  const hooks = await plugin(ctx)
  return { hooks, writes }
}

test("plugin registers auth under PROVIDER_ID", async () => {
  const { hooks } = await getHooks()
  expect(hooks.auth?.provider).toBe(PROVIDER_ID)
  expect(hooks.auth?.methods?.[0]?.label).toBe("Kimi Code (device flow)")
})

// ---------- chat hooks ------------------------------------------------------

const INTERNAL_PROMPT_CACHE_KEY_HEADER = "x-opencode-kimi-prompt-cache-key"
const INTERNAL_REASONING_EFFORT_HEADER = "x-opencode-kimi-reasoning-effort"
const INTERNAL_THINKING_TYPE_HEADER = "x-opencode-kimi-thinking-type"

type Hooks = Awaited<ReturnType<typeof plugin>>
type ChatParamsHook = NonNullable<Hooks["chat.params"]>
type ChatHeadersHook = NonNullable<Hooks["chat.headers"]>
type ConfigHook = NonNullable<Hooks["config"]>
type ConfigInput = Parameters<ConfigHook>[0]
type ProjectedConfigModel = {
  name?: string
  tool_call?: boolean
  variants?: Record<string, Record<string, unknown>>
  limit?: {
    context: number
    output: number
  }
}
type ParamsOutput = Parameters<ChatParamsHook>[1]
type HeadersOutput = Parameters<ChatHeadersHook>[1]

type HookInputOptions = {
  providerID?: string
  modelID?: string
  sessionID?: string
  modelOptions?: Record<string, unknown>
  variants?: Record<string, Record<string, unknown>>
  variant?: string
}

function makeHookInput(options: HookInputOptions = {}) {
  const providerID = options.providerID ?? PROVIDER_ID
  return {
    agent: "test-agent",
    provider: { id: providerID },
    model: {
      providerID,
      id: options.modelID ?? MODEL_ID,
      options: options.modelOptions,
      variants: options.variants,
    },
    message: {
      model: {
        variant: options.variant,
      },
    },
    sessionID: options.sessionID ?? "sess-1",
  }
}

async function callParams(
  hook: ChatParamsHook,
  input: HookInputOptions = {},
  options: Record<string, unknown> = {},
) {
  const output: ParamsOutput = {
    temperature: 0,
    topP: 1,
    topK: 0,
    maxOutputTokens: undefined,
    options: { ...options },
  }
  await hook(makeHookInput(input) as any, output)
  return { output }
}

async function callHeaders(hook: ChatHeadersHook, input: HookInputOptions = {}) {
  const output: HeadersOutput = { headers: {} }
  await hook(makeHookInput(input) as any, output)
  return { output }
}

test("chat.params: no-op for other providers (AGENTS.md rule: gated on PROVIDER_ID)", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = await callParams(
    hook,
    { providerID: "some-other-provider", modelOptions: { reasoning_effort: "high" } },
    { reasoning_effort: "high" },
  )
  // Untouched — no prompt_cache_key, no thinking added.
  expect(output.options).toEqual({ reasoning_effort: "high" })
})

test("chat.params: no-op for unmanaged models under our provider", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = await callParams(hook, { modelID: "kimi-something-else" })
  expect(output.options.prompt_cache_key).toBeUndefined()
  expect(output.options.thinking).toBeUndefined()
})

test("chat.params: attaches prompt_cache_key = sessionID for the canonical cold fallback", async () => {
  const { hooks } = await getHooks()
  const hook = hooks["chat.params"]!
  const { output } = await callParams(hook, { sessionID: "sess-42" })
  expect(output.options.prompt_cache_key).toBe("sess-42")
})

const STALE_COLD_EFFORTS: Array<{
  in: Record<string, unknown>
}> = [
  { in: { reasoning_effort: "off" } },
  { in: { reasoning_effort: "low" } },
  { in: { reasoning_effort: "medium" } },
  { in: { reasoning_effort: "high" } },
  { in: { reasoning_effort: "xhigh" } },
  { in: { reasoning_effort: "max" } },
  { in: {} },
]

test("chat.params: cold canonical K2.7 ignores effort=auto and remains enabled", async () => {
  const { hooks } = await getHooks()
  const { output } = await callParams(
    hooks["chat.params"]!,
    { modelOptions: { reasoning_effort: "auto" } },
    { reasoning_effort: "auto" },
  )
  expect(output.options.reasoning_effort).toBeUndefined()
  expect(output.options.reasoningEffort).toBeUndefined()
  expect(output.options.thinking).toEqual({ type: "enabled" })
})
for (const row of STALE_COLD_EFFORTS) {
  test(`chat.params: cold canonical K2.7 ignores ${JSON.stringify(row.in)}`, async () => {
    const { hooks } = await getHooks()
    const { output } = await callParams(hooks["chat.params"]!, { modelOptions: row.in }, row.in)
    expect(output.options.reasoning_effort).toBeUndefined()
    expect(output.options.thinking).toEqual({ type: "enabled" })
  })
}

test("chat.params: cold canonical K2.7 ignores stale off and arbitrary effort", async () => {
  const { hooks } = await getHooks()
  const params = hooks["chat.params"]!
  const [off, arbitrary] = await Promise.all([
    callParams(
      params,
      {
        modelID: MODEL_ID,
        variants: { stale: { reasoning_effort: "off" } },
        variant: "stale",
      },
      { reasoning_effort: "off" },
    ),
    callParams(
      params,
      {
        modelID: MODEL_ID,
        variants: { stale: { reasoning_effort: "obsolete-effort" } },
        variant: "stale",
      },
      { reasoning_effort: "obsolete-effort" },
    ),
  ])

  expect([off.output.options, arbitrary.output.options]).toEqual([
    { prompt_cache_key: "sess-1", thinking: { type: "enabled" } },
    { prompt_cache_key: "sess-1", thinking: { type: "enabled" } },
  ])
})

test("chat.params: cold canonical K2.7 ignores camelCase stale effort", async () => {
  const { hooks } = await getHooks()
  const { output } = await callParams(
    hooks["chat.params"]!,
    { modelOptions: { reasoningEffort: "off" } },
    { reasoningEffort: "off" },
  )
  expect(output.options.thinking).toEqual({ type: "enabled" })
  expect(output.options.reasoning_effort).toBeUndefined()
  expect(output.options.reasoningEffort).toBeUndefined()
})

test("chat.headers: default request enables thinking and carries prompt_cache_key", async () => {
  const { hooks } = await getHooks()
  const { output } = await callHeaders(hooks["chat.headers"]!)
  expect(output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBe("sess-1")
  expect(output.headers[INTERNAL_THINKING_TYPE_HEADER]).toBe("enabled")
  expect(output.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
})

test("chat.headers: cold canonical K2.7 ignores selected stale effort variants", async () => {
  const { hooks } = await getHooks()
  const { output } = await callHeaders(hooks["chat.headers"]!, {
    modelOptions: { reasoning_effort: "high" },
    variants: {
      auto: { reasoning_effort: "auto" },
      off: { reasoning_effort: "off" },
      low: { reasoning_effort: "low" },
    },
    variant: "off",
  })
  expect(output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBe("sess-1")
  expect(output.headers[INTERNAL_THINKING_TYPE_HEADER]).toBe("enabled")
  expect(output.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
})

test("chat.headers: cold canonical K2.7 ignores effort=auto and stays enabled", async () => {
  const { hooks } = await getHooks()
  const { output } = await callHeaders(hooks["chat.headers"]!, {
    variants: { auto: { reasoning_effort: "auto" } },
    variant: "auto",
  })
  expect(output.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBe("sess-1")
  expect(output.headers[INTERNAL_THINKING_TYPE_HEADER]).toBe("enabled")
  expect(output.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
})

// ---------- auth.loader -----------------------------------------------------

function jwt() {
  return "header.payload.sig"
}
function validAuth(overrides: Partial<{ access: string; refresh: string; expires: number }> = {}) {
  return {
    type: "oauth" as const,
    access: overrides.access ?? "access-1",
    refresh: overrides.refresh ?? "refresh-1",
    // Far enough in the future to skip the refresh-on-expiry path.
    expires: overrides.expires ?? Date.now() + 10 * 60_000,
  }
}

async function getLoaderFetch(readAuth: () => Promise<unknown>) {
  const { hooks, writes } = await getHooks()
  const res = await hooks.auth!.loader!(readAuth as any, {} as any)
  return { fetch: (res as { fetch: typeof fetch }).fetch, apiKey: (res as { apiKey: string }).apiKey, writes }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeProviderState(context = 0) {
  return {
    id: PROVIDER_ID,
    name: "Kimi For Coding (OAuth)",
    source: "custom" as const,
    env: [],
    options: {},
    models: {
      [MODEL_ID]: {
        id: MODEL_ID,
        providerID: PROVIDER_ID,
        api: {
          id: MODEL_ID,
          npm: "@ai-sdk/openai-compatible",
          url: "https://api.kimi.com/coding/v1",
        },
        status: "active" as const,
        release_date: "2026-01-01",
        headers: {},
        name: "Kimi For Coding",
        options: {},
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context, output: 8192 },
        capabilities: {
          temperature: false,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        variants: {
          off: { reasoning_effort: "off" },
          auto: { reasoning_effort: "auto" },
          low: { reasoning_effort: "low" },
          high: { reasoning_effort: "high" },
        },
      },
      "some-other-model": {
        id: "some-other-model",
        providerID: PROVIDER_ID,
        api: {
          id: "some-other-model",
          npm: "@ai-sdk/openai-compatible",
          url: "https://api.kimi.com/coding/v1",
        },
        status: "active" as const,
        release_date: "2026-01-01",
        headers: {},
        name: "Other",
        options: {},
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 1234, output: 4096 },
        capabilities: {
          temperature: false,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
      },
    },
  }
}

function currentKimiCatalog() {
  return [
    {
      id: "k3",
      display_name: "Kimi K3",
      context_length: 1048576,
      protocol: "chat_completions",
      supports_reasoning: true,
      supports_tool_use: true,
      supports_image_in: true,
      supports_video_in: false,
      supports_thinking_type: "both" as const,
      think_efforts: {
        support: true,
        valid_efforts: ["low", "high", "max"],
        default_effort: "high",
      },
    },
    {
      id: "k3-256k",
      display_name: "Kimi K3 256K",
      context_length: 262144,
      protocol: "chat_completions",
      supports_reasoning: true,
      supports_tool_use: true,
      supports_image_in: true,
      supports_video_in: false,
      supports_thinking_type: "both" as const,
      think_efforts: {
        support: true,
        valid_efforts: ["low", "high", "max"],
        default_effort: "high",
      },
    },
    {
      id: MODEL_ID,
      display_name: "Kimi Code",
      context_length: 262144,
      supports_reasoning: true,
      supports_tool_use: true,
      supports_image_in: true,
      supports_video_in: false,
      supports_thinking_type: "only" as const,
      think_efforts: { support: false },
    },
    {
      id: "kimi-for-coding-highspeed",
      display_name: "Kimi Code Highspeed",
      context_length: 131072,
      supports_reasoning: true,
      supports_tool_use: true,
      supports_image_in: false,
      supports_video_in: false,
      supports_thinking_type: "only" as const,
      think_efforts: { support: false },
    },
  ]
}

async function discoverProviderModels(
  hooks: Hooks,
  provider: ReturnType<typeof makeProviderState>,
  auth = validAuth(),
) {
  return hooks.provider!.models!(provider, { auth })
}

function makeConfigState(): ConfigInput {
  return {
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Kimi For Coding (OAuth)",
        options: { baseURL: "https://api.kimi.com/coding/v1" },
        models: {
          [MODEL_ID]: {
            name: "Configured cold fallback",
            options: { configured: true },
          },
        },
      },
      "unrelated-provider": {
        npm: "unrelated-sdk",
        models: {
          "unrelated-model": {
            name: "Unrelated model",
          },
        },
      },
    },
  }
}

function projectedConfigModels(config: ConfigInput): Record<string, ProjectedConfigModel> {
  const models = config.provider?.[PROVIDER_ID]?.models
  if (!models) throw new Error("expected Kimi config provider models")
  return models as Record<string, ProjectedConfigModel>
}

// ---------- provider.models -------------------------------------------------

test("OpenCode config-only provider must receive the authenticated catalog even though provider.models is skipped", async () => {
  await withTempAuthStore(validAuth(), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models")) return { body: { data: currentKimiCatalog() } }
      return { body: { ok: true } }
    })
    const { hooks } = await getHooks()
    const config = makeConfigState()
    const unrelatedBefore = structuredClone(config.provider!["unrelated-provider"])

    await hooks.config!(config)

    expect(Object.keys(config.provider![PROVIDER_ID]!.models ?? {}).sort()).toEqual(
      ["k3", "k3-256k", MODEL_ID, "kimi-for-coding-highspeed"].sort(),
    )
    expect(config.provider![PROVIDER_ID]!.models?.["some-other-model"]).toBeUndefined()
    expect(config.provider!["unrelated-provider"]).toEqual(unrelatedBefore)
    expect(mock.calls.map((call) => call.url)).toEqual(["https://api.kimi.com/coding/v1/models"])
  })
})

test("config: projects exact entitled keys, selector labels, and variants without mutating other providers", async () => {
  await withTempAuthStore(validAuth(), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models")) return { body: { data: currentKimiCatalog() } }
      return { body: { ok: true } }
    })
    const { hooks } = await getHooks()
    const config = makeConfigState()
    const before = structuredClone(config)

    await hooks.config!(config)

    const models = projectedConfigModels(config)
    expect(Object.keys(models).sort()).toEqual([MODEL_ID, "kimi-for-coding-highspeed", "k3", "k3-256k"].sort())
    expect(Object.fromEntries(Object.entries(models).map(([id, model]) => [id, model.name]))).toEqual({
      [MODEL_ID]: "K2.7",
      "kimi-for-coding-highspeed": "K2.7 HighSpeed",
      k3: "K3 (1M)",
      "k3-256k": "K3 (256K)",
    })
    expect(models[MODEL_ID]?.variants).toEqual({
      on: { thinking: { type: "enabled" } },
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    })
    expect(models["kimi-for-coding-highspeed"]?.variants).toEqual({
      on: { thinking: { type: "enabled" } },
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    })
    expect(models.k3?.variants).toEqual({
      low: { reasoning_effort: "low", thinking: { type: "enabled" } },
      medium: { disabled: true },
      high: { reasoning_effort: "high", thinking: { type: "enabled" } },
      max: { reasoning_effort: "max", thinking: { type: "enabled" } },
    })
    expect(models["k3-256k"]?.variants).toEqual({
      low: { reasoning_effort: "low", thinking: { type: "enabled" } },
      medium: { disabled: true },
      high: { reasoning_effort: "high", thinking: { type: "enabled" } },
      max: { reasoning_effort: "max", thinking: { type: "enabled" } },
    })
    expect(models.k3?.limit).toEqual({ context: 1048576, output: 0 })
    expect(models["k3-256k"]?.limit).toEqual({ context: 262144, output: 0 })
    expect(models[MODEL_ID]?.limit).toEqual({ context: 262144, output: 0 })
    expect(models["kimi-for-coding-highspeed"]?.limit).toEqual({ context: 131072, output: 0 })
    expect(config.provider![PROVIDER_ID]!.name).toBe(before.provider![PROVIDER_ID]!.name)
    expect(config.provider![PROVIDER_ID]!.npm).toBe(before.provider![PROVIDER_ID]!.npm)
    expect(config.provider![PROVIDER_ID]!.options).toEqual(before.provider![PROVIDER_ID]!.options)
    expect(config.provider!["unrelated-provider"]).toEqual(before.provider!["unrelated-provider"])
  })
})

test("config: projects raw context limits and disables absent host-generated reasoning variants", async () => {
  await withTempAuthStore(validAuth(), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models")) return { body: { data: currentKimiCatalog() } }
      return { body: { ok: true } }
    })
    const { hooks } = await getHooks()
    const config = makeConfigState()

    await hooks.config!(config)

    const models = projectedConfigModels(config)
    expect(models.k3?.limit).toEqual({ context: 1048576, output: 0 })
    expect(models.k3?.variants).toEqual({
      low: { reasoning_effort: "low", thinking: { type: "enabled" } },
      medium: { disabled: true },
      high: { reasoning_effort: "high", thinking: { type: "enabled" } },
      max: { reasoning_effort: "max", thinking: { type: "enabled" } },
    })
    expect(models[MODEL_ID]?.variants).toEqual({
      on: { thinking: { type: "enabled" } },
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    })
  })
})

test("config: keeps future models metadata-driven and omits nonpositive context limits", async () => {
  const catalog = [
    {
      id: "future-kimi-medium",
      display_name: "Future Kimi Medium",
      context_length: 65536,
      supports_reasoning: true,
      supports_thinking_type: "both" as const,
      think_efforts: { support: true, valid_efforts: ["medium"], default_effort: "medium" },
    },
    {
      id: "future-kimi-zero-context",
      display_name: "Future Kimi Zero",
      context_length: 0,
      supports_reasoning: false,
      supports_thinking_type: "no" as const,
    },
    {
      id: "future-kimi-negative-context",
      display_name: "Future Kimi Negative",
      context_length: -1,
      supports_reasoning: false,
      supports_thinking_type: "no" as const,
    },
  ]
  await withTempAuthStore(validAuth(), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models")) return { body: { data: catalog } }
      return { body: { ok: true } }
    })
    const { hooks } = await getHooks()
    const config = makeConfigState()

    await hooks.config!(config)

    const models = projectedConfigModels(config)
    expect(models["future-kimi-medium"]?.name).toBe("Future Kimi Medium")
    expect(models["future-kimi-medium"]?.limit).toEqual({ context: 65536, output: 0 })
    expect(models["future-kimi-medium"]?.variants).toEqual({
      low: { disabled: true },
      medium: { reasoning_effort: "medium", thinking: { type: "enabled" } },
      high: { disabled: true },
    })
    expect(models["future-kimi-zero-context"]?.limit).toBeUndefined()
    expect(models["future-kimi-negative-context"]?.limit).toBeUndefined()
    expect(models["future-kimi-zero-context"]?.variants).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true },
    })
  })
})

test("config: projects discovered tool_call metadata, including explicit false", async () => {
  const catalog = [
    { id: "tool-call-enabled", supports_tool_use: true },
    { id: "tool-call-disabled", supports_tool_use: false },
  ]
  await withTempAuthStore(validAuth(), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models")) return { body: { data: catalog } }
      return { body: { ok: true } }
    })
    const { hooks } = await getHooks()
    const config = makeConfigState()

    await hooks.config!(config)

    const models = projectedConfigModels(config)
    expect(models["tool-call-enabled"]?.tool_call).toBe(true)
    expect(models["tool-call-disabled"]?.tool_call).toBe(false)
  })
})

test("config: preserves the configured cold fallback when live OAuth auth is absent", async () => {
  mock = installFetchMock(() => {
    throw new Error("config discovery must not run without OAuth auth")
  })
  const { hooks } = await getHooks()
  const config = makeConfigState()
  const before = structuredClone(config)

  await hooks.config!(config)

  expect(config).toEqual(before)
  expect(mock.calls).toHaveLength(0)
})

test("config: preserves the configured cold fallback when stored auth is non-OAuth", async () => {
  await withTempAuthStore({ type: "api", key: "not-oauth" }, async () => {
    mock = installFetchMock(() => {
      throw new Error("config discovery must not run for non-OAuth auth")
    })
    const { hooks } = await getHooks()
    const config = makeConfigState()
    const before = structuredClone(config)

    await hooks.config!(config)

    expect(config).toEqual(before)
    expect(mock.calls).toHaveLength(0)
  })
})

test("config: preserves the configured cold fallback when discovery is empty or fails", async () => {
  const outcomes = [
    { name: "empty", response: { body: { data: [] } } },
    { name: "failure", response: { status: 503, body: { error: "unavailable" } } },
  ]
  for (const outcome of outcomes) {
    await withTempAuthStore(validAuth(), async () => {
      mock = installFetchMock((call) => {
        if (call.url.endsWith("/coding/v1/models")) return outcome.response
        return { body: { ok: true } }
      })
      const { hooks } = await getHooks()
      const config = makeConfigState()
      const before = structuredClone(config)

      await hooks.config!(config)

      expect(config).toEqual(before)
      expect(mock.calls.map((call) => call.url)).toEqual(["https://api.kimi.com/coding/v1/models"])
    })
  }
})

test("config: leaves an absent Kimi provider unchanged without attempting discovery", async () => {
  await withTempAuthStore(validAuth(), async () => {
    mock = installFetchMock(() => {
      throw new Error("config discovery must not run without the Kimi provider")
    })
    const { hooks } = await getHooks()
    const config = makeConfigState()
    delete config.provider![PROVIDER_ID]
    const before = structuredClone(config)

    await hooks.config!(config)

    expect(config).toEqual(before)
    expect(mock.calls).toHaveLength(0)
  })
})

test("config: refreshes expired live OAuth auth before eager discovery", async () => {
  const expiring = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  await withTempAuthStore(expiring, async () => {
    mock = installFetchMock((call) => {
      if (call.url.includes("/oauth/token")) {
        return { body: { access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
      }
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: currentKimiCatalog() } }
      }
      return { body: { ok: true } }
    })
    const { hooks, writes } = await getHooks()
    const config = makeConfigState()

    await hooks.config!(config)

    expect(mock.calls.map((call) => call.url)).toEqual([
      "https://auth.kimi.com/api/oauth/token",
      "https://api.kimi.com/coding/v1/models",
    ])
    expect(mock.calls[1]?.headers.authorization).toBe("Bearer fresh")
    expect(writes).toHaveLength(1)
    expect(writes[0]?.body).toMatchObject({ access: "fresh", refresh: "refresh-2" })
    expect(Object.keys(projectedConfigModels(config)).sort()).toEqual(
      [MODEL_ID, "kimi-for-coding-highspeed", "k3", "k3-256k"].sort(),
    )
  })
})

test("config: concurrent discoveries project only the sequence-accepted newest catalog", async () => {
  const olderStarted = deferred<void>()
  const releaseOlder = deferred<void>()
  let modelCalls = 0
  await withTempAuthStore(validAuth(), async () => {
    mock = installFetchMock(async (call) => {
      if (!call.url.endsWith("/coding/v1/models")) return { body: { ok: true } }
      modelCalls++
      if (modelCalls === 1) {
        olderStarted.resolve()
        await releaseOlder.promise
        return { body: { data: [{ id: "stale-config", context_length: 1000 }] } }
      }
      return { body: { data: [{ id: "accepted-newest", context_length: 2000 }] } }
    })
    const { hooks } = await getHooks()
    const olderConfig = makeConfigState()
    const newerConfig = makeConfigState()

    const older = hooks.config!(olderConfig)
    await olderStarted.promise
    await hooks.config!(newerConfig)
    releaseOlder.resolve()
    await older

    expect([Object.keys(projectedConfigModels(olderConfig)), Object.keys(projectedConfigModels(newerConfig))]).toEqual([
      ["accepted-newest"],
      ["accepted-newest"],
    ])
  })
})

test("provider.models: adds every entitled Kimi Code id with its discovered metadata", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { body: { data: currentKimiCatalog() } }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const next = await discoverProviderModels(hooks, provider)

  expect(next.k3).toBeDefined()
  expect(next[MODEL_ID]).toBeDefined()
  expect(next["kimi-for-coding-highspeed"]).toBeDefined()
  expect(next["k3-256k"]).toBeDefined()
  expect(next.k3!.id).toBe("k3")
  expect(next.k3!.api.id).toBe("k3")
  expect(next.k3!.name).toBe("K3 (1M)")
  expect(next.k3!.limit.context).toBe(1048576)
  expect(next["k3-256k"]!.name).toBe("K3 (256K)")
  expect(next.k3!.capabilities.toolcall).toBe(true)
  expect(next.k3!.capabilities.input.image).toBe(true)
  expect(next.k3!.variants).toEqual({
    low: { reasoning_effort: "low", thinking: { type: "enabled" } },
    high: { reasoning_effort: "high", thinking: { type: "enabled" } },
    max: { reasoning_effort: "max", thinking: { type: "enabled" } },
  })
})

test("provider.models: atomically replaces the catalog without mutating configured models", async () => {
  let modelCalls = 0
  mock = installFetchMock((call) => {
    if (!call.url.endsWith("/coding/v1/models")) return { body: { ok: true } }
    modelCalls++
    if (modelCalls === 1) return { body: { data: currentKimiCatalog() } }
    return {
      body: {
        data: [
          {
            id: "kimi-code-future",
            display_name: "Future Kimi Code",
            context_length: 65536,
            supports_reasoning: false,
            supports_tool_use: false,
            supports_thinking_type: "no",
          },
        ],
      },
    }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const originalModels = structuredClone(provider.models)
  const first = await discoverProviderModels(hooks, provider)
  const second = await discoverProviderModels(hooks, provider)

  expect(provider.models).toEqual(originalModels)
  expect(first.k3).toBeDefined()
  expect(second.k3).toBeUndefined()
  expect(second[MODEL_ID]).toBeUndefined()
  expect(second["kimi-for-coding-highspeed"]).toBeUndefined()
  expect(second["kimi-code-future"]!.id).toBe("kimi-code-future")
  expect(second["kimi-code-future"]!.name).toBe("Future Kimi Code")
  expect(second["kimi-code-future"]!.variants).toEqual({})
  expect(second["some-other-model"]).toBeUndefined()
  const futureParams = await callParams(hooks["chat.params"]!, { modelID: "kimi-code-future" })
  expect(futureParams.output.options).toEqual({ prompt_cache_key: "sess-1" })
})

test("provider.models: replaces a fresh stale generated map with a disjoint authenticated catalog", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return {
        body: {
          data: [{ id: "k3", display_name: "Kimi K3", context_length: 262144, supports_reasoning: true }],
        },
      }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const stale = provider.models["some-other-model"]!
  Reflect.deleteProperty(provider.models, MODEL_ID)
  Reflect.deleteProperty(provider.models, "some-other-model")
  Object.assign(provider.models, {
    "stale-generated-model": {
      ...stale,
      id: "stale-generated-model",
      api: { ...stale.api, id: "stale-generated-model" },
      name: "Stale Generated Model",
    },
  })
  const originalModels = structuredClone(provider.models)
  const next = await discoverProviderModels(hooks, provider)

  expect(provider.models).toEqual(originalModels)
  expect(Object.keys(next)).toEqual(["k3"])
  expect(next["stale-generated-model"]).toBeUndefined()
  expect(next.k3!.id).toBe("k3")
  expect(next.k3!.limit.context).toBe(262144)
})

test("provider.models: applies K3 context over a positive canonical template context", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return {
        body: {
          data: [{ id: "k3", display_name: "Kimi K3", context_length: 262144, supports_reasoning: true }],
        },
      }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState(8192)
  const next = await discoverProviderModels(hooks, provider)

  expect(provider.models[MODEL_ID]!.limit.context).toBe(8192)
  expect(next[MODEL_ID]).toBeUndefined()
  expect(next.k3!.limit.context).toBe(262144)
})

test("provider.models: cold discovery failure preserves only configured canonical fallback", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { status: 503, body: { error: "unavailable" } }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const next = await discoverProviderModels(hooks, provider)

  expect(next).toBe(provider.models)
  expect(next[MODEL_ID]).toBeDefined()
  expect(next.k3).toBeUndefined()
  expect(next["kimi-for-coding-highspeed"]).toBeUndefined()
})

test("provider.models: keeps the warm catalog when a later discovery fails", async () => {
  let modelCalls = 0
  mock = installFetchMock((call) => {
    if (!call.url.endsWith("/coding/v1/models")) return { body: { ok: true } }
    modelCalls++
    if (modelCalls === 1) {
      return {
        body: {
          data: [
            {
              id: "future-kimi-code",
              supports_reasoning: true,
              supports_thinking_type: "only",
              think_efforts: { support: false },
            },
          ],
        },
      }
    }
    return { status: 500, body: { error: "temporary" } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const first = await discoverProviderModels(hooks, provider)
  const second = await discoverProviderModels(hooks, provider)

  expect(first["future-kimi-code"]).toBeDefined()
  expect(second["future-kimi-code"]).toBeDefined()
  expect(second[MODEL_ID]).toBeUndefined()
})

// S4 — stale-response race (Oracle #16). Catalog acceptance must key off a
// monotonically incremented dispatch integer, NOT Date.now() (which can
// collide within the same ms). Two concurrent discoveries can interleave; the
// accept rules are:
//  - a newer EMPTY/failed response must not evict an older successful one;
//  - a newer successful response must win over an older successful one;
//  - lastAcceptedSequence advances only on a successful nonempty response.
// The fetch gate below serializes dispatch ordering deterministically so the
// "newer" probe is guaranteed a higher dispatch sequence than the "older" one.
async function raceDiscovery(opts: {
  older: { id: string; context_length: number }
  newer: { id?: string; context_length?: number }
}) {
  const gate = deferred<void>()
  let modelsCall = 0
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  mock = installFetchMock(async (call) => {
    if (!call.url.endsWith("/coding/v1/models")) return { body: { ok: true } }
    modelsCall++
    if (modelsCall === 1) {
      await gate.promise
      return { body: { data: [opts.older] } }
    }
    if (opts.newer.id === undefined) return { body: { data: [] } }
    return { body: { data: [opts.newer] } }
  })

  const older = discoverProviderModels(hooks, provider)
  await new Promise((r) => setTimeout(r, 10))
  const newer = discoverProviderModels(hooks, provider)
  await new Promise((r) => setTimeout(r, 5))
  gate.resolve()
  await Promise.all([older, newer])
  return { hooks }
}

test("S4: a newer empty discovery does not evict an older successful nonempty catalog", async () => {
  const { hooks } = await raceDiscovery({
    older: { id: "race-winner", context_length: 131072 },
    newer: {},
  })
  const probe = await callParams(hooks["chat.params"]!, { modelID: "race-winner", sessionID: "sess-race" })
  expect(probe.output.options.prompt_cache_key).toBe("sess-race")
})

test("S4: a newer successful discovery wins over an older successful one", async () => {
  const { hooks } = await raceDiscovery({
    older: { id: "stale-winner", context_length: 1000 },
    newer: { id: "fresh-winner", context_length: 2000 },
  })
  const freshProbe = await callParams(hooks["chat.params"]!, { modelID: "fresh-winner", sessionID: "s1" })
  const staleProbe = await callParams(hooks["chat.params"]!, { modelID: "stale-winner", sessionID: "s2" })
  expect(freshProbe.output.options.prompt_cache_key).toBe("s1")
  expect(staleProbe.output.options.prompt_cache_key).toBeUndefined()
})

test("S4: a newer failing discovery does not evict an older successful nonempty catalog", async () => {
  const gate = deferred<void>()
  let modelsCall = 0
  mock = installFetchMock((call) => {
    if (!call.url.endsWith("/coding/v1/models")) return { body: { ok: true } }
    modelsCall++
    if (modelsCall === 1) return { body: { data: [{ id: "survivor", context_length: 8192 }] } }
    throw new Error("transient network failure")
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()

  const older = discoverProviderModels(hooks, provider)
  await new Promise((r) => setTimeout(r, 10))
  const newer = discoverProviderModels(hooks, provider)
  gate.resolve()
  await Promise.allSettled([older, newer])

  const probe = await callParams(hooks["chat.params"]!, { modelID: "survivor", sessionID: "sess-srv" })
  expect(probe.output.options.prompt_cache_key).toBe("sess-srv")
})

test("catalog thinking metadata sends K3 default, high, and exact max efforts", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { body: { data: currentKimiCatalog() } }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  await discoverProviderModels(hooks, makeProviderState())
  const params = hooks["chat.params"]!

  const defaultK3 = await callParams(params, { modelID: "k3" })
  const highK3 = await callParams(params, {
    modelID: "k3",
    variants: { high: { reasoning_effort: "high" } },
    variant: "high",
  })
  const maxK3 = await callParams(params, {
    modelID: "k3",
    variants: { max: { reasoning_effort: "max" } },
    variant: "max",
  })

  expect(defaultK3.output.options).toMatchObject({
    prompt_cache_key: "sess-1",
    reasoning_effort: "high",
    thinking: { type: "enabled" },
  })
  expect(highK3.output.options.reasoning_effort).toBe("high")
  expect(maxK3.output.options.reasoning_effort).toBe("max")
  expect(maxK3.output.options.thinking).toEqual({ type: "enabled" })
})

test("catalog always-thinking K2.7 models expose a visible on variant and neutralize stale off", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { body: { data: currentKimiCatalog() } }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const next = await discoverProviderModels(hooks, makeProviderState())
  const params = hooks["chat.params"]!

  expect(next[MODEL_ID]!.variants).toEqual({ on: { thinking: { type: "enabled" } } })
  expect(next["kimi-for-coding-highspeed"]!.variants).toEqual({ on: { thinking: { type: "enabled" } } })
  const standard = await callParams(params, {
    modelID: MODEL_ID,
    variants: { off: { reasoning_effort: "off" } },
    variant: "off",
  })
  const highspeed = await callParams(params, {
    modelID: "kimi-for-coding-highspeed",
    variants: { off: { thinking: { type: "disabled" } } },
    variant: "off",
  })

  expect(standard.output.options).toMatchObject({ prompt_cache_key: "sess-1", thinking: { type: "enabled" } })
  expect(standard.output.options.reasoning_effort).toBeUndefined()
  expect(highspeed.output.options).toMatchObject({ prompt_cache_key: "sess-1", thinking: { type: "enabled" } })
  expect(highspeed.output.options.reasoning_effort).toBeUndefined()
  const onVariant = await callParams(params, {
    modelID: MODEL_ID,
    variants: { on: { thinking: { type: "enabled" } } },
    variant: "on",
  })
  expect(onVariant.output.options).toMatchObject({ thinking: { type: "enabled" } })
})

test("provider.models: projects only discovered models and their context", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks, writes } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  expect(mock.calls[0]!.hasSignal).toBe(true)
  expect(next[MODEL_ID]!.limit?.context).toBe(262144)
  expect(next["some-other-model"]).toBeUndefined()
  expect(provider.models[MODEL_ID]!.limit?.context).toBe(0)
  expect(writes).toHaveLength(0)
})

test("provider.models: uses the known selector display label in runtime model metadata", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, display_name: "Kimi Code", context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  expect(next[MODEL_ID]!.name).toBe("K2.7")
  expect(provider.models[MODEL_ID]!.name).toBe("Kimi For Coding")
})

test("provider.models: surfaces discovered image input capability so opencode does not strip images", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return {
        body: {
          data: [{ id: MODEL_ID, display_name: "Kimi Code", context_length: 262144, supports_image_in: true }],
        },
      }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  expect(next[MODEL_ID]!.capabilities.input.image).toBe(true)
  expect(next[MODEL_ID]!.capabilities.attachment).toBe(true)
  expect(provider.models[MODEL_ID]!.capabilities.input.image).toBe(false)
})

test("provider.models: surfaces discovered video input in modalities", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return {
        body: {
          data: [{
            id: MODEL_ID,
            display_name: "Kimi Code",
            context_length: 262144,
            supports_image_in: true,
            supports_video_in: true,
          }],
        },
      }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  const model = next[MODEL_ID] as any
  expect(model.modalities?.input).toContain("video")
  expect(model.modalities?.input).toContain("image")
  expect(model.capabilities.input.image).toBe(true)
})

test("provider.models: overrides a configured context with the authoritative discovery context", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks } = await getHooks()
  const provider = makeProviderState(8192)
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth() } as any)
  expect(next[MODEL_ID]!.limit?.context).toBe(262144)
  expect(provider.models[MODEL_ID]!.limit?.context).toBe(8192)
})

test("provider.models: retries once with a refreshed token after 401", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models") && call.headers["authorization"] === "Bearer stale") {
      return { status: 401, body: { error: "unauthorized" } }
    }
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models") && call.headers["authorization"] === "Bearer fresh") {
      return { body: { data: [{ id: MODEL_ID, context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks, writes } = await getHooks()
  const provider = makeProviderState()
  const next = await hooks.provider!.models!(provider as any, { auth: validAuth({ access: "stale" }) } as any)
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://auth.kimi.com/api/oauth/token",
    "https://api.kimi.com/coding/v1/models",
  ])
  expect(mock.calls[2]!.headers["authorization"]).toBe("Bearer fresh")
  expect(next[MODEL_ID]!.limit?.context).toBe(131072)
  expect((writes[0]!.body as { access: string }).access).toBe("fresh")
})

test("provider.models: prefers the live auth store over a stale ctx.auth snapshot", async () => {
  await withTempAuthStore(validAuth({ access: "fresh", refresh: "refresh-2" }), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models") && call.headers["authorization"] === "Bearer fresh") {
        return { body: { data: [{ id: MODEL_ID, context_length: 131072 }] } }
      }
      return { status: 401, body: { error: "unauthorized" } }
    })
    const { hooks } = await getHooks()
    const provider = makeProviderState()
    const next = await hooks.provider!.models!(
      provider as any,
      { auth: validAuth({ access: "stale", refresh: "refresh-1" }) } as any,
    )
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]!.headers["authorization"]).toBe("Bearer fresh")
    expect(next[MODEL_ID]!.limit?.context).toBe(131072)
  })
})

test("auth.loader: refuses to run when no credentials are persisted", async () => {
  const { fetch: f } = await getLoaderFetch(async () => undefined)
  await expect(f("https://api.kimi.com/coding/v1/models")).rejects.toThrow(/not logged in/)
})

test("auth.loader: apiKey sentinel is returned (opencode requires truthy)", async () => {
  const { apiKey } = await getLoaderFetch(async () => validAuth())
  expect(apiKey).toBe(PROVIDER_ID)
})

test("auth.loader: prefers live auth.json over a stale readAuth snapshot", async () => {
  await withTempAuthStore(validAuth({ access: "fresh", refresh: "refresh-2" }), async () => {
    mock = installFetchMock((call) => {
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
      }
      return { body: { ok: true } }
    })
    const { fetch: f } = await getLoaderFetch(async () => validAuth({ access: "stale", refresh: "refresh-1" }))
    await f("https://api.kimi.com/coding/v1/chat")
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://api.kimi.com/coding/v1/models",
      "https://api.kimi.com/coding/v1/chat",
    ])
    expect(mock.calls[0]!.headers["authorization"]).toBe("Bearer fresh")
    expect(mock.calls[1]!.headers["authorization"]).toBe("Bearer fresh")
  })
})

test("auth.loader: owns Authorization and strips any caller-supplied value (rule 3)", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth({ access: jwt() }))
  await f("https://api.kimi.com/coding/v1/chat", {
    method: "POST",
    headers: { Authorization: "Bearer SHOULD-BE-OVERRIDDEN", authorization: "lower-also" },
    body: JSON.stringify({}),
  })
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
  ])
  const h = mock.calls[1]!.headers
  expect(h["authorization"]).toBe(`Bearer ${jwt()}`)
  // Seven kimi-cli fingerprint headers are attached on every request.
  expect(h["x-msh-platform"]).toBe("kimi_cli")
  expect(h["x-msh-version"]).toBeDefined()
  expect(h["x-msh-device-id"]).toMatch(/^[0-9a-f]{32}$/)
})

test("auth.loader: injects default thinking via private headers and strips them upstream", async () => {
  const { hooks } = await getHooks()
  const { output: headerOutput } = await callHeaders(hooks["chat.headers"]!, {
    sessionID: "sess-default",
  })
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headerOutput.headers,
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  const upstream = mock.calls[1]!
  expect(upstream.headers[INTERNAL_PROMPT_CACHE_KEY_HEADER]).toBeUndefined()
  expect(upstream.headers[INTERNAL_REASONING_EFFORT_HEADER]).toBeUndefined()
  expect(upstream.headers[INTERNAL_THINKING_TYPE_HEADER]).toBeUndefined()
  expect(JSON.parse(upstream.body as string)).toEqual({
    model: MODEL_ID,
    messages: [],
    prompt_cache_key: "sess-default",
    thinking: { type: "enabled" },
  })
})

test("auth.loader: cold canonical K2.7 strips stale reasoning_effort from the wire body", async () => {
  const { hooks } = await getHooks()
  const { output: headerOutput } = await callHeaders(hooks["chat.headers"]!, {
    sessionID: "sess-high",
    variants: { high: { reasoning_effort: "high" } },
    variant: "high",
  })
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headerOutput.headers,
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(JSON.parse(mock.calls[1]!.body as string)).toEqual({
    model: MODEL_ID,
    messages: [],
    prompt_cache_key: "sess-high",
    thinking: { type: "enabled" },
  })
})

test("auth.loader: preserves a selected catalog id and K3 max effort on the wire", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { body: { data: currentKimiCatalog() } }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [INTERNAL_PROMPT_CACHE_KEY_HEADER]: "sess-k3",
      [INTERNAL_REASONING_EFFORT_HEADER]: "max",
      [INTERNAL_THINKING_TYPE_HEADER]: "enabled",
    },
    body: JSON.stringify({ model: "k3", messages: [] }),
  })

  expect(JSON.parse(mock.calls[1]!.body as string)).toEqual({
    model: "k3",
    messages: [],
    prompt_cache_key: "sess-k3",
    reasoning_effort: "max",
    thinking: { type: "enabled" },
  })
})

test("auth.loader: cold canonical K2.7 ignores effort=auto and never synthesizes temperature", async () => {
  const { hooks } = await getHooks()
  const { output: headerOutput } = await callHeaders(hooks["chat.headers"]!, {
    sessionID: "sess-auto",
    variants: { auto: { reasoning_effort: "auto" } },
    variant: "auto",
  })
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headerOutput.headers,
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(JSON.parse(mock.calls[1]!.body as string)).toEqual({
    model: MODEL_ID,
    messages: [],
    prompt_cache_key: "sess-auto",
    thinking: { type: "enabled" },
  })
})

test("auth.loader: refreshes when expiry is within safety window", async () => {
  let reads = 0
  const initial = validAuth({ expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  let current: ReturnType<typeof validAuth> = initial
  const readAuth = async () => {
    reads++
    return current
  }
  // Expected order: token refresh → /models discovery → actual request.
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "kimi-for-coding", display_name: "Kimi Code", context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f, writes } = await getLoaderFetch(readAuth)
  await f("https://api.kimi.com/coding/v1/chat")
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://auth.kimi.com/api/oauth/token",
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
  ])
  expect(mock.calls[2]!.headers["authorization"]).toBe("Bearer access-2")
  // Persisted the refreshed token + discovered model metadata.
  expect(writes).toHaveLength(1)
  expect(writes[0]!.id).toBe(PROVIDER_ID)
  const persisted = writes[0]!.body as { access: string; model_id?: string; context_length?: number }
  expect(persisted.access).toBe("access-2")
  // opencode's SDK auth schema persists only the standard oauth fields; model
  // discovery is cached in-memory by the loader.
  expect(persisted.model_id).toBeUndefined()
  expect(persisted.context_length).toBeUndefined()
  expect(reads).toBeGreaterThan(0)
})

test("auth.loader: concurrent expiring requests share one refresh exchange", async () => {
  const gate = deferred<void>()
  mock = installFetchMock(async (call) => {
    if (call.url.includes("/oauth/token")) {
      await gate.promise
      return { body: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
    }
    return { body: { ok: true } }
  })
  const expiring = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  const { fetch: f, writes } = await getLoaderFetch(async () => expiring)
  const request = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  }

  const p1 = f("https://api.kimi.com/coding/v1/chat/completions", request)
  const p2 = f("https://api.kimi.com/coding/v1/chat/completions", request)
  await new Promise((r) => setTimeout(r, 0))
  gate.resolve()
  await Promise.all([p1, p2])

  expect(mock.calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1)
  expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/chat/completions"))).toHaveLength(2)
  expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/chat/completions")).map((c) => c.headers["authorization"])).toEqual([
    "Bearer access-2",
    "Bearer access-2",
  ])
  expect(writes).toHaveLength(1)
})

test("provider.models and auth.loader share one in-flight refresh exchange", async () => {
  const gate = deferred<void>()
  mock = installFetchMock(async (call) => {
    if (call.url.includes("/oauth/token")) {
      await gate.promise
      return { body: { access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: MODEL_ID, context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { hooks, writes } = await getHooks()
  const expiring = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  const provider = makeProviderState()
  const loader = (await hooks.auth!.loader!(async () => expiring, {} as any)) as { fetch: typeof fetch }

  const modelsPromise = hooks.provider!.models!(provider as any, { auth: expiring } as any)
  const fetchPromise = loader.fetch("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  await new Promise((r) => setTimeout(r, 0))
  gate.resolve()
  const [models] = await Promise.all([modelsPromise, fetchPromise])

  expect(mock.calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1)
  expect((models as Record<string, { limit?: { context?: number } }>)[MODEL_ID]!.limit?.context).toBe(131072)
  expect(writes).toHaveLength(1)
})

test("auth.loader: separate plugin instances share one refresh via the auth-store lock", async () => {
  const stale = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  await withTempAuthStore(stale, async (root) => {
    const gate = deferred<void>()
    mock = installFetchMock(async (call) => {
      if (call.url.includes("/oauth/token")) {
        await gate.promise
        const next = validAuth({ access: "access-2", refresh: "refresh-2", expires: Date.now() + 15 * 60_000 })
        await writeAuthStore(root, next)
        return { body: { access_token: next.access, refresh_token: next.refresh, token_type: "Bearer", expires_in: 900 } }
      }
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
      }
      return { body: { ok: true } }
    })
    const readAuth = async () => stale
    const { fetch: f1 } = await getLoaderFetch(readAuth)
    const { fetch: f2 } = await getLoaderFetch(readAuth)
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL_ID, messages: [] }),
    }

    const p1 = f1("https://api.kimi.com/coding/v1/chat/completions", request)
    const p2 = f2("https://api.kimi.com/coding/v1/chat/completions", request)
    await new Promise((r) => setTimeout(r, 0))
    gate.resolve()
    await Promise.all([p1, p2])

    expect(mock.calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(1)
    expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/chat/completions")).map((c) => c.headers["authorization"])).toEqual([
      "Bearer access-2",
      "Bearer access-2",
    ])
  })
})

test("auth.loader: refresh discovery keeps auth storage limited to OAuth tokens", async () => {
  const current = validAuth({ expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return {
        body: {
          data: [
            { id: "some-other-slug", context_length: 100000 },
            { id: MODEL_ID, context_length: 262144, display_name: "Kimi" },
          ],
        },
      }
    }
    return { body: { ok: true } }
  })
  const { writes, fetch: f } = await getLoaderFetch(async () => current)
  await f("https://api.kimi.com/coding/v1/chat")
  const persisted = writes[0]!.body as { model_id?: string; context_length?: number }
  expect(persisted.model_id).toBeUndefined()
  expect(persisted.context_length).toBeUndefined()
})

test("auth.loader: model discovery failure does not break refresh", async () => {
  const current = validAuth({ expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2, access: "old" })
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      return { body: { access_token: "new", refresh_token: "r", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) return { status: 500, body: { error: "oops" } }
    return { body: { ok: true } }
  })
  const { fetch: f, writes } = await getLoaderFetch(async () => current)
  const res = await f("https://api.kimi.com/coding/v1/chat")
  expect(res.ok).toBe(true)
  expect((writes[0]!.body as { access: string }).access).toBe("new")
  expect((writes[0]!.body as { model_id?: string }).model_id).toBeUndefined()
})

test("auth.loader: invalid_grant self-heals when the live auth store rotated mid-refresh", async () => {
  const stale = validAuth({ access: "stale", expires: Date.now() + REFRESH_SAFETY_WINDOW_MS / 2 })
  await withTempAuthStore(stale, async (root) => {
    mock = installFetchMock(async (call) => {
      if (call.url.includes("/oauth/token")) {
        const next = validAuth({ access: "fresh", refresh: "refresh-2", expires: Date.now() + 15 * 60_000 })
        await writeAuthStore(root, next)
        return {
          status: 400,
          body: { error: "invalid_grant", error_description: "The provided authorization grant is invalid" },
        }
      }
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
      }
      return { body: { ok: true } }
    })
    const { fetch: f, writes } = await getLoaderFetch(async () => stale)
    const res = await f("https://api.kimi.com/coding/v1/chat")
    expect(res.ok).toBe(true)
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://auth.kimi.com/api/oauth/token",
      "https://api.kimi.com/coding/v1/models",
      "https://api.kimi.com/coding/v1/chat",
    ])
    expect(mock.calls[1]!.headers["authorization"]).toBe("Bearer fresh")
    expect(mock.calls[2]!.headers["authorization"]).toBe("Bearer fresh")
    expect(writes).toHaveLength(0)
  })
})

test("auth.loader: discovers /models on first request without rewriting the selected id", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "k2p5", display_name: "Kimi Code", context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(mock.calls.map((c) => c.url)).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat/completions",
  ])
  const sentBody = JSON.parse(mock.calls[1]!.body as string)
  expect(sentBody.model).toBe(MODEL_ID)
})

test("auth.loader: caches a discovered catalog for subsequent requests in the same loader", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "k2p5", display_name: "Kimi Code", context_length: 131072 }] } }
    }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, turn: 1 }),
  })
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, turn: 2 }),
  })
  expect(mock.calls.filter((c) => c.url.endsWith("/coding/v1/models"))).toHaveLength(1)
})

test("auth.loader: preserves the selected id when discovery returns a different catalog entry", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { body: { data: [{ id: "k2p5" }] } }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  expect(mock.calls).toHaveLength(2)
  const sentBody = JSON.parse(mock.calls[1]!.body as string)
  expect(sentBody.model).toBe(MODEL_ID)
  expect(sentBody.messages).toEqual([])
})

test("auth.loader: leaves a selected canonical body untouched after catalog discovery", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { body: { data: [{ id: MODEL_ID }] } }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  const originalBody = JSON.stringify({ model: MODEL_ID, x: 1 })
  await f("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: originalBody,
  })
  expect(mock.calls[1]!.body).toBe(originalBody)
})

test("auth.loader: preserves Request input headers and the selected model", async () => {
  mock = installFetchMock((call) => {
    if (call.url.endsWith("/coding/v1/models")) return { body: { data: [{ id: "k2p5" }] } }
    return { body: { ok: true } }
  })
  const { fetch: f } = await getLoaderFetch(async () => validAuth())
  const req = new Request("https://api.kimi.com/coding/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-extra": "keep-me",
      Authorization: "Bearer stale",
    },
    body: JSON.stringify({ model: MODEL_ID, messages: [] }),
  })
  await f(req)
  expect(mock.calls[1]!.headers["x-extra"]).toBe("keep-me")
  expect(mock.calls[1]!.headers["authorization"]).toBe("Bearer access-1")
  expect(JSON.parse(mock.calls[1]!.body as string).model).toBe(MODEL_ID)
})

test("auth.loader: 401 triggers exactly one forced refresh + retry (no infinite loop)", async () => {
  let current = validAuth({ access: "stale" })
  const readAuth = async () => current
  mock = installFetchMock((call) => {
    if (call.url.includes("/oauth/token")) {
      current = { ...current, access: "fresh" }
      return { body: { access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "kimi-for-coding", context_length: 262144 }] } }
    }
    // First API call: stale → 401. Every subsequent API call: 401 as well.
    // The loader must NOT loop; exactly one retry after refresh.
    return { status: 401, body: { error: "unauthorized" } }
  })
  const { fetch: f } = await getLoaderFetch(readAuth)
  const res = await f("https://api.kimi.com/coding/v1/chat")
  expect(res.status).toBe(401)
  const urls = mock.calls.map((c) => c.url)
  // Expected order: startup discovery with stale token → stale call → refresh
  // → /models discovery with fresh token → retry with fresh token → STOP.
  expect(urls).toEqual([
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
    "https://auth.kimi.com/api/oauth/token",
    "https://api.kimi.com/coding/v1/models",
    "https://api.kimi.com/coding/v1/chat",
  ])
  expect(mock.calls[1]!.headers["authorization"]).toBe("Bearer stale")
  expect(mock.calls[4]!.headers["authorization"]).toBe("Bearer fresh")
})

// B1 — forced-refresh fix is not defeated by adapter rereading rotated cred.
// Two instances: instance 1's doRequest uses auth A and gets 401; BETWEEN the
// 401 and the forced refresh, the store is rotated A→B by instance 2. The
// forced refresh must receive auth A (the rejected credential), so core's
// Oracle #9 + B2 fix detects B is newer and returns B WITHOUT an extra OAuth
// exchange. The retry then proceeds with B.
test("B1: 401 forced refresh passes the rejected auth, adopts a concurrent rotation without extra exchange", async () => {
  await withTempAuthStore(validAuth({ access: "access-A", refresh: "refresh-1" }), async (root) => {
    const authA = validAuth({ access: "access-A", refresh: "refresh-1" })
    const authB = validAuth({ access: "access-B", refresh: "refresh-2", expires: Date.now() + 15 * 60_000 })

    mock = installFetchMock(async (call) => {
      if (call.url.endsWith("/coding/v1/models")) {
        return { body: { data: [{ id: MODEL_ID, context_length: 262144 }] } }
      }
      if (call.url.endsWith("/coding/v1/chat")) {
        // doRequest with A → 401. SIMULATE instance 2 rotating A→B in the
        // store between the dispatch and instance 1's forced refresh.
        if (call.headers["authorization"] === "Bearer access-A") {
          await writeAuthStore(root, authB)
          return { status: 401, body: { error: "unauthorized" } }
        }
        return { body: { ok: true } }
      }
      // /oauth/token must NEVER be called — no extra rotation.
      return { body: { ok: true } }
    })

    const { fetch: f } = await getLoaderFetch(async () => authA)
    const res = await f("https://api.kimi.com/coding/v1/chat")
    expect(res.ok).toBe(true)

    // Zero OAuth token exchanges: core detected B under the lock and returned
    // it without rotating.
    expect(mock.calls.filter((c) => c.url.includes("/oauth/token"))).toHaveLength(0)
    // The retry used B (rotated by instance 2), not A.
    const chatCalls = mock.calls.filter((c) => c.url.endsWith("/coding/v1/chat"))
    expect(chatCalls[0]!.headers["authorization"]).toBe("Bearer access-A")
    expect(chatCalls[1]!.headers["authorization"]).toBe("Bearer access-B")
  })
})

// ---------- auth.methods (device flow wiring) -------------------------------

test("auth.methods[0].authorize returns URL + instructions + async callback", async () => {
  mock = installFetchMock((call) => {
    if (call.url.includes("device_authorization")) {
      return {
        body: {
          device_code: "dc",
          user_code: "WXYZ-1234",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?u=WXYZ-1234",
          expires_in: 60,
          interval: 1,
        },
      }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return { body: { data: [{ id: "kimi-for-coding", display_name: "Kimi Code", context_length: 262144 }] } }
    }
    return { body: { access_token: "A", refresh_token: "R", token_type: "Bearer", expires_in: 900 } }
  })
  const { hooks } = await getHooks()
  const method = hooks.auth!.methods![0] as { authorize: () => Promise<any> }
  const r = await method.authorize()
  expect(r.url).toBe("https://auth.kimi.com/device?u=WXYZ-1234")
  expect(r.instructions).toContain("WXYZ-1234")
  const cb = await r.callback()
  expect(cb.type).toBe("success")
  expect(cb.access).toBe("A")
  expect(cb.refresh).toBe("R")
  expect(typeof cb.expires).toBe("number")
})

test("auth callback prints a full schema-valid catalog with top-level model variants", async () => {
  mock = installFetchMock((call) => {
    if (call.url.includes("device_authorization")) {
      return {
        body: {
          device_code: "dc",
          user_code: "WXYZ-1234",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?u=WXYZ-1234",
          expires_in: 60,
          interval: 1,
        },
      }
    }
    if (call.url.endsWith("/coding/v1/models")) {
      return {
        body: {
          data: currentKimiCatalog(),
        },
      }
    }
    return { body: { access_token: "A", refresh_token: "R", token_type: "Bearer", expires_in: 900 } }
  })
  const { hooks } = await getHooks()
  const method = hooks.auth!.methods![0] as { authorize: () => Promise<any> }
  const r = await method.authorize()
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    await r.callback()
  } finally {
    console.log = orig
  }

  const text = lines.join("\n")
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    provider: {
      [key: string]: {
        models: {
          [key: string]: {
            attachment?: boolean
            limit?: { context?: number; output?: number }
            modalities?: { input?: string[]; output?: string[] }
            options?: Record<string, unknown>
            variants?: Record<string, { disabled?: boolean; reasoning_effort?: string; thinking?: { type?: string } }>
          }
        }
      }
    }
  }
  const models = parsed.provider[PROVIDER_ID]!.models
  const model = models[MODEL_ID]!
  const k3 = models.k3!
  const highspeed = models["kimi-for-coding-highspeed"]!
  expect(text).toContain("context 262144")
  expect(Object.keys(models)).toEqual(expect.arrayContaining(["k3", MODEL_ID, "kimi-for-coding-highspeed"]))
  expect(model.attachment).toBe(true)
  expect(model.limit).toEqual({ context: 262144, output: 0 })
  expect(model.modalities).toEqual({
    input: ["text", "image"],
    output: ["text"],
  })
  expect(model.options).toEqual({ thinking: { type: "enabled" } })
  expect(model.variants).toEqual({
    on: { thinking: { type: "enabled" } },
    low: { disabled: true },
    medium: { disabled: true },
    high: { disabled: true },
  })
  expect(k3.limit).toEqual({ context: 1048576, output: 0 })
  expect(k3.variants).toEqual({
    low: { reasoning_effort: "low", thinking: { type: "enabled" } },
    medium: { disabled: true },
    high: { reasoning_effort: "high", thinking: { type: "enabled" } },
    max: { reasoning_effort: "max", thinking: { type: "enabled" } },
  })
  expect(highspeed.limit).toEqual({ context: 131072, output: 0 })
  expect(highspeed.variants).toEqual({
    on: { thinking: { type: "enabled" } },
    low: { disabled: true },
    medium: { disabled: true },
    high: { disabled: true },
  })
  expect(model.options?.variants).toBeUndefined()
})
