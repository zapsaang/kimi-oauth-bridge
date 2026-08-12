import { PROVIDER_ID } from "../../core/constants.ts"
import { isAuthExpiring, refreshAuthWithLock, type OAuthAuth } from "../../core/refresh.ts"
import {
  readAuth,
  readAuthStoreEntry,
  resolveAuthStorePath,
  writeAuthStoreEntry,
} from "./auth-store.ts"

// OpenCode-specific re-login hint used in the invalid_grant error message.
// Core refresh never hard-codes a host login command.
export const RELOGIN_HINT = `run \`opencode auth login ${PROVIDER_ID}\` again if it does not self-heal`

/**
 * Directory used for the cross-process refresh lock, scoped to the OpenCode
 * auth store location and {@link PROVIDER_ID}.
 */
export async function resolveRefreshLockDir(): Promise<string> {
  const authFile = await resolveAuthStorePath()
  return `${authFile}.${PROVIDER_ID}.refresh.lock`
}

/**
 * Standalone caller (used by the /kimi:usage TUI command) that refreshes an
 * expiring credential through OpenCode's auth.json file. Mirrors the plugin
 * loader's refresh semantics but persists directly to the file store.
 */
export async function ensureFreshStoredAuth(): Promise<OAuthAuth> {
  const store = await readAuthStoreEntry()
  if (!store) {
    throw new Error(`Kimi is not authenticated. Run \`opencode auth login ${PROVIDER_ID}\` first.`)
  }
  if (!isAuthExpiring(store.entry)) return store.entry

  const lockDir = await resolveRefreshLockDir()
  return refreshAuthWithLock(store.entry, {
    readLatestAuth: async () => (await readAuth()) ?? null,
    persistAuth: async (auth) => {
      const latestStore = await readAuthStoreEntry()
      const file = latestStore?.file ?? store.file
      const parsed = latestStore?.parsed ?? store.parsed
      await writeAuthStoreEntry(file, parsed, auth)
    },
    lockDir,
    hostReloginHint: RELOGIN_HINT,
  })
}
