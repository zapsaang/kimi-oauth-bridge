import type { KimiModelInfo } from "./oauth.ts"
import { MODEL_ID } from "./constants.ts"
import {
  asThinking,
  pickEffort,
  selectedMetadataEffort,
  supportsThinking,
  type ThinkingType,
} from "./thinking.ts"

export type KimiBodyFields = {
  prompt_cache_key?: string
  thinking?: { type: ThinkingType }
  reasoning_effort?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export type ResolveKimiBodyFieldsInput = {
  /** Selected model id, used to recognize the canonical cold K2.7 fallback. */
  modelID?: string
  modelOptions?: Record<string, unknown>
  variantOptions?: Record<string, unknown>
  info?: KimiModelInfo
  /**
   * Explicit prompt-cache key. Attached ONLY when the caller passes one (host
   * decides whether to scope cache reuse to a session id).
   */
  promptCacheKey?: string
}

/**
 * Resolves the Kimi-specific chat request body fields (thinking +
 * reasoning_effort; prompt_cache_key only when an explicit key is supplied)
 * for a single model selection.
 *
 * Host-neutral: it does NOT know about opencode's hook input shape or any
 * provider-id gating. The host adapter performs provider/catalog gating and
 * then calls this with the resolved model options, variant options, optional
 * catalog metadata, and optional prompt-cache key.
 */
export function resolveKimiBodyFields(input: ResolveKimiBodyFieldsInput): KimiBodyFields {
  const modelOptions = asRecord(input.modelOptions)
  const variantOptions = asRecord(input.variantOptions)
  const info = input.info

  const fields: KimiBodyFields = {}
  if (input.promptCacheKey) fields.prompt_cache_key = input.promptCacheKey

  // The metadata-free canonical cold fallback is the always-thinking K2.7
  // entry, so stale configured effort/variant choices cannot disable it.
  if (!info && input.modelID === MODEL_ID) {
    fields.thinking = { type: "enabled" }
    return fields
  }

  if (info) {
    if (!supportsThinking(info)) return fields

    if (info.think_efforts?.support) {
      const effort = selectedMetadataEffort(info, modelOptions, variantOptions)
      if (effort) fields.reasoning_effort = effort
      fields.thinking = { type: "enabled" }
      return fields
    }

    if (info.supports_thinking_type === "both") {
      const thinking = asThinking(variantOptions?.thinking) ?? asThinking(modelOptions?.thinking)
      fields.thinking = thinking ?? (pickEffort(variantOptions) === "off" ? { type: "disabled" } : { type: "enabled" })
      return fields
    }

    fields.thinking = { type: "enabled" }
    return fields
  }

  // No catalog metadata (cold fallback / pre-discovery): apply the legacy
  // effort matrix derived purely from model + variant options.
  const thinking = asThinking(variantOptions?.thinking) ?? asThinking(modelOptions?.thinking)
  const rawEffort = pickEffort(variantOptions) ?? pickEffort(modelOptions)

  if (rawEffort === "auto") return fields
  if (rawEffort === "off") {
    fields.thinking = { type: "disabled" }
    return fields
  }
  if (rawEffort) fields.reasoning_effort = rawEffort
  fields.thinking = thinking ?? { type: "enabled" }
  return fields
}

export function applyKimiBodyFields(target: Record<string, unknown>, fields: KimiBodyFields) {
  if (fields.prompt_cache_key) {
    target.prompt_cache_key = fields.prompt_cache_key
  } else {
    delete target.prompt_cache_key
  }
  if (fields.reasoning_effort) {
    target.reasoning_effort = fields.reasoning_effort
  } else {
    delete target.reasoning_effort
  }
  delete target.reasoningEffort
  if (fields.thinking) {
    target.thinking = fields.thinking
    return
  }
  delete target.thinking
}

export function hasKimiBodyFields(fields: KimiBodyFields) {
  return Boolean(fields.prompt_cache_key || fields.reasoning_effort || fields.thinking)
}
