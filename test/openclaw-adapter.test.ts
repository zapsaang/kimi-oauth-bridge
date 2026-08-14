/// <reference path="./bun-test.d.ts" />

import { afterEach, expect, mock, test } from "bun:test"
import fs from "node:fs"
import {
  API_BASE_URL,
  KIMI_CLI_VERSION,
  KIMI_DEFAULT_CONTEXT_WINDOW,
  MODEL_ID,
  PROVIDER_ID,
} from "../src/core/constants.ts"
import type { ProviderCatalogContext, ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/core"
import type { KimiModelInfo } from "../src/core/oauth.ts"
import { installFetchMock } from "./_util/fetchMock.ts"
import {
  buildColdKimiModel,
  buildKimiProvider,
  discoverKimiCatalog,
  getDiscoveredKimiModel,
  projectKimiModel,
  rememberDiscoveredCatalog,
  resetCatalogScopes,
  scopeHasWarmCatalog,
} from "../src/adapters/openclaw/catalog.ts"
import {
  kimiResolveDynamicModel,
  refreshKimiOAuth,
  resolveKimiOpenClawExtraParams,
} from "../src/adapters/openclaw/provider.ts"
import openclawEntry from "../src/adapters/openclaw/index.ts"

// Oracle #14 / contract: the OpenClaw adapter reuses the same PROVIDER_ID as
// the OpenCode adapter so a user has ONE auth/login surface across hosts.

// --- fixtures ----------------------------------------------------------------

const fixtures: KimiModelInfo[] = [
  // K2.7 always-thinking (standard coding entry).
  {
    id: "kimi-for-coding",
    display_name: "Kimi K2.7 Code",
    context_length: 256000,
    supports_reasoning: true,
    supports_thinking_type: "only",
  },
  // K3 with low/high/max efforts, default high, image input.
  {
    id: "k3",
    display_name: "Kimi K3",
    context_length: 262144,
    supports_reasoning: true,
    supports_thinking_type: "both",
    supports_image_in: true,
    supports_video_in: false,
    think_efforts: { support: true, valid_efforts: ["low", "high", "max"], default_effort: "high" },
  },
  // Future effort-enabled model with a different effort ladder.
  {
    id: "kimi-future",
    display_name: "Kimi Future",
    context_length: 200000,
    supports_reasoning: true,
    supports_thinking_type: "both",
    think_efforts: { support: true, valid_efforts: ["low", "medium", "high"], default_effort: "medium" },
  },
  // No-reasoning model.
  {
    id: "kimi-lite",
    display_name: "Kimi Lite",
    context_length: 128000,
    supports_reasoning: false,
    supports_thinking_type: "no",
  },
  // Unsafe id — must be rejected at projection (S3 proto-pollution guard).
  { id: "__proto__", display_name: "poison", context_length: 999 },
]

// --- module mock for the SDK auth resolver -----------------------------------

let mockResolvedAuth: { apiKey?: string; source: string; mode: "api_key" | "oauth" | "token" | "aws-sdk" | "none" } = {
  apiKey: undefined,
  source: "none",
  mode: "none",
}
mock.module("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => mockResolvedAuth,
}))

let fetchMock: ReturnType<typeof installFetchMock> | undefined
afterEach(() => {
  fetchMock?.restore()
  fetchMock = undefined
  mockResolvedAuth = { apiKey: undefined, source: "none", mode: "none" }
  resetCatalogScopes()
})

// --- 1. catalog projection ---------------------------------------------------

