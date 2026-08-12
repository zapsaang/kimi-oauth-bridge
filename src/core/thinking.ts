import type { KimiModelInfo } from "./oauth.ts"
import { isSafeEffortString } from "./validation.ts"

export type ThinkingType = "enabled" | "disabled"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function asThinking(value: unknown): { type: ThinkingType } | undefined {
  const record = asRecord(value)
  if (!record) return
  const type = record.type
  if (type !== "enabled" && type !== "disabled") return
  return { type }
}

export function pickEffort(options: Record<string, unknown> | undefined) {
  const effort = options?.reasoning_effort ?? options?.reasoningEffort
  return typeof effort === "string" ? effort : undefined
}

export function supportsThinking(info: KimiModelInfo) {
  return info.supports_reasoning === true && info.supports_thinking_type !== "no"
}

export type ThinkingConfig = {
  reasoning: boolean
  options: Record<string, unknown>
  variants: Record<string, Record<string, unknown>>
}

/**
 * Computes thinking variants/defaults from a single model's metadata.
 *
 * - no reasoning support or `supports_thinking_type: "no"` => none
 * - `"only"` => always on; expose a single `on` variant so the always-on state
 *   is VISIBLE in the host picker (no `off`, no fake effort levels)
 * - `"both"` without efforts => off + on
 * - efforts supported => exactly the server `valid_efforts` + `default_effort`,
 *   preserving official values (e.g. K3 `"max"`) unchanged
 *
 * Host-neutral policy: callers feed it the selected catalog model plus the
 * configured options/variants. Uses {@link isSafeEffortString} so an effort
 * value can never become a poisoned variant key.
 */
export function thinkingConfig(
  info: KimiModelInfo,
  configuredOptions: Record<string, unknown> | undefined = undefined,
): ThinkingConfig {
  const options = { ...configuredOptions }
  delete options.reasoning_effort
  delete options.reasoningEffort
  delete options.thinking

  if (!supportsThinking(info)) {
    const variants: Record<string, Record<string, unknown>> = {}
    return {
      reasoning: false,
      options,
      variants,
    }
  }

  if (info.think_efforts?.support) {
    const variants: Record<string, Record<string, unknown>> = {}
    for (const effort of info.think_efforts.valid_efforts ?? []) {
      // S3: safe-key check at the variant keying site.
      if (!isSafeEffortString(effort)) continue
      variants[effort] = {
        reasoning_effort: effort,
        thinking: { type: "enabled" },
      }
    }
    return {
      reasoning: true,
      options: {
        ...options,
        thinking: { type: "enabled" },
        ...(info.think_efforts.default_effort ? { reasoning_effort: info.think_efforts.default_effort } : {}),
      },
      variants,
    }
  }

  if (info.supports_thinking_type === "both") {
    return {
      reasoning: true,
      options: {
        ...options,
        thinking: { type: "enabled" },
      },
      variants: {
        off: { thinking: { type: "disabled" } },
        on: { thinking: { type: "enabled" } },
      },
    }
  }

  // `"only"` (always-thinking, no efforts): expose a single `on` variant so
  // the always-on state is VISIBLE in the host picker — without inventing fake
  // effort levels (AGENTS rule 4). `on` is the one real state (K2.7 cannot be
  // turned off), so the picker surfaces "thinking: on" instead of nothing.
  return {
    reasoning: true,
    options: {
      ...options,
      thinking: { type: "enabled" },
    },
    variants: {
      on: { thinking: { type: "enabled" } },
    },
  }
}

export function selectedMetadataEffort(
  info: KimiModelInfo,
  modelOptions: Record<string, unknown> | undefined,
  variantOptions: Record<string, unknown> | undefined,
) {
  const selected = pickEffort(variantOptions) ?? pickEffort(modelOptions)
  const defaultEffort = info.think_efforts?.default_effort
  const validEfforts = info.think_efforts?.valid_efforts ?? []
  if (validEfforts.length === 0) return selected ?? defaultEffort
  if (selected && validEfforts.includes(selected)) return selected
  if (defaultEffort && validEfforts.includes(defaultEffort)) return defaultEffort
  return validEfforts[0]
}
