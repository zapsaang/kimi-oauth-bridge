/// <reference path="./bun-test.d.ts" />

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { ensureFreshStoredAuth } from "../src/adapters/opencode/refresh-impl.ts"
import { refreshAuthWithLock, type OAuthAuth } from "../src/core/refresh.ts"
import { PROVIDER_ID } from "../src/core/constants.ts"
import { installFetchMock } from "./_util/fetchMock.ts"

let mock: ReturnType<typeof installFetchMock> | undefined
let root: string | undefined
let previousXdgDataHome: string | undefined

afterEach(async () => {
  mock?.restore()
  mock = undefined
  if (root) await fs.rm(root, { recursive: true, force: true })
  root = undefined
  if (previousXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME
  } else {
    process.env.XDG_DATA_HOME = previousXdgDataHome
  }
  previousXdgDataHome = undefined
})

function authStorePath(base: string) {
  return path.join(base, "opencode", "auth.json")
}

function refreshLockPath(base: string) {
  return `${authStorePath(base)}.${PROVIDER_ID}.refresh.lock`
}

async function writeAuthStore(base: string, entry: unknown) {
  await fs.mkdir(path.dirname(authStorePath(base)), { recursive: true })
  await fs.writeFile(authStorePath(base), JSON.stringify({ [PROVIDER_ID]: entry }), "utf8")
}

test("ensureFreshStoredAuth refreshes expiring auth and persists it", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, {
    type: "oauth",
    access: "stale",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  })

  mock = installFetchMock(() => ({
    body: {
      access_token: "fresh",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 900,
    },
  }))

  const auth = await ensureFreshStoredAuth()
  expect(auth.access).toBe("fresh")
  expect(auth.refresh).toBe("refresh-2")

  const stored = JSON.parse(await fs.readFile(authStorePath(root), "utf8")) as Record<string, any>
  expect(stored[PROVIDER_ID].access).toBe("fresh")
  expect(stored[PROVIDER_ID].refresh).toBe("refresh-2")
  expect(mock.calls).toHaveLength(1)
})

test("ensureFreshStoredAuth removes stale refresh locks", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, {
    type: "oauth",
    access: "stale",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  })

  const lockDir = refreshLockPath(root)
  await fs.mkdir(lockDir)
  await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ token: "dead" }), "utf8")
  const stale = new Date(Date.now() - 180_000)
  await fs.utimes(path.join(lockDir, "owner.json"), stale, stale)
  await fs.utimes(lockDir, stale, stale)

  mock = installFetchMock(() => ({
    body: {
      access_token: "fresh",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 900,
    },
  }))

  const auth = await ensureFreshStoredAuth()
  expect(auth.access).toBe("fresh")
  expect(
    await fs
      .access(lockDir)
      .then(() => true)
      .catch(() => false),
  ).toBe(false)
  expect(mock.calls).toHaveLength(1)
})

test("ensureFreshStoredAuth does not fail when cleanup cannot verify lock ownership", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  await writeAuthStore(root, {
    type: "oauth",
    access: "stale",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  })

  mock = installFetchMock(async () => {
    await fs.writeFile(path.join(refreshLockPath(root!), "owner.json"), "{", "utf8")
    return {
      body: {
        access_token: "fresh",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 900,
      },
    }
  })

  const auth = await ensureFreshStoredAuth()
  expect(auth.access).toBe("fresh")
  expect(mock.calls).toHaveLength(1)
})

// Oracle #9 — FORCED-REFRESH FIX regression.
// Two processes can serialize around a 401: process A rotates the chain and
// persists it, then process B acquires the lock to do a *forced* refresh of
// its stale copy. B must adopt A's already-rotated credential instead of
// rotating again (which would spend/invalidate A's newer refresh token).
// The 401 that triggered B's forced refresh applied to B's OLD access token,
// not to the freshly rotated one now on disk.
test("refreshAuthWithLock: forced refresh returns the latest persisted cred when it changed, without rotating", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root

  // fetch must NEVER be called — no refresh exchange should happen.
  mock = installFetchMock(() => ({ body: { ok: true } }))

  const stale: OAuthAuth = {
    type: "oauth",
    access: "old-access",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  }
  const rotated: OAuthAuth = {
    type: "oauth",
    access: "rotated-access",
    refresh: "refresh-2",
    expires: Date.now() + 10 * 60_000,
  }

  const persisted: OAuthAuth[] = [rotated]
  const lockDir = path.join(root, "opencode", `auth.json.${PROVIDER_ID}.forced.lock`)

  const result = await refreshAuthWithLock(stale, {
    force: true,
    lockDir,
    readLatestAuth: async () => persisted[persisted.length - 1]!,
    persistAuth: (next) => {
      persisted.push(next)
    },
    hostReloginHint: "run login again",
  })

  expect(result.access).toBe("rotated-access")
  expect(result.refresh).toBe("refresh-2")
  expect(persisted).toHaveLength(1)
  expect(mock.calls).toHaveLength(0)
})