test("projectKimiModel projects discovery metadata into ModelDefinitionConfig[]", () => {
  const projected = fixtures.map(projectKimiModel)

  // Unsafe id rejected.
  expect(projected[4]).toBeNull()
  const safe = projected.filter((m): m is NonNullable<typeof m> => m !== null)
  expect(safe.map((m) => m.id)).toEqual(["kimi-for-coding", "k3", "kimi-future", "kimi-lite"])

  const k27 = safe[0]!
  const k3 = safe[1]!
  const future = safe[2]!
  const lite = safe[3]!

  // K2.7 always-thinking: reasoning on, text-only, no effort knobs.
  expect(k27.reasoning).toBe(true)
  expect(k27.input).toEqual(["text"])
  expect(k27.contextWindow).toBe(256000)
  expect(k27.maxTokens).toBe(k27.contextWindow)
  expect(k27.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  expect(k27.compat?.supportsPromptCacheKey).toBe(true)
  expect(k27.compat?.supportsReasoningEffort).toBeUndefined()
  expect(k27.thinkingLevelMap).toBeUndefined()

  // K3: image input, effort ladder mapped identity, reasoning-effort compat on.
  expect(k3.reasoning).toBe(true)
  expect(k3.input).toEqual(["text", "image"])
  expect(k3.contextWindow).toBe(262144)
  expect(k3.maxTokens).toBe(k3.contextWindow)
  expect(k3.compat?.supportsPromptCacheKey).toBe(true)
  expect(k3.compat?.supportsReasoningEffort).toBe(true)
  expect(k3.compat?.supportedReasoningEfforts).toEqual(["low", "high", "max"])
  expect(k3.compat?.reasoningEffortMap).toEqual({ low: "low", high: "high", max: "max" })
  expect(k3.thinkingLevelMap).toEqual({ low: "low", high: "high", max: "max" })

  // Future model: different effort ladder mapped identity.
  expect(future.thinkingLevelMap).toEqual({ low: "low", medium: "medium", high: "high" })

  // No-reasoning model: reasoning off, only prompt-cache-key compat.
  expect(lite.reasoning).toBe(false)
  expect(lite.compat?.supportsPromptCacheKey).toBe(true)
  expect(lite.compat?.supportsReasoningEffort).toBeUndefined()
  expect(lite.thinkingLevelMap).toBeUndefined()
})

test("projectKimiModel falls back to KIMI_DEFAULT_CONTEXT_WINDOW when context_length is absent", () => {
  const projected = projectKimiModel({ id: "no-window", supports_reasoning: false, supports_thinking_type: "no" })
  expect(projected?.contextWindow).toBe(KIMI_DEFAULT_CONTEXT_WINDOW)
})

// --- 2. refreshOAuth delegates to core refreshToken --------------------------

test("refreshKimiOAuth delegates to core refreshToken and returns the OAuthCredential shape", async () => {
  fetchMock = installFetchMock(() => ({
    body: { access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 900 },
  }))
  const result = await refreshKimiOAuth({
    type: "oauth",
    provider: PROVIDER_ID,
    access: "old-access",
    refresh: "r1",
    expires: 1000,
    email: "user@example.com",
  })
  expect(result.access).toBe("a2")
  expect(result.refresh).toBe("r2")
  expect(result.expires).toBeGreaterThan(Date.now())
  expect(result.type).toBe("oauth")
  expect(result.provider).toBe(PROVIDER_ID)
  // Non-rotated metadata preserved.
  expect(result.email).toBe("user@example.com")
  // Core refreshToken was the only network call (the device/token endpoint).
  expect(fetchMock.calls).toHaveLength(1)
})

// --- 3. prepareExtraParams mapping -------------------------------------------

test("resolveKimiOpenClawExtraParams maps thinkingLevel to reasoning_effort/thinking and never emits prompt_cache_key", () => {
  const k3 = fixtures[1]!
  // high → reasoning_effort high + thinking enabled.
  const high = resolveKimiOpenClawExtraParams({ modelId: "k3", thinkingLevel: "high", info: k3 })
  expect(high.reasoning_effort).toBe("high")
  expect(high.thinking).toEqual({ type: "enabled" })
  expect("prompt_cache_key" in high).toBe(false)

  // K3's valid efforts are low/high/max (no "off"), so it is always-thinking:
  // an "off" level cannot disable it — reasoning_effort falls back to the
  // default (high) and thinking stays enabled. Mirrors core body-fields.
  const offK3 = resolveKimiOpenClawExtraParams({ modelId: "k3", thinkingLevel: "off", info: k3 })
  expect(offK3.thinking).toEqual({ type: "enabled" })
  expect("prompt_cache_key" in offK3).toBe(false)

  // A "both"-without-efforts model CAN be disabled: off → thinking disabled.
  const bothNoEffort: KimiModelInfo = {
    id: "both-model",
    supports_reasoning: true,
    supports_thinking_type: "both",
  }
  const off = resolveKimiOpenClawExtraParams({ modelId: "both-model", thinkingLevel: "off", info: bothNoEffort })
  expect(off.thinking).toEqual({ type: "disabled" })
  expect(off.reasoning_effort).toBeUndefined()
  expect("prompt_cache_key" in off).toBe(false)

  // Non-reasoning model → no fields.
  const lite = fixtures[3]!
  const none = resolveKimiOpenClawExtraParams({ modelId: "kimi-lite", thinkingLevel: "high", info: lite })
  expect(none).toEqual({})
})

test("cold MODEL_ID normalizes thinkingLevel off to enabled always-thinking without effort", () => {
  const coldOff = resolveKimiOpenClawExtraParams({ modelId: MODEL_ID, thinkingLevel: "off" })

  expect(coldOff.thinking).toEqual({ type: "enabled" })
  expect(coldOff.reasoning_effort).toBeUndefined()
})

// --- 4. resolveDynamicModel (Oracle #13 + B6) --------------------------------

// B6: the MODEL_ID cold fallback resolves ONLY while the scope is genuinely
// cold (never had a successful nonempty discovery). Once a warm catalog exists
// for that scope, MODEL_ID no longer synthesizes even if it was the canonical
// cold fallback — authoritative replacement means a warm catalog without
// kimi-for-coding removes it from the resolvable set.
test("B6: kimiResolveDynamicModel resolves MODEL_ID only while cold; warm catalog gates it", () => {
  const makeCtx = (modelId: string, provider = PROVIDER_ID): ProviderResolveDynamicModelContext => ({
    provider,
    modelId,
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
  })

  // COLD scope (no catalog yet): MODEL_ID fallback resolves.
  resetCatalogScopes()
  const coldFallback = kimiResolveDynamicModel(makeCtx(MODEL_ID))
  expect(coldFallback?.id).toBe(MODEL_ID)

  // Warm catalog WITHOUT kimi-for-coding: MODEL_ID no longer resolvable.
  rememberDiscoveredCatalog([{ id: "k3", display_name: "K3", supports_reasoning: true, supports_thinking_type: "both" }])
  const warmNoCold = kimiResolveDynamicModel(makeCtx(MODEL_ID))
  expect(warmNoCold).toBeNull()

  // Ids IN the catalog resolve.
  const k3Model = kimiResolveDynamicModel(makeCtx("k3"))
  expect(k3Model?.id).toBe("k3")

  // Arbitrary unknown id → null (never synthesized).
  const synth = kimiResolveDynamicModel(makeCtx("totally-made-up"))
  expect(synth).toBeNull()

  // Wrong provider → null.
  const other = kimiResolveDynamicModel(makeCtx("k3", "someone-else"))
  expect(other).toBeNull()
})

// Preserve the original assertion: when the catalog DOES include MODEL_ID, it
// resolves as a discovered entry (not via the cold-fallback path).
test("kimiResolveDynamicModel resolves a catalog entry whose id is MODEL_ID", () => {
  rememberDiscoveredCatalog(fixtures)
  const makeCtx = (modelId: string): ProviderResolveDynamicModelContext => ({
    provider: PROVIDER_ID,
    modelId,
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
  })
  const model = kimiResolveDynamicModel(makeCtx(MODEL_ID))
  expect(model?.id).toBe(MODEL_ID)
  const k3 = kimiResolveDynamicModel(makeCtx("k3"))
  expect(k3?.id).toBe("k3")
  expect(k3?.provider).toBe(PROVIDER_ID)
  expect(k3?.api).toBe("openai-completions")
  expect(k3?.authHeader).toBe(true)
})

// --- 5. contract: identity consistency ---------------------------------------

test("OpenClaw entry id, manifest id/providers[0], and package name all equal PROVIDER_ID", () => {
  expect(openclawEntry.id).toBe(PROVIDER_ID)

  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { id: string; providers: string[] }
  expect(manifest.id).toBe(PROVIDER_ID)
  expect(manifest.providers[0]).toBe(PROVIDER_ID)

  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string }
  expect(pkg.name).toBe(PROVIDER_ID)
})

