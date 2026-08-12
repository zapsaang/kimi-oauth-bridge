import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { REFRESH_SAFETY_WINDOW_MS } from "./constants.ts"
import { refreshToken } from "./oauth.ts"

/**
 * Stored OAuth credential shape. Host-neutral: the standard oauth fields both
 * hosts persist. Model discovery metadata is NOT part of this type (it stays
 * in-memory only — opencode's SDK auth schema cannot durably store it, and
 * OpenClaw follows the same rule).
 */
export type OAuthAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
}

export function isOAuthAuth(value: unknown): value is OAuthAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const auth = value as Partial<OAuthAuth>
  return (
    auth.type === "oauth" &&
    typeof auth.access === "string" &&
    typeof auth.refresh === "string" &&
    typeof auth.expires === "number"
  )
}

export function isAuthExpiring(auth: OAuthAuth) {
  return auth.expires - Date.now() < REFRESH_SAFETY_WINDOW_MS
}

const REFRESH_LOCK_WAIT_MS = 15_000
const REFRESH_LOCK_POLL_MS = 100
const REFRESH_LOCK_STALE_MS = 120_000
const REFRESH_LOCK_HEARTBEAT_MS = 30_000
const REFRESH_LOCK_OWNER_FILE = "owner.json"

export type RefreshAuthOptions = {
  force?: boolean
  readLatestAuth: () => Promise<OAuthAuth | null>
  persistAuth: (auth: OAuthAuth) => Promise<void> | void
  /**
   * Directory used for the cross-process mkdir-based refresh lock. The host
   * resolves this from its own auth store location (OpenCode: the auth.json
   * dir keyed by PROVIDER_ID).
   */
  lockDir: string
  /** Host-supplied re-login hint appended to the invalid_grant error. */
  hostReloginHint: string
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isNodeError(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException).code === code
}

function sameAuth(left: OAuthAuth, right: OAuthAuth) {
  return left.access === right.access && left.refresh === right.refresh && left.expires === right.expires
}

function withInvalidGrantHint(error: unknown, hostReloginHint: string) {
  if (!(error instanceof Error) || !/invalid_grant/.test(error.message)) return error
  const next = new Error(
    `${error.message}. The token may have been rotated or revoked in another session — ${hostReloginHint}.`,
  ) as Error & { code?: string; status?: number }
  next.code = (error as Error & { code?: string }).code
  next.status = (error as Error & { status?: number }).status
  return next
}

function lockOwner(token: string) {
  return {
    token,
    pid: process.pid,
    updatedAt: Date.now(),
  }
}

async function writeLockOwner(ownerFile: string, token: string) {
  const tmpOwnerFile = `${ownerFile}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(tmpOwnerFile, JSON.stringify(lockOwner(token)), "utf8")
    await fs.rename(tmpOwnerFile, ownerFile)
  } catch (error) {
    await fs.rm(tmpOwnerFile, { force: true }).catch(() => undefined)
    throw error
  }
}

async function ownsLock(ownerFile: string, token: string) {
  try {
    const data = JSON.parse(await fs.readFile(ownerFile, "utf8")) as { token?: unknown }
    return data.token === token
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return false
    throw error
  }
}

async function removeStaleLock(lockDir: string, ownerFile: string) {
  const stat = await fs.stat(ownerFile).catch(async (error) => {
    if (!isNodeError(error, "ENOENT")) throw error
    return fs.stat(lockDir).catch((lockError) => {
      if (isNodeError(lockError, "ENOENT")) return
      throw lockError
    })
  })
  if (!stat) return true
  if (Date.now() - stat.mtimeMs <= REFRESH_LOCK_STALE_MS) return false

  const staleDir = `${lockDir}.stale.${process.pid}.${Date.now()}.${crypto.randomUUID()}`
  try {
    await fs.rename(lockDir, staleDir)
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true
    throw error
  }
  await fs.rm(staleDir, { recursive: true, force: true })
  return true
}

async function withRefreshLock<T>(lockDir: string, work: () => Promise<T>) {
  const ownerFile = path.join(lockDir, REFRESH_LOCK_OWNER_FILE)
  const ownerToken = crypto.randomUUID()
  await fs.mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS

  while (true) {
    try {
      await fs.mkdir(lockDir)
      await writeLockOwner(ownerFile, ownerToken).catch(async (error) => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error
      if (await removeStaleLock(lockDir, ownerFile)) continue
      if (Date.now() >= deadline) {
        throw new Error("kimi oauth: timed out waiting for the auth refresh lock")
      }
      await sleep(REFRESH_LOCK_POLL_MS)
    }
  }

  const heartbeat = setInterval(() => {
    writeLockOwner(ownerFile, ownerToken).catch(() => undefined)
  }, REFRESH_LOCK_HEARTBEAT_MS)
  heartbeat.unref?.()

  try {
    return await work()
  } finally {
    clearInterval(heartbeat)
    await ownsLock(ownerFile, ownerToken)
      .then((owned) => (owned ? fs.rm(lockDir, { recursive: true, force: true }) : undefined))
      .catch(() => undefined)
  }
}

/**
 * Refresh the OAuth credential under a cross-process lock, re-reading the
 * host's latest persisted credential after acquiring the lock.
 *
 * FORCED-REFRESH FIX (Oracle #9): if, under the lock, the latest persisted
 * credential differs from the one we entered with, we return it EVEN for a
 * forced refresh. A forced refresh is triggered by a 401 against the OLD
 * access token; once another process has rotated the chain, the new access
 * token is fresh and the forced request's 401 does not apply to it. Rotating
 * again would spend (and potentially invalidate) the newer refresh token.
 */
export async function refreshAuthWithLock(auth: OAuthAuth, options: RefreshAuthOptions): Promise<OAuthAuth> {
  const force = options.force ?? false
  return withRefreshLock(options.lockDir, async () => {
    const latest = await options.readLatestAuth()

    // Another writer already rotated the chain under the lock. Adopt it
    // instead of rotating again — applies to forced refreshes too (Oracle #9).
    // B2: only short-circuit when the rotated credential is NOT itself
    // expiring. A concurrent rotation could persist a credential whose access
    // token is already near/past expiry; returning it for a retry would fail
    // again immediately. When `latest` is expiring we fall through and rotate
    // (making it current) instead.
    if (latest && !sameAuth(latest, auth) && !isAuthExpiring(latest)) return latest

    const current = latest ?? auth
    if (!force && !isAuthExpiring(current)) return current

    try {
      const tokens = await refreshToken(current.refresh)
      const next: OAuthAuth = {
        type: "oauth",
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: Date.now() + tokens.expires_in * 1000,
      }
      await options.persistAuth(next)
      return next
    } catch (error) {
      const newest = await options.readLatestAuth()
      if (newest && !sameAuth(newest, current)) return newest
      throw withInvalidGrantHint(error, options.hostReloginHint)
    }
  })
}
