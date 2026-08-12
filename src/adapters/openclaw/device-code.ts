// OpenClaw adapter: device-code auth method.
//
// Mirrors the shipped xAI device-code flow but drives it through the host-neutral
// core (`startDeviceAuth` + `pollDeviceToken`) so the OAuth wire shape matches
// kimi-cli exactly. The only OpenClaw-specific concern is presenting the
// verification URI through the host prompter and returning a
// `ProviderAuthResult` via `buildOauthProviderAuthResult`.

import type { ProviderAuthContext, ProviderAuthMethod, ProviderAuthResult } from "openclaw/plugin-sdk/core"
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth-result"

import { MODEL_ID, PROVIDER_ID } from "../../core/constants.ts"
import { pollDeviceToken, startDeviceAuth } from "../../core/oauth.ts"

export const KIMI_DEVICE_CODE_METHOD_ID = "device-code"
export const KIMI_DEVICE_CODE_CHOICE_ID = "kimi-oauth-bridge-device-code"

/**
 * Runs the Kimi OAuth device-code login against the host prompter.
 *
 * Uses core `startDeviceAuth` / `pollDeviceToken` (the same code path the
 * OpenCode adapter uses) so the device_authorization + token polling wire shape
 * is identical across hosts. Tokens enter OpenClaw's auth-profile store via the
 * returned `ProviderAuthResult.profiles[].credential` — we do NOT persist
 * tokens anywhere ourselves (Oracle #8).
 */
export async function loginKimi(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const progress = ctx.prompter.progress("Starting Kimi login...")
  try {
    progress.update("Requesting Kimi device code...")
    const device = await startDeviceAuth()
    const browserUrl = device.verification_uri_complete ?? device.verification_uri
    const expiresInMinutes = Math.max(1, Math.round((device.expires_in ?? 600) / 60))

    await ctx.prompter.note(
      [
        ctx.isRemote
          ? "Open this URL in your LOCAL browser and enter the code below."
          : "Open this URL in your browser and enter the code below.",
        `URL: ${browserUrl}`,
        `Code: ${device.user_code}`,
        `Code expires in ${expiresInMinutes} minutes. Never share it.`,
      ].join("\n"),
      "Kimi Login",
    )

    if (!ctx.isRemote) {
      try {
        await ctx.openUrl(browserUrl)
      } catch {
        // URL open is best-effort; the note above already shows it.
      }
    }

    progress.update("Waiting for Kimi device authorization...")
    const tokens = await pollDeviceToken(device)

    progress.stop("Kimi login complete")
    return buildOauthProviderAuthResult({
      providerId: PROVIDER_ID,
      defaultModel: MODEL_ID,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000,
    })
  } catch (err) {
    progress.stop("Kimi login failed")
    throw new Error(`Kimi login failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
}

/**
 * The device-code auth method surfaced under the kimi-oauth-bridge provider.
 * `kind: "device_code"` matches OpenClaw's `ProviderAuthKind` for RFC 8628 flows.
 */
export function createKimiDeviceCodeAuthMethod(): ProviderAuthMethod {
  return {
    id: KIMI_DEVICE_CODE_METHOD_ID,
    label: "Kimi device code",
    hint: "Sign in to Kimi Code by pairing a device code in your browser",
    kind: "device_code",
    wizard: {
      choiceId: KIMI_DEVICE_CODE_CHOICE_ID,
      choiceLabel: "Kimi device-code login",
      choiceHint: "Pair your Kimi Code account in a browser with a device code",
      groupId: PROVIDER_ID,
      groupLabel: "Kimi Code (OAuth)",
      groupHint: "Official Kimi Code OAuth device flow",
      methodId: KIMI_DEVICE_CODE_METHOD_ID,
    },
    run: async (ctx) => loginKimi(ctx),
  }
}