// --- 6. cold fallback when discovery has no auth -----------------------------

test("discoverKimiCatalog returns the cold fallback provider when no auth is resolvable", async () => {
  mockResolvedAuth = { apiKey: undefined, source: "none", mode: "none" }
  const ctx: ProviderCatalogContext = {
    config: {} as ProviderCatalogContext["config"],
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  }
  const result = await discoverKimiCatalog(ctx)
  expect(result).not.toBeNull()
  const provider = (result as { provider: ReturnType<typeof buildKimiProvider> }).provider
  expect(provider.baseUrl).toBe(API_BASE_URL)
  expect(provider.api).toBe("openai-completions")
  expect(provider.authHeader).toBe(true)
  expect(provider.headers?.["User-Agent"]).toBe(`KimiCLI/${KIMI_CLI_VERSION}`)
  expect(provider.models).toHaveLength(1)
  const cold = provider.models[0]!
  expect(cold.id).toBe(MODEL_ID)
  expect(cold.contextWindow).toBe(KIMI_DEFAULT_CONTEXT_WINDOW)
  expect(cold.maxTokens).toBe(KIMI_DEFAULT_CONTEXT_WINDOW)
  expect(cold.compat?.supportsPromptCacheKey).toBe(true)
})

test("discoverKimiCatalog projects a discovered catalog when an OAuth bearer is resolvable", async () => {
  mockResolvedAuth = { apiKey: "fake-bearer", source: "profile", mode: "oauth" }
  fetchMock = installFetchMock(() => ({ body: { data: fixtures } }))
  const ctx: ProviderCatalogContext = {
    config: {} as ProviderCatalogContext["config"],
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "fake-bearer" }),
    resolveProviderAuth: () => ({ apiKey: "fake-bearer", mode: "oauth", source: "profile", profileId: "p1" }),
  }
  const result = await discoverKimiCatalog(ctx)
  const provider = (result as { provider: ReturnType<typeof buildKimiProvider> }).provider
  // Unsafe id dropped; the four safe ids are present with exact ids preserved.
  expect(provider.models.map((m) => m.id)).toEqual([
    "kimi-for-coding",
    "k3",
    "kimi-future",
    "kimi-lite",
  ])
  // In-memory cache populated for the sync hooks.
  expect(getDiscoveredKimiModel("k3")?.display_name).toBe("Kimi K3")
})

