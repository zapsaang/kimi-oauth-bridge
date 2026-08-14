/// <reference path="./bun-test.d.ts" />

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { debugLogOutbound, resolveDebugLogPath } from "../src/core/debug-log.ts"

const DEBUG_LOG_ENV = "KIMI_OAUTH_BRIDGE_DEBUG_LOG"

let root: string | undefined
let previousDebugLog: string | undefined

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
  if (previousDebugLog === undefined) delete process.env[DEBUG_LOG_ENV]
  else process.env[DEBUG_LOG_ENV] = previousDebugLog
  previousDebugLog = undefined
})

function prepareEnvironment(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-bridge-debug-log-"))
  previousDebugLog = process.env[DEBUG_LOG_ENV]
  delete process.env[DEBUG_LOG_ENV]
  return root
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readOnlyEntry(logPath: string): Record<string, unknown> {
  const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n")
  expect(lines).toHaveLength(1)
  const parsed: unknown = JSON.parse(lines[0] ?? "")
  if (!isRecord(parsed)) throw new TypeError("debug log entry must be an object")
  return parsed
}

test("debug logging creates no file when the switch is unset", () => {
  // Given
  const home = prepareEnvironment()
  const defaultPath = path.join(home, ".kimi", "kimi-oauth-bridge-debug.log")

  // When
  debugLogOutbound("models", "GET", "https://api.kimi.com/coding/v1/models", new Headers())

  // Then
  expect(resolveDebugLogPath()).toBeUndefined()
  expect(fs.existsSync(defaultPath)).toBe(false)
})

test("debug logging appends one JSON line with a Headers User-Agent", () => {
  // Given
  const home = prepareEnvironment()
  const logPath = path.join(home, "logs", "outbound.jsonl")
  process.env[DEBUG_LOG_ENV] = logPath

  // When
  debugLogOutbound(
    "oauth",
    "POST",
    "https://auth.kimi.com/api/oauth/token",
    new Headers({ "uSeR-aGeNt": "KimiCLI/test" }),
  )

  // Then
  const entry = readOnlyEntry(logPath)
  expect(Object.keys(entry).sort()).toEqual(["method", "source", "t", "ua", "url"])
  expect(entry["t"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  expect(entry["source"]).toBe("oauth")
  expect(entry["method"]).toBe("POST")
  expect(entry["url"]).toBe("https://auth.kimi.com/api/oauth/token")
  expect(entry["ua"]).toBe("KimiCLI/test")
})

test("debug logging extracts User-Agent case-insensitively from a plain record", () => {
  // Given
  const home = prepareEnvironment()
  const logPath = path.join(home, "record.jsonl")
  process.env[DEBUG_LOG_ENV] = logPath

  // When
  debugLogOutbound("usage", "GET", "https://api.kimi.com/coding/v1/usages", {
    "UsEr-AgEnT": "KimiCLI/record",
  })

  // Then
  const entry = readOnlyEntry(logPath)
  expect(entry["ua"]).toBe("KimiCLI/record")
})

test("debug logging never writes Authorization values", () => {
  // Given
  const home = prepareEnvironment()
  const logPath = path.join(home, "secure.jsonl")
  process.env[DEBUG_LOG_ENV] = logPath

  // When
  debugLogOutbound("models", "GET", "https://api.kimi.com/coding/v1/models", {
    Authorization: "Bearer SECRET",
    "User-Agent": "KimiCLI/safe",
  })

  // Then
  expect(fs.readFileSync(logPath, "utf8")).not.toContain("SECRET")
  expect(Object.keys(readOnlyEntry(logPath)).sort()).toEqual(["method", "source", "t", "ua", "url"])
})

test("debug logging resolves 1 to the default file under the current home", () => {
  // Given
  const home = prepareEnvironment()
  const defaultPath = path.join(home, ".kimi", "kimi-oauth-bridge-debug.log")

  // When
  const resolved = resolveDebugLogPath("1", home)

  // Then
  expect(resolved).toBe(defaultPath)
})
