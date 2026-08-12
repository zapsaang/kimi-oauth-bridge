// Host-neutral identity + wire constants. Values mirror kimi-cli v1.49.0 1:1.
// When upstream bumps, update here and nothing else should hard-code these
// strings.
//
// Source of truth: research/kimi-cli/src/kimi_cli/constant.py,
// research/kimi-cli/src/kimi_cli/auth/oauth.py
//
// This module is CORE: it must have ZERO imports of `@opencode-ai/plugin`,
// `@opentui`, or `openclaw/*`. Only host-neutral constants live here.
//
// NOTE: client_id is a public constant shipped inside the official CLI, not a
// secret.

export const KIMI_CLI_VERSION = "1.49.0"
// Upstream: research/kimi-cli/src/kimi_cli/constant.py get_user_agent() →
// f"KimiCLI/{get_version()}". This must match verbatim — Moonshot's
// `kimi-for-coding` backend 403s on any other UA prefix
// ("access_terminated_error: only available for Coding Agents").
export const USER_AGENT_PREFIX = "KimiCLI"
export const USER_AGENT = `${USER_AGENT_PREFIX}/${KIMI_CLI_VERSION}`

export const OAUTH_HOST = "https://auth.kimi.com"
export const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`
export const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`
export const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
// RFC 8628 §3.1 uses the underscore form `device_code` in the URN. kimi-cli
// sends the same. (A previous draft of the refactor accidentally used a
// hyphen here; the constants test guards against that regression.)
export const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
export const OAUTH_REFRESH_GRANT = "refresh_token"

export const API_BASE_URL = "https://api.kimi.com/coding/v1"

// Wire model id (the value sent in the chat request `model` field), NOT a
// provider id. Left unchanged: it is the real Kimi API model id used as the
// canonical cold fallback before authenticated discovery replaces the
// in-memory catalog.
export const MODEL_ID = "kimi-for-coding"

// Provider identity. Both hosts (OpenCode + OpenClaw) deliberately share this
// single identity so users have one auth/login surface across hosts
// (Oracle #14). Intentionally NOT "kimi-for-coding" — models.dev publishes an
// entry under that id (static KIMI_API_KEY flow via a different SDK / auth
// shape), and sharing the id would surface two auth methods under one login
// entry and silently route users onto the wrong integration path.
export const PROVIDER_ID = "kimi-oauth-bridge"

// Refresh a bit before the server-reported expiry so we never race it.
export const REFRESH_SAFETY_WINDOW_MS = 60_000

// Fallback context window used when Kimi's `/coding/v1/models` discovery
// either has not happened yet (cold fallback) or does not report a
// `context_length` for a model.
//
// Value: the documented non-entitled Kimi K2.7 coding context window (256000
// tokens). This is the only verified window we have; discovered models whose
// `context_length` is present always override it. Oracle #7: do NOT invent
// pricing/caps — this is a documented platform value, not a guess.
export const KIMI_DEFAULT_CONTEXT_WINDOW = 256_000

// NOTE: maxTokens is NOT defined anywhere in core. It is an OpenClaw-specific
// projection concern (the openai-completions transport materializes it into the
// request body). Core must stay host-neutral. The OpenClaw adapter derives it
// per-model from the discovered context length (official-client convention —
// context length IS the completion budget); there is no fallback constant.
// B8 regression guards live in test/constants.test.ts.

// The seven X-Msh-* + UA wire header NAMES kimi-cli sends on every request
// (research/kimi-cli/src/kimi_cli/auth/oauth.py _common_headers). Exported as
// constants so both hosts reference the exact wire names.
export const HEADER_USER_AGENT = "User-Agent"
export const HEADER_MSH_PLATFORM = "X-Msh-Platform"
export const HEADER_MSH_VERSION = "X-Msh-Version"
export const HEADER_MSH_DEVICE_NAME = "X-Msh-Device-Name"
export const HEADER_MSH_DEVICE_MODEL = "X-Msh-Device-Model"
export const HEADER_MSH_DEVICE_ID = "X-Msh-Device-Id"
export const HEADER_MSH_OS_VERSION = "X-Msh-Os-Version"