// buildKimiProvider/buildColdKimiModel sanity (pure helpers used above).
test("buildColdKimiModel and buildKimiProvider produce the expected shapes", () => {
  const cold = buildColdKimiModel()
  expect(cold.id).toBe(MODEL_ID)
  expect(cold.reasoning).toBe(true)
  const provider = buildKimiProvider([cold])
  expect(provider.authHeader).toBe(true)
  expect(provider.api).toBe("openai-completions")
})

test("buildKimiProvider sets provider-level Kimi fingerprint headers", () => {
  // Given: a projected provider for any catalog (cold or discovered)
  const provider = buildKimiProvider([buildColdKimiModel()])

  // Then: every transport path (including ones not covered by wrapStreamFn)
  // inherits the 7-header Kimi CLI fingerprint; Authorization stays with the
  // transport (authHeader: true) and must NOT appear here.
  const headers = provider.headers
  expect(headers).toBeDefined()
  expect(headers?.["User-Agent"]).toBe(`KimiCLI/${KIMI_CLI_VERSION}`)
  for (const name of [
    "X-Msh-Platform",
    "X-Msh-Version",
    "X-Msh-Device-Name",
    "X-Msh-Device-Model",
    "X-Msh-Device-Id",
    "X-Msh-Os-Version",
  ]) {
    const value = headers?.[name]
    expect(typeof value).toBe("string")
    if (typeof value === "string") expect(value.length).toBeGreaterThan(0)
  }
  expect(headers?.["Authorization"]).toBeUndefined()
  expect(headers?.["authorization"]).toBeUndefined()
})

