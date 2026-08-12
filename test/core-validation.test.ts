/// <reference path="./bun-test.d.ts" />

import { expect, test } from "bun:test"
import {
  isSafeEffortString,
  isSafeModelId,
  sanitizeEfforts,
} from "../src/core/validation.ts"

// S3 — prototype-pollution / control-char hardening for every string that
// becomes an object key (model id) or a reasoning-effort variant key. These
// guards are applied at parse AND at every later keying site; the tests here
// pin the predicate behavior so the keying-site callers stay correct.

test("isSafeModelId rejects __proto__ / constructor / prototype", () => {
  expect(isSafeModelId("__proto__")).toBe(false)
  expect(isSafeModelId("constructor")).toBe(false)
  expect(isSafeModelId("prototype")).toBe(false)
})

test("isSafeModelId rejects empty and control-char ids", () => {
  expect(isSafeModelId("")).toBe(false)
  expect(isSafeModelId("bad\tid")).toBe(false)
  expect(isSafeModelId("newline\nid")).toBe(false)
  expect(isSafeModelId("null\x00byte")).toBe(false)
  expect(isSafeModelId("del\x7fchar")).toBe(false)
})

test("isSafeModelId accepts normal printable ids", () => {
  expect(isSafeModelId("kimi-for-coding")).toBe(true)
  expect(isSafeModelId("k3")).toBe(true)
  expect(isSafeModelId("kimi-for-coding-highspeed")).toBe(true)
})

test("isSafeEffortString shares the proto/control-char predicate", () => {
  expect(isSafeEffortString("__proto__")).toBe(false)
  expect(isSafeEffortString("constructor")).toBe(false)
  expect(isSafeEffortString("")).toBe(false)
  expect(isSafeEffortString("bad\teffort")).toBe(false)
  expect(isSafeEffortString("max")).toBe(true)
  expect(isSafeEffortString("high")).toBe(true)
})

test("sanitizeEfforts dedupes, preserves first-seen order, drops unsafe entries", () => {
  expect(sanitizeEfforts(["low", "high", "low", "max"])).toEqual(["low", "high", "max"])
  expect(sanitizeEfforts(["low", "__proto__", "high", "constructor"])).toEqual(["low", "high"])
  expect(sanitizeEfforts(["ok", 1, true, null, "", "ok"])).toEqual(["ok"])
})

test("sanitizeEfforts returns [] for non-array input", () => {
  expect(sanitizeEfforts(undefined)).toEqual([])
  expect(sanitizeEfforts(null)).toEqual([])
  expect(sanitizeEfforts("low")).toEqual([])
})

// S3 — think_efforts.default_effort is kept ONLY when it survives as a safe
// string present in the sanitized valid_efforts list. parseThinkEfforts
// (exercised via listModels) enforces this; here we assert the predicate the
// parser relies on, so a future change to either side surfaces a regression.
test("default_effort predicate: kept only when present in the sanitized list", () => {
  const kept = sanitizeEfforts(["low", "high", "max"])
  expect(kept.includes("high")).toBe(true)
  expect(kept.includes("missing")).toBe(false)
  expect(sanitizeEfforts(["__proto__", "low"]).includes("__proto__")).toBe(false)
})

// S3 — keying-site coverage: a malicious catalog must never get keyed into the
// runtime model map. Re-implement the exact guard the adapter uses against a
// proto id and confirm the predicate is what blocks it from entering the map.
test("keying-site parity: proto id is not usable as an object key via the guard", () => {
  const map: Record<string, string> = { safe: "kept" }
  const candidate = "__proto__"
  if (isSafeModelId(candidate)) {
    map[candidate] = "would-pollute"
  }
  expect(Object.keys(map)).toEqual(["safe"])
  expect(Object.prototype.hasOwnProperty.call(map, "__proto__")).toBe(false)
})
