// Host-neutral input-hardening helpers (S3 proto-pollution defense).
//
// These predicates guard EVERY site where a server- or user-supplied string is
// used as an object key (model id, effort string). Rejecting unsafe keys here
// prevents `__proto__`/`constructor`/`prototype` poisoning and control-char
// injection before the value ever reaches a map/catalog.
//
// CORE module: zero host imports.

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function isPrintableNonEmptyString(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value.length === 0) return false
  // Reject C0 control chars (0x00-0x1f) and DEL (0x7f); these break header
  // values and object keys alike.
  if (/[\x00-\x1f\x7f]/.test(value)) return false
  if (UNSAFE_KEYS.has(value)) return false
  return true
}

/**
 * Guards any string used as a model id object key. Rejects empty, control-char,
 * and prototype-polluting ids (`__proto__`/`constructor`/`prototype`) before
 * they are keyed into a catalog/config map.
 */
export function isSafeModelId(value: unknown): value is string {
  return isPrintableNonEmptyString(value)
}

/**
 * Same predicate as {@link isSafeModelId}, scoped to reasoning-effort strings
 * that become variant keys / wire `reasoning_effort` values.
 */
export function isSafeEffortString(value: unknown): value is string {
  return isPrintableNonEmptyString(value)
}

/**
 * De-duplicates and filters a raw `valid_efforts` array down to safe, unique
 * strings. Non-strings, control chars, empty entries, and proto-polluting
 * values are dropped; order of first occurrence is preserved.
 */
export function sanitizeEfforts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (!isSafeEffortString(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
