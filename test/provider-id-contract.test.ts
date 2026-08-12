/// <reference path="./bun-test.d.ts" />

import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PROVIDER_ID } from "../src/core/constants.ts"
import pluginModule from "../src/index.ts"
import {
  readAuthStoreEntry,
  writeAuthStoreEntry,
} from "../src/adapters/opencode/auth-store.ts"

// Oracle #14 — PROVIDER_ID consistency contract. Every identity surface must
// equal the single shared constant so a user has ONE auth/login surface across
// hosts (and, in future, the manifest/providers). Drift here silently routes
// logins/tokens onto the wrong provider id and breaks auth.json lookups.

test("PROVIDER_ID is the canonical shared identity string", () => {
  expect(PROVIDER_ID).toBe("kimi-oauth-bridge")
  // Must not collide with the models.dev API-key entry (AGENTS.md rule 8).
  expect(PROVIDER_ID).not.toBe("kimi-for-coding")
})

test("package.json name equals PROVIDER_ID", () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { name: string }
  expect(pkg.name).toBe(PROVIDER_ID)
})

test("OpenCode entry default export id equals PROVIDER_ID", () => {
  const entry = pluginModule as { id: string; server: unknown }
  expect(entry.id).toBe(PROVIDER_ID)
})

test("auth store reads/writes the entry keyed by PROVIDER_ID", async () => {
  const prev = process.env.XDG_DATA_HOME
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const root = await fs.promises.mkdtemp(
    path.join(testDir, ".tmp-kimi-contract-"),
  )
  process.env.XDG_DATA_HOME = root
  try {
    const auth = {
      type: "oauth" as const,
      access: "contract-access",
      refresh: "contract-refresh",
      expires: Date.now() + 60_000,
    }
    const parsed: Record<string, unknown> = { other: { x: 1 } }
    const file = path.join(root, "opencode", "auth.json")
    await writeAuthStoreEntry(file, parsed, auth)

    const stored = JSON.parse(await fs.promises.readFile(file, "utf8")) as Record<
      string,
      unknown
    >
    expect(Object.keys(stored)).toEqual(expect.arrayContaining([PROVIDER_ID, "other"]))
    expect(Object.prototype.hasOwnProperty.call(stored, PROVIDER_ID)).toBe(true)

    const entry = await readAuthStoreEntry()
    expect(entry?.entry.access).toBe("contract-access")
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = prev
    }
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

// The OpenClaw manifest (openclaw.plugin.json) must use PROVIDER_ID so the
// dual-host identity stays consistent (manifest id + providers[0]).
test("openclaw.plugin.json manifest id equals PROVIDER_ID", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { id: string; providers: string[] }
  expect(manifest.id).toBe(PROVIDER_ID)
  expect(manifest.providers[0]).toBe(PROVIDER_ID)
})
