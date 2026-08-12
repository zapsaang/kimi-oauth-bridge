// OpenClaw adapter: catalog discovery + projection.
//
// Reuses the host-neutral core (`listModels`, `KimiModelInfo`, `thinkingConfig`,
// `supportsThinking`, `isSafeModelId`) so the projection semantics mirror the
// OpenCode adapter 1:1. The only OpenClaw-specific concern here is mapping the
// discovered catalog into OpenClaw's `ModelProviderConfig` shape and owning the
// in-memory catalog cache that `prepareExtraParams` / `wrapStreamFn` /
// `resolveDynamicModel` consult synchronously.
//
// CORE-ONLY imports first; OpenClaw SDK types are type-only.

import type {
  ModelApi,
  ModelCompatConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/config-types"
import type { ProviderCatalogContext, ProviderCatalogResult } from "openclaw/plugin-sdk/core"
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime"

import {
  API_BASE_URL,
  KIMI_DEFAULT_CONTEXT_WINDOW,
  MODEL_ID,
  PROVIDER_ID,
} from "../../core/constants.ts"
import { type KimiModelInfo, listModels } from "../../core/oauth.ts"
import { isSafeEffortString, isSafeModelId } from "../../core/validation.ts"
import { supportsThinking } from "../../core/thinking.ts"

// Oracle #6: `api` is hardcoded to the verified current transport. Kimi's
// `/coding/v1/models` exposes a `protocol` field, but mapping it to an OpenClaw
// transport (anthropic / openai-responses / ...) is UNVERIFIED and would risk
// routing requests onto the wrong request shape. The OpenCode adapter uses
// @ai-sdk/openai-compatible (chat completions); we mirror that here.
const KIMI_API: ModelApi = "openai-completions"

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const

// B8: maxTokens is REQUIRED by OpenClaw's ModelDefinitionConfig type (and by
// the runtime Model the transport consumes), so it cannot be omitted. Kimi's
// `/coding/v1/models` discovery publishes NO per-model max-output field, so we
// follow the OFFICIAL client convention: use the model's context length as the
// completion budget (clamped against consumed context upstream — see kimi-code
// completionBudget.ts:28-54, openai-legacy.ts:753-770). maxTokens is therefore
// set equal to contextWindow per model. No invented constant is needed; core
// stays host-neutral. A real chat probe before release is still a live probe.

// M1: reasoning/effort decisions are consolidated through core supportsThinking
// so both hosts agree on the thinking policy. A model reasons only when
// supports_reasoning === true AND supports_thinking_type !== "no".
function kimiModelReasoning(info: KimiModelInfo): boolean {
  return supportsThinking(info)
}

// B7: kimiModelInput reflects the model's DISCOVERED capabilities (text,
// image, video) into ModelDefinitionConfig.input, which accepts all four
// modalities for routing/metadata. The transport-accurate filtering to
// Array<"text" | "image"> happens in provider.ts toRuntimeModel (B7) — do NOT
// cast there. Keeping video here lets the host catalog reflect reality while
// the runtime model stays transport-safe.
function kimiModelInput(info: KimiModelInfo): ModelDefinitionConfig["input"] {
  const input: ModelDefinitionConfig["input"] = ["text"]
  if (info.supports_image_in) input.push("image")
  if (info.supports_video_in) input.push("video")
  return input
}

// Builds an identity reasoning-effort map across the OpenClaw thinking levels
// that exactly match a Kimi `valid_efforts` entry. We never invent mappings for
// levels Kimi does not define (e.g. medium/xhigh) — OpenClaw resolves those via
// `supportedReasoningEfforts` + its own clamping. AGENTS.md rule 4: never clamp
// or invent official effort values.
function buildEffortMaps(info: KimiModelInfo): {
  supportedReasoningEfforts?: string[]
  reasoningEffortMap?: Record<string, string>
  thinkingLevelMap?: Record<string, string>
} {
  const efforts = info.think_efforts?.support ? info.think_efforts.valid_efforts ?? [] : []
  if (efforts.length === 0) return {}
  // M4: reuse core isSafeEffortString (the "circular import" rationale was
  // false — validation.ts has zero adapter imports).
  const safe = efforts.filter(isSafeEffortString)
  if (safe.length === 0) return {}
  const reasoningEffortMap: Record<string, string> = {}
  const thinkingLevelMap: Record<string, string> = {}
  for (const effort of safe) {
    reasoningEffortMap[effort] = effort
    thinkingLevelMap[effort] = effort
  }
  return { supportedReasoningEfforts: safe, reasoningEffortMap, thinkingLevelMap }
}

function kimiModelCompat(info: KimiModelInfo): ModelCompatConfig {
  const efforts = buildEffortMaps(info)
  // Oracle #5: prompt caching is owned by the transport. Setting
  // supportsPromptCacheKey lets OpenClaw's openai-completions transport emit
  // `prompt_cache_key` from StreamOptions.sessionId. We do NOT manufacture a
  // key here.
  const compat: ModelCompatConfig = { supportsPromptCacheKey: true }
  if (supportsThinking(info) && info.think_efforts?.support && efforts.supportedReasoningEfforts) {
    // OpenClaw's openai-completions transport emits `reasoning_effort` from the
    // resolved thinking level when supportsReasoningEffort is true (verified in
    // the SDK transport). reasoningEffortMap is the fallback map it consults.
    compat.supportsReasoningEffort = true
    compat.supportedReasoningEfforts = efforts.supportedReasoningEfforts
    compat.reasoningEffortMap = efforts.reasoningEffortMap
  }
  return compat
}

/**
 * Projects a discovered `KimiModelInfo` into OpenClaw's `ModelDefinitionConfig`.
 *
 * Pure + host-agnostic in spirit (only the output type is OpenClaw-shaped), so
 * it is unit-testable without a live Kimi/OpenClaw. Returns `null` for unsafe
 * ids (S3 proto-pollution / control-char defense reuses core `isSafeModelId`).
 */
export function projectKimiModel(info: KimiModelInfo): ModelDefinitionConfig | null {
  // S3: reject unsafe ids before they are keyed into a catalog map.
  if (!isSafeModelId(info.id)) return null
  const efforts = buildEffortMaps(info)
  // B8: official-client convention — context length IS the completion budget.
  const contextWindow = info.context_length && info.context_length > 0 ? info.context_length : KIMI_DEFAULT_CONTEXT_WINDOW
  const model: ModelDefinitionConfig = {
    id: info.id,
    name: info.display_name ?? info.id,
    reasoning: kimiModelReasoning(info),
    input: kimiModelInput(info),
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens: contextWindow,
    compat: kimiModelCompat(info),
  }
  if (efforts.thinkingLevelMap) model.thinkingLevelMap = efforts.thinkingLevelMap
  return model
}

/** Canonical cold-fallback model (pre-discovery / no auth). Always available. */
export function buildColdKimiModel(): ModelDefinitionConfig {
  return {
    id: MODEL_ID,
    name: "Kimi Code",
    reasoning: true,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: KIMI_DEFAULT_CONTEXT_WINDOW,
    // B8: official-client convention — context length IS the completion budget.
    maxTokens: KIMI_DEFAULT_CONTEXT_WINDOW,
    // Oracle #5: the cold fallback is part of the kimi-oauth-bridge catalog, so
    // it opts into transport prompt-cache-key emission too.
    compat: { supportsPromptCacheKey: true },
  }
}

/** Builds the full provider declaration (cold or discovered). */
export function buildKimiProvider(models: readonly ModelDefinitionConfig[]): ModelProviderConfig {
  return {
    baseUrl: API_BASE_URL,
    api: KIMI_API,
    // Authorization is owned by the transport (authHeader:true re-adds the
    // resolved OAuth bearer). wrapStreamFn only sets the 7 X-Msh-* headers.
    authHeader: true,
    headers: {},
    models: [...models],
  }
}

// --- B3: scoped in-memory catalog cache ------------------------------------
//
// OpenClaw serializes catalog runs, but `prepareExtraParams`,
// `wrapStreamFn`, and `resolveDynamicModel` are SYNC hooks that must consult
// the last successful nonempty discovery for THE SAME SCOPE without
// re-fetching. Scope = (agentDir, workspaceDir) — both available in every
// hook context. The active profile is tracked in state because sync hooks do
// not receive it; profile changes must not inherit discovered metadata.

export type CatalogScopeRef = {
  agentDir?: string
  workspaceDir?: string
}

export function catalogScopeKey(ref?: CatalogScopeRef): string {
  return `${ref?.agentDir ?? ""}\0${ref?.workspaceDir ?? ""}`
}

type ScopeState = {
  discoveredCatalog: KimiModelInfo[] | undefined
  catalogById: Map<string, KimiModelInfo>
  // last-known-good PROJECTED provider for split-brain prevention (B3).
  lastKnownGoodProjected: ModelProviderConfig | undefined
  activeProfileId: string | undefined
  // S4: monotonic dispatch sequence per scope.
  dispatchSequence: number
  lastAcceptedSequence: number
  // B6: true once this scope has had a successful nonempty warm discovery.
  hasWarmCatalog: boolean
}

function newScopeState(): ScopeState {
  return {
    discoveredCatalog: undefined,
    catalogById: new Map(),
    lastKnownGoodProjected: undefined,
    activeProfileId: undefined,
    dispatchSequence: 0,
    lastAcceptedSequence: 0,
    hasWarmCatalog: false,
  }
}

// B3: supersede a scope's warm state when the host is no longer
// OAuth-authenticated for this provider. Sync hooks consult catalogById /
// hasWarmCatalog, so leaving stale warm metadata after returning an
// unauthenticated cold fallback would let resolveDynamicModel serve a stale
// warm id (and refuse the MODEL_ID cold fallback via the B6 gate) — a
// split-brain between what the host got and what the hooks expose.
// dispatchSequence / lastAcceptedSequence stay monotonic; a later successful
// discovery still satisfies seq >= lastAcceptedSequence.
function resetScopeToCold(state: ScopeState): void {
  state.discoveredCatalog = undefined
  state.catalogById.clear()
  state.lastKnownGoodProjected = undefined
  state.activeProfileId = undefined
  state.hasWarmCatalog = false
}

const scopes = new Map<string, ScopeState>()

function getScope(key: string): ScopeState {
  let state = scopes.get(key)
  if (!state) {
    state = newScopeState()
    scopes.set(key, state)
  }
  return state
}

/** Test seam: inject a catalog without a live discovery call (default scope). */
export function rememberDiscoveredCatalog(models: readonly KimiModelInfo[], ref?: CatalogScopeRef): void {
  const state = getScope(catalogScopeKey(ref))
  state.discoveredCatalog = [...models]
  state.catalogById.clear()
  for (const info of models) {
    if (isSafeModelId(info.id)) state.catalogById.set(info.id, info)
  }
  state.hasWarmCatalog = models.length > 0
  const projected = models.map(projectKimiModel).filter((m): m is ModelDefinitionConfig => m !== null)
  if (projected.length > 0) {
    state.lastKnownGoodProjected = buildKimiProvider(projected)
  }
}

export function getDiscoveredKimiModel(modelId: string, ref?: CatalogScopeRef): KimiModelInfo | undefined {
  return getScope(catalogScopeKey(ref)).catalogById.get(modelId)
}

/** B6: returns true if the scope has had a successful nonempty warm discovery. */
export function scopeHasWarmCatalog(ref?: CatalogScopeRef): boolean {
  return getScope(catalogScopeKey(ref)).hasWarmCatalog
}

/** Reset all scopes (test seam). */
export function resetCatalogScopes(): void {
  scopes.clear()
}

function coldFallbackResult(): ProviderCatalogResult {
  return { provider: buildKimiProvider([buildColdKimiModel()]) }
}

/**
 * OpenClaw `catalog.run`. Enforces the OAuth-only contract (B4), scopes the
 * cache per (agentDir, workspaceDir) (B3), allocates the S4 dispatch sequence
 * before network I/O, and prevents split-brain by keeping the sync map
 * consistent with whatever is returned to the host.
 *
 * On warm failure/empty: returns the last-known-good PROJECTED provider for
 * that scope (not cold) IF one exists; only returns cold fallback when the
 * scope has never had a successful nonempty catalog.
 */
export async function discoverKimiCatalog(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
  const scopeKey = catalogScopeKey(ctx)
  const state = getScope(scopeKey)

  // B4: OAuth-only contract. Require mode === "oauth" AND an OAuth profileId.
  // A static API key (mode api_key/none/token) or a missing profileId means
  // we return UNAUTHENTICATED cold fallback and never use a static key for
  // discovery or runtime.
  const auth = ctx.resolveProviderAuth(PROVIDER_ID)
  if (auth.mode !== "oauth" || !auth.profileId) {
    // B3: supersede prior warm state so sync hooks match the cold fallback.
    resetScopeToCold(state)
    return coldFallbackResult()
  }
  if (state.activeProfileId !== auth.profileId) {
    resetScopeToCold(state)
    state.activeProfileId = auth.profileId
  }

  // S4: allocate the dispatch sequence BEFORE network I/O (commit on success).
  const seq = ++state.dispatchSequence

  try {
    const runtimeAuth = await resolveApiKeyForProvider({
      provider: PROVIDER_ID,
      cfg: ctx.config,
      ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
      ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
      // B4: lock the OAuth profile so env/config creds can't silently override
      // the user's OAuth profile selection mid-discovery.
      profileId: auth.profileId,
      lockedProfile: true,
    })
    if (runtimeAuth?.apiKey) {
      const models = await listModels(runtimeAuth.apiKey)
      if (models.length > 0) {
        // Commit only safe (isSafeModelId-passed, nonempty) projected catalogs.
        const projected = models.map(projectKimiModel).filter((m): m is ModelDefinitionConfig => m !== null)
        if (projected.length > 0) {
          // S4: reject a result whose dispatch is older than the last accepted.
          if (auth.profileId === state.activeProfileId && seq >= state.lastAcceptedSequence) {
            state.discoveredCatalog = [...models]
            state.catalogById.clear()
            for (const info of models) {
              if (isSafeModelId(info.id)) state.catalogById.set(info.id, info)
            }
            state.lastAcceptedSequence = seq
            state.hasWarmCatalog = true
            state.lastKnownGoodProjected = buildKimiProvider(projected)
          }
          return state.lastKnownGoodProjected
            ? { provider: state.lastKnownGoodProjected }
            : coldFallbackResult()
        }
      }
    }
  } catch {
    // Fall through to last-known-good or cold fallback.
  }

  // B3: warm failure/empty — return last-known-good PROJECTED provider for
  // this scope (not cold) IF one exists; otherwise cold. The sync map stays
  // consistent with whatever we return (no split-brain).
  if (state.lastKnownGoodProjected) {
    return { provider: state.lastKnownGoodProjected }
  }
  return coldFallbackResult()
}