// --- B3: scoped catalog cache + S4 sequence + split-brain + leakage ----------

function makeCatalogCtx(opts: {
  agentDir?: string
  workspaceDir?: string
  authMode?: "oauth" | "api_key" | "none" | "token" | "aws-sdk"
  profileId?: string
  apiKey?: string
}): ProviderCatalogContext {
  return {
    config: {} as ProviderCatalogContext["config"],
    env: {},
    ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
    ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
    resolveProviderApiKey: () => ({ apiKey: opts.apiKey }),
    resolveProviderAuth: () => ({
      apiKey: opts.apiKey,
      mode: opts.authMode ?? "none",
      source: opts.profileId ? "profile" : "none",
      ...(opts.profileId ? { profileId: opts.profileId } : {}),
    }),
  }
}

test("B3: older discovery does not overwrite a newer successful catalog (S4 seq guard)", async () => {
  mockResolvedAuth = { apiKey: "bearer", source: "profile", mode: "oauth" }
  let releaseOlder: (() => void) | undefined
  const olderGate = new Promise<void>((resolve) => {
    releaseOlder = resolve
  })
  let signalOlderStarted: (() => void) | undefined
  const olderStarted = new Promise<void>((resolve) => {
    signalOlderStarted = resolve
  })
  let fetchIdx = 0
  fetchMock = installFetchMock(async () => {
    fetchIdx++
    // First dispatched call (lower seq) is SLOW (gated), returns older model.
    // Second dispatched call (higher seq) is FAST, returns newer model.
    if (fetchIdx === 1) {
      if (!signalOlderStarted) throw new Error("older discovery did not reach the deferred gate")
      signalOlderStarted()
      await olderGate
      return { body: { data: [{ id: "older-model", display_name: "Older" }] } }
    }
    return { body: { data: [{ id: "newer-model", display_name: "Newer" }] } }
  })
  const ctx = makeCatalogCtx({ authMode: "oauth", profileId: "p1", apiKey: "bearer" })

  const older = discoverKimiCatalog(ctx)
  await olderStarted
  const newer = discoverKimiCatalog(ctx)
  // newer resolves first (fast); then gate releases older.
  await newer
  if (!releaseOlder) throw new Error("older discovery gate was not initialized")
  releaseOlder()
  await older

  // Newer (higher seq) won; older (lower seq) was rejected.
  expect(getDiscoveredKimiModel("newer-model")).toBeDefined()
  expect(getDiscoveredKimiModel("older-model")).toBeUndefined()
})

test("B3: warm failure returns last-known-good and keeps sync map consistent (no split-brain)", async () => {
  mockResolvedAuth = { apiKey: "bearer", source: "profile", mode: "oauth" }
  let callIdx = 0
  fetchMock = installFetchMock(() => {
    callIdx++
    if (callIdx === 1) return { body: { data: [{ id: "warm-model" }] } }
    return { status: 500, body: { error: "fail" } }
  })
  const ctx = makeCatalogCtx({ authMode: "oauth", profileId: "p1", apiKey: "bearer" })

  const first = await discoverKimiCatalog(ctx)
  const firstProvider = (first as { provider: ReturnType<typeof buildKimiProvider> }).provider
  expect(firstProvider.models.map((m) => m.id)).toContain("warm-model")

  const second = await discoverKimiCatalog(ctx)
  const secondProvider = (second as { provider: ReturnType<typeof buildKimiProvider> }).provider
  // Returned last-known-good (not cold).
  expect(secondProvider.models.map((m) => m.id)).toContain("warm-model")
  // Sync map is consistent with what was returned — no split-brain.
  expect(getDiscoveredKimiModel("warm-model")).toBeDefined()
})