// Mirror guard for the non-forced path: when the latest changed under the
// lock, a non-forced refresh must also adopt it (this is the long-standing
// behavior the forced fix mirrors).
test("refreshAuthWithLock: non-forced refresh adopts a changed latest cred without rotating", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-auth-refresh-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root

  mock = installFetchMock(() => ({ body: { ok: true } }))

  const stale: OAuthAuth = {
    type: "oauth",
    access: "old-access",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  }
  const rotated: OAuthAuth = {
    type: "oauth",
    access: "rotated-access",
    refresh: "refresh-2",
    expires: Date.now() + 10 * 60_000,
  }
  const lockDir = path.join(root, "opencode", `auth.json.${PROVIDER_ID}.noforce.lock`)

  const result = await refreshAuthWithLock(stale, {
    force: false,
    lockDir,
    readLatestAuth: async () => rotated,
    persistAuth: () => {
      throw new Error("persistAuth must not run when the latest already rotated")
    },
    hostReloginHint: "run login again",
  })

  expect(result.access).toBe("rotated-access")
  expect(mock.calls).toHaveLength(0)
})

// B2 — the under-lock reread must NOT short-circuit-return a changed credential
// that is itself expiring. A concurrent rotation could persist a credential
// whose access token is already near/past expiry; returning it for a retry
// would fail again immediately. When `latest` differs but IS expiring, we
// must rotate (make it current).
test("B2: forced refresh with changed-but-expiring latest must rotate, not adopt", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-b2-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root

  mock = installFetchMock(() => ({
    body: { access_token: "rotated-fresh", refresh_token: "refresh-3", token_type: "Bearer", expires_in: 900 },
  }))

  const stale: OAuthAuth = {
    type: "oauth",
    access: "old-access",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  }
  // latest differs from `stale` BUT is expiring (within the safety window).
  const expiringLatest: OAuthAuth = {
    type: "oauth",
    access: "changed-but-expiring",
    refresh: "refresh-2",
    expires: Date.now() + 10_000,
  }
  const lockDir = path.join(root, "opencode", `auth.json.${PROVIDER_ID}.b2expiring.lock`)

  const result = await refreshAuthWithLock(stale, {
    force: true,
    lockDir,
    readLatestAuth: async () => expiringLatest,
    persistAuth: () => {},
    hostReloginHint: "run login again",
  })

  // Must have rotated (network call happened), NOT adopted the expiring latest.
  expect(mock.calls).toHaveLength(1)
  expect(result.access).toBe("rotated-fresh")
  expect(result.refresh).toBe("refresh-3")
})

// B2 (b): non-forced refresh where `latest` differs and is NOT expiring →
// returns latest (existing behavior preserved).
test("B2: non-forced refresh adopts a changed non-expiring latest (behavior preserved)", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-b2b-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root

  mock = installFetchMock(() => ({ body: { ok: true } }))

  const stale: OAuthAuth = {
    type: "oauth",
    access: "old-access",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  }
  const fresh: OAuthAuth = {
    type: "oauth",
    access: "new-access",
    refresh: "refresh-2",
    expires: Date.now() + 10 * 60_000,
  }
  const lockDir = path.join(root, "opencode", `auth.json.${PROVIDER_ID}.b2b.lock`)

  const result = await refreshAuthWithLock(stale, {
    force: false,
    lockDir,
    readLatestAuth: async () => fresh,
    persistAuth: () => {
      throw new Error("persistAuth must not run when latest is fresh and adopted")
    },
    hostReloginHint: "run login again",
  })

  expect(result.access).toBe("new-access")
  expect(mock.calls).toHaveLength(0)
})

// B2 (c): forced refresh where `latest` differs and is NOT expiring → returns
// latest without rotating (B1/B2 interplay preserved — the forced-refresh fix
// from Oracle #9 still works when the newer credential is genuinely fresh).
test("B2: forced refresh adopts a changed non-expiring latest (B1 interplay preserved)", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-oauth-bridge-b2c-"))
  previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root

  mock = installFetchMock(() => ({ body: { ok: true } }))

  const stale: OAuthAuth = {
    type: "oauth",
    access: "old-access",
    refresh: "refresh-1",
    expires: Date.now() - 1_000,
  }
  const fresh: OAuthAuth = {
    type: "oauth",
    access: "new-access",
    refresh: "refresh-2",
    expires: Date.now() + 10 * 60_000,
  }
  const lockDir = path.join(root, "opencode", `auth.json.${PROVIDER_ID}.b2c.lock`)

  const result = await refreshAuthWithLock(stale, {
    force: true,
    lockDir,
    readLatestAuth: async () => fresh,
    persistAuth: () => {
      throw new Error("persistAuth must not run when latest is fresh and adopted")
    },
    hostReloginHint: "run login again",
  })

  expect(result.access).toBe("new-access")
  expect(mock.calls).toHaveLength(0)
})