test("B3: profile/agent switch does NOT see another scope's discovered model", async () => {
  mockResolvedAuth = { apiKey: "bearer", source: "profile", mode: "oauth" }
  fetchMock = installFetchMock(() => ({ body: { data: [{ id: "scope-a-model" }] } }))
  const ctxA = makeCatalogCtx({ agentDir: "/agent-a", authMode: "oauth", profileId: "p1", apiKey: "bearer" })

  await discoverKimiCatalog(ctxA)
  // Scope B is cold — must NOT see scope A's model.
  expect(getDiscoveredKimiModel("scope-a-model", { agentDir: "/agent-b" })).toBeUndefined()
  expect(scopeHasWarmCatalog({ agentDir: "/agent-b" })).toBe(false)
  // Scope A still has it.
  expect(getDiscoveredKimiModel("scope-a-model", { agentDir: "/agent-a" })).toBeDefined()
})

test("B3(profile): same dirs profile switch clears A's warm catalog when B discovery fails", async () => {
  const scope = { agentDir: "/shared-agent", workspaceDir: "/shared-workspace" }
  const ctxA = makeCatalogCtx({
    ...scope,
    authMode: "oauth",
    profileId: "profile-a",
    apiKey: "bearer-a",
  })
  const ctxB = makeCatalogCtx({
    ...scope,
    authMode: "oauth",
    profileId: "profile-b",
    apiKey: "bearer-b",
  })
  let releaseStaleA: (() => void) | undefined
  const staleAGate = new Promise<void>((resolve) => {
    releaseStaleA = resolve
  })
  let signalStaleAStarted: (() => void) | undefined
  const staleAStarted = new Promise<void>((resolve) => {
    signalStaleAStarted = resolve
  })
  let callIdx = 0
  fetchMock = installFetchMock(async () => {
    callIdx++
    if (callIdx === 1) return { body: { data: [{ id: "profile-a-model" }] } }
    if (callIdx === 2) {
      if (!signalStaleAStarted) throw new Error("stale A discovery did not reach the deferred gate")
      signalStaleAStarted()
      await staleAGate
      return { body: { data: [{ id: "profile-a-refresh-model" }] } }
    }
    return { status: 500, body: { error: "profile-b discovery failed" } }
  })

  mockResolvedAuth = { apiKey: "bearer-a", source: "profile", mode: "oauth" }
  await discoverKimiCatalog(ctxA)
  expect(scopeHasWarmCatalog(scope)).toBe(true)
  expect(getDiscoveredKimiModel("profile-a-model", scope)).toBeDefined()

  const staleA = discoverKimiCatalog(ctxA)
  await staleAStarted

  mockResolvedAuth = { apiKey: "bearer-b", source: "profile", mode: "oauth" }
  const resultB = await discoverKimiCatalog(ctxB)
  const providerB = (resultB as { provider: ReturnType<typeof buildKimiProvider> }).provider

  expect(providerB.models.map((model) => model.id)).toEqual([MODEL_ID])
  expect(scopeHasWarmCatalog(scope)).toBe(false)
  expect(getDiscoveredKimiModel("profile-a-model", scope)).toBeUndefined()

  const resolveCtx: ProviderResolveDynamicModelContext = {
    provider: PROVIDER_ID,
    modelId: "profile-a-model",
    ...scope,
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
  }
  expect(kimiResolveDynamicModel(resolveCtx)).toBeNull()

  if (!releaseStaleA) throw new Error("stale A discovery gate was not initialized")
  releaseStaleA()
  const staleResultA = await staleA
  const staleProviderA = (staleResultA as { provider: ReturnType<typeof buildKimiProvider> }).provider
  expect(staleProviderA.models.map((model) => model.id)).toEqual([MODEL_ID])
})

test("B3: all-invalid catalog (every id unsafe) yields cold fallback cleanly", async () => {
  mockResolvedAuth = { apiKey: "bearer", source: "profile", mode: "oauth" }
  fetchMock = installFetchMock(() => ({ body: { data: [{ id: "__proto__" }, { id: "constructor" }] } }))
  const ctx = makeCatalogCtx({ authMode: "oauth", profileId: "p1", apiKey: "bearer" })

  const result = await discoverKimiCatalog(ctx)
  const provider = (result as { provider: ReturnType<typeof buildKimiProvider> }).provider
  // Cold fallback (no safe models projected).
  expect(provider.models).toHaveLength(1)
  expect(provider.models[0]!.id).toBe(MODEL_ID)
  // Scope did not become warm.
  expect(scopeHasWarmCatalog()).toBe(false)
})

// --- B4: OAuth-only contract enforcement ------------------------------------

test("B4: static API key (mode api_key) without oauth profile returns cold fallback", async () => {
  mockResolvedAuth = { apiKey: "static-key", source: "env", mode: "api_key" }
  fetchMock = installFetchMock(() => ({ body: { data: [{ id: "would-discover" }] } }))
  const ctx = makeCatalogCtx({ authMode: "api_key", apiKey: "static-key" })

  const result = await discoverKimiCatalog(ctx)
  const provider = (result as { provider: ReturnType<typeof buildKimiProvider> }).provider
  // Cold fallback returned — never used the static key for discovery.
  expect(provider.models.map((m) => m.id)).toEqual([MODEL_ID])
  expect(fetchMock.calls).toHaveLength(0)
  expect(scopeHasWarmCatalog()).toBe(false)
})

test("B4: oauth profile discovers with lockedProfile and populates cache", async () => {
  mockResolvedAuth = { apiKey: "oauth-bearer", source: "profile", mode: "oauth" }
  fetchMock = installFetchMock(() => ({ body: { data: [{ id: "discovered-model" }] } }))
  const ctx = makeCatalogCtx({ authMode: "oauth", profileId: "oauth-profile-1", apiKey: "oauth-bearer" })

  const result = await discoverKimiCatalog(ctx)
  const provider = (result as { provider: ReturnType<typeof buildKimiProvider> }).provider
  expect(provider.models.map((m) => m.id)).toContain("discovered-model")
  expect(scopeHasWarmCatalog()).toBe(true)
})

test("B3: a warm scope that becomes non-OAuth returns cold and supersedes stale warm state (no split-brain)", async () => {
  mockResolvedAuth = { apiKey: "bearer", source: "profile", mode: "oauth" }
  fetchMock = installFetchMock(() => ({ body: { data: [{ id: "warm-model" }] } }))
  const ctx = makeCatalogCtx({ authMode: "oauth", profileId: "p1", apiKey: "bearer" })

  const warm = await discoverKimiCatalog(ctx)
  const warmProvider = (warm as { provider: ReturnType<typeof buildKimiProvider> }).provider
  expect(warmProvider.models.map((m) => m.id)).toContain("warm-model")
  expect(scopeHasWarmCatalog()).toBe(true)
  expect(getDiscoveredKimiModel("warm-model")).toBeDefined()

  // Auth flips to a static key / profileId is dropped.
  mockResolvedAuth = { apiKey: "static-key", source: "env", mode: "api_key" }
  const nonOAuthCtx = makeCatalogCtx({ authMode: "api_key", apiKey: "static-key" })
  const cold = await discoverKimiCatalog(nonOAuthCtx)
  const coldProvider = (cold as { provider: ReturnType<typeof buildKimiProvider> }).provider
  expect(coldProvider.models.map((m) => m.id)).toEqual([MODEL_ID])

  // Sync hooks must match the cold fallback the host received — no split-brain.
  expect(scopeHasWarmCatalog()).toBe(false)
  expect(getDiscoveredKimiModel("warm-model")).toBeUndefined()

  const makeResolveCtx = (modelId: string): ProviderResolveDynamicModelContext => ({
    provider: PROVIDER_ID,
    modelId,
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
  })
  // Stale warm id no longer synthesizes.
  expect(kimiResolveDynamicModel(makeResolveCtx("warm-model"))).toBeNull()
  // MODEL_ID cold fallback resolves again now that the scope is cold.
  const fallback = kimiResolveDynamicModel(makeResolveCtx(MODEL_ID))
  expect(fallback?.id).toBe(MODEL_ID)
})

// --- B5: case-insensitive header stripping in wrapStreamFn -------------------

test("B5: wrapStreamFn strips mixed-case caller headers, keeps exactly one canonical set", async () => {
  const { kimiWrapStreamFn } = await import("../src/adapters/openclaw/provider.ts")
  const { kimiHeaders } = await import("../src/core/headers.ts")

  let capturedHeaders: Record<string, string> = {}
  const fakeStreamFn = async (_model: unknown, _ctx: unknown, opts?: { headers?: Record<string, string>; onPayload?: (p: unknown) => Promise<unknown> }) => {
    capturedHeaders = { ...opts?.headers }
    return undefined
  }

  const ctx = {
    provider: PROVIDER_ID,
    modelId: MODEL_ID,
    streamFn: fakeStreamFn,
    thinkingLevel: undefined,
  } as unknown as Parameters<typeof kimiWrapStreamFn>[0]
  const wrapped = kimiWrapStreamFn(ctx)
  expect(wrapped).not.toBeNull()

  const model = { id: MODEL_ID }
  await wrapped!(
    model as Parameters<NonNullable<typeof wrapped>>[0],
    {} as Parameters<NonNullable<typeof wrapped>>[1],
    {
      headers: {
        // Mixed-case caller Authorization — must be stripped.
        AUTHORIZATION: "Bearer caller-token",
        Authorization: "Bearer caller-token-2",
        // Mixed-case X-Msh-* caller headers — must be stripped.
        "X-MSH-Device-Id": "caller-device",
        "x-msh-platform": "caller-platform",
        // Non-owned header — must survive.
        "X-Custom": "keep-me",
      },
      onPayload: async (payload: unknown) => payload,
    } as Parameters<NonNullable<typeof wrapped>>[2],
  )

  const canonical = kimiHeaders()
  for (const [name, value] of Object.entries(canonical)) {
    // The canonical value won (case-insensitive).
    const found = capturedHeaders[name]
    expect(found).toBe(value)
  }
  // Exactly one Authorization (the canonical kimiHeaders does NOT set
  // Authorization — the transport owns it. So no caller Authorization leaked.)
  const authKeys = Object.keys(capturedHeaders).filter((k) => k.toLowerCase() === "authorization")
  expect(authKeys).toHaveLength(0)
  // Non-owned header survived.
  expect(capturedHeaders["X-Custom"]).toBe("keep-me")
  // No duplicate X-Msh-* keys (mixed-case stripped, only canonical present).
  const deviceIdKeys = Object.keys(capturedHeaders).filter((k) => k.toLowerCase() === "x-msh-device-id")
  expect(deviceIdKeys).toHaveLength(1)
})

// --- B7: video cast safety ---------------------------------------------------

test("B7: supports_video_in model projects input with text/image only, never video", () => {
  const videoModel: KimiModelInfo = {
    id: "video-capable",
    display_name: "Video Model",
    context_length: 200000,
    supports_reasoning: true,
    supports_thinking_type: "both",
    supports_image_in: true,
    supports_video_in: true,
  }
  const projected = projectKimiModel(videoModel)!
  // ModelDefinitionConfig.input may carry video, but the RUNTIME model must not.
  expect(projected.input).toContain("video")

  // Now go through toRuntimeModel via resolveDynamicModel.
  rememberDiscoveredCatalog([videoModel])
  const makeCtx = (modelId: string): ProviderResolveDynamicModelContext => ({
    provider: PROVIDER_ID,
    modelId,
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    },
  })
  const runtime = kimiResolveDynamicModel(makeCtx("video-capable"))!
  expect(runtime.input).toContain("text")
  expect(runtime.input).toContain("image")
  expect(runtime.input).not.toContain("video")
})
