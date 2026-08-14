# AGENTS.md — working notes for coding agents (and humans)

This file is the single source of truth for any AI agent (or human) modifying this repo. Read it top-to-bottom before touching code. If something you learn here contradicts what you see in the code, the **code wins** — update this file in the same commit.

User-facing install / usage documentation lives in [`README.md`](./README.md). Do **not** duplicate it here.

---

### Purpose

One plugin, one job: make `opencode` talk to Kimi Code's authenticated catalog **exactly the way the official `kimi-cli` does**. Everything in this repo exists to minimize drift from upstream kimi-cli.

### The one rule that matters

> Moonshot's coding backend is entitlement-sensitive: the model-name string alone is not the whole story.

Every design decision here follows from that: we do device-flow OAuth to mirror official `kimi-cli`, we do not accept API keys in this plugin, and we do not let the upstream SDK attach its own Authorization header.

### Non-goals

- No support for models outside the authenticated Kimi Code `/coding/v1/models` catalog. opencode already handles other Moonshot / Baseten / Alibaba-CN / etc. entries itself.
- No support for static API keys. Users who want that can use a different opencode provider entry.
- No custom SSE parser, tool-call normalizer, or message rewriter. `@ai-sdk/openai-compatible` already does SSE/`reasoning_content` correctly.

---

### Architecture

The code is split into a **host-neutral core** (`src/core/*`) and **host adapters** (`src/adapters/opencode/*` for OpenCode, `src/adapters/openclaw/*` for OpenClaw). The core has ZERO imports of `@opencode-ai/plugin`, `@opentui`, `openclaw/*`, or any host SDK, so both hosts reuse it. Each host adapter owns its host-specific concerns. The repo root `src/index.ts` / `src/tui.tsx` are thin re-exports so OpenCode finds the default `PluginModule` at the documented entry (raw `.ts`, no build step). The OpenClaw entry (`src/adapters/openclaw/index.ts`) is built to `dist/openclaw.js` with `openclaw` externalized.

Each source file has one job. Do not add new files unless the existing ones genuinely can't hold a new concern.

| File | Responsibility |
|------|----------------|
| `src/core/constants.ts` | Pinned strings that must mirror upstream kimi-cli (version, endpoints, client id) + `PROVIDER_ID` shared identity + the 7 `X-Msh-*` / UA header name constants. Host-neutral. |
| `src/core/headers.ts` | The seven `X-Msh-*` / UA headers + the persistent `~/.kimi/device_id` file. `node:*` only. |
| `src/core/oauth.ts` | Device-code start, device-code poll, refresh-token exchange, `GET /coding/v1/models` discovery + `KimiModelInfo` parse. |
| `src/core/validation.ts` | `isSafeModelId` / `isSafeEffortString` / `sanitizeEfforts` — S3 proto-pollution / control-char guards applied at every keying site. |
| `src/core/thinking.ts` | Host-neutral thinking policy: `thinkingConfig` derives variants/defaults from a model's metadata. |
| `src/core/body-fields.ts` | Generic Kimi body mutation (`resolveKimiBodyFields` / `applyKimiBodyFields`): thinking + `reasoning_effort`; `prompt_cache_key` only when the caller passes one. |
| `src/core/usage.ts` | Fetch + parse Kimi subscription usage (`/coding/v1/usages`); takes a host-supplied re-login hint. |
| `src/core/refresh.ts` | Lock-based token refresh with cross-instance coordination, injected read/persist callbacks, and the Oracle #9 forced-refresh fix. |
| `src/adapters/opencode/auth-store.ts` | Read/write opencode's `auth.json` entries, keyed by `PROVIDER_ID`. |
| `src/adapters/opencode/refresh-impl.ts` | Wires OpenCode's auth store into `core/refresh.ts`; `ensureFreshStoredAuth` for standalone callers (TUI). |
| `src/adapters/opencode/index.ts` | OpenCode plugin entry. Async `config(cfg)` catalog projection (authoritative replacement for OpenCode 1.18.5 non-Models.dev providers), compatible-host `provider.models` projection, the private `x-opencode-kimi-*` transport headers, device-code auth, `auth.loader`, and `chat.headers` / `chat.params` hooks. |
| `src/adapters/opencode/tui.tsx` | TUI slash command `/kimi:usage` — renders usage in an opencode dialog. |
| `src/adapters/openclaw/index.ts` | **OpenClaw** plugin entry (`definePluginEntry`). `id === PROVIDER_ID`; registers the OpenClaw provider. Separate from the OpenCode entry so each host resolves its own module. Built to `dist/openclaw.js` with `openclaw` externalized. |
| `src/adapters/openclaw/provider.ts` | The OpenClaw `ProviderPlugin`: `refreshOAuth` (wraps core `refreshToken`), `wrapStreamFn` (injects the 7 `X-Msh-*` headers, strips caller Authorization by case-insensitive comparison, applies the Kimi `thinking` body field), `prepareExtraParams` (declarative reasoning_effort/thinking via core body-fields), `resolveDynamicModel` (catalog-or-cold gated on scope warmth, never synthesizes), and pure helpers (`refreshKimiOAuth`, `resolveKimiOpenClawExtraParams`, `toRuntimeModel`). Provider-level `headers` in `buildKimiProvider` carry the same fingerprint as a fallback so transport paths not covered by `wrapStreamFn` (e.g. `wrapSimpleCompletionStreamFn`, which we do not implement) still send the Kimi fingerprint; the wrapper's caller-wins precedence keeps per-request values authoritative. |
| `src/adapters/openclaw/device-code.ts` | OpenClaw device-code `ProviderAuthMethod` (`kind: "device_code"`). Drives core `startDeviceAuth` + `pollDeviceToken` and returns a `ProviderAuthResult` via `buildOauthProviderAuthResult`. |
| `src/adapters/openclaw/catalog.ts` | OpenClaw catalog discovery + projection. Enforces OAuth-only auth (B4), scopes the in-memory catalog cache per `(agentDir, workspaceDir, profileId)` (B3), allocates the S4 dispatch sequence before network I/O, and prevents split-brain or cross-profile catalog reuse on failure. Reuses core `listModels` + `isSafeModelId` + `isSafeEffortString` + `supportsThinking`. `buildKimiProvider` also sets provider-level fingerprint headers (`kimiHeaders()`) as a transport-level fallback for request paths `wrapStreamFn` does not cover. |
| `src/index.ts` | Root entry: re-exports the OpenCode adapter's default `PluginModule`. |
| `src/tui.tsx` | Root TUI entry: re-exports the OpenCode adapter's TUI module. |

Data flow on a chat request:

1. opencode asks the `@ai-sdk/openai-compatible` provider for a language model.
2. Before instantiating it, opencode calls our `auth.loader`. We return `{ apiKey, fetch }`.
3. The SDK uses our `fetch` for every HTTP call (models, chat, whatever).
4. Our `fetch` calls `ensureFresh()` → prefers the live opencode auth-store entry over stale `OPENCODE_AUTH_CONTENT` snapshots → maybe refreshes (sharing one in-flight promise in-process and a lock across plugin instances so they don't race the same refresh token) → lazily discovers `/coding/v1/models` when needed → sets Authorization + the seven `X-Msh-*` headers → on 401 refreshes once and retries. Successful nonempty discovery atomically replaces the in-memory catalog; failed or empty discovery leaves the cold fallback or prior warm catalog alone.
5. Separately, opencode runs `chat.headers` and `chat.params`. `chat.headers` computes `thinking`, `reasoning_effort`, and `prompt_cache_key` from the selected model's in-memory catalog metadata, options, and variant, then passes them to `loader.fetch` via private `x-opencode-kimi-*` headers. `loader.fetch` strips those headers and injects the wire fields into the JSON body without changing the selected `model` id. `chat.params` mirrors the same keys into `output.options` only as a forward-compat fallback if opencode later fixes its openai-compatible providerOptions namespace mismatch.

### OpenClaw refresh & 401

The OpenClaw adapter (`src/adapters/openclaw/*`) reuses the same core, but the host owns different seams, so the refresh/retry story is NOT identical to OpenCode:

- **Refresh:** `refreshOAuth` (in `provider.ts`) is the SINGLE refresh path. OpenClaw calls it when the resolved OAuth credential is near/past expiry. It wraps core `refreshToken({refresh})` and maps the result back to OpenClaw's `OAuthCredential` shape, preserving every field the host stored on the profile. We do NOT implement a plugin-side refresh lock or in-flight promise — OpenClaw's auth-profile machinery owns cross-instance coordination here (it already serializes refreshes per profile).
- **Catalog auth:** discovery resolves the bearer through `resolveApiKeyForProvider(PROVIDER_ID, { lockedProfile: true })` (mirrors xAI), participating in the host's lock/refresh machinery. We never read tokens from a plugin-owned store — there is no `auth-store.ts` for OpenClaw.
- **401 retry:** we do NOT implement a refresh-and-retry inside `wrapStreamFn`. OpenCode's loader does an in-flight 401→refresh→retry once; that exact-same-request 401-retry is **host-dependent and UNVERIFIED** for OpenClaw. Rely on `refreshOAuth` for expiry-based refresh, and treat same-request 401 handling as a live-integration probe item. If a 401 surfaces mid-session after the token's nominal expiry, OpenClaw's expiry-refresh covers it; a 401 on a still-valid token (server-side revocation) is not yet handled and should be verified against the host's failover/retry policy.
- **Body fields:** OpenClaw's openai-completions transport emits `reasoning_effort` itself from the catalog model's `compat.supportsReasoningEffort` + `reasoningEffortMap`, and emits `prompt_cache_key` from `compat.supportsPromptCacheKey` + the stream `sessionId`. The Kimi-specific `thinking: {type}` field is NOT auto-emitted by the transport, so `wrapStreamFn` applies it to the payload via `onPayload` (mirrors the deprecated OpenClaw `moonshot-thinking` stream wrapper and the OpenCode adapter's body injection). `prepareExtraParams` returns the declarative `reasoning_effort`/`thinking` pair (no `prompt_cache_key`) for visibility/testability.

### Contracts to keep intact

These are the invariants that, if broken, silently route requests onto the wrong auth/backend path or produce fingerprint-based throttling. Do not "clean them up" without reading the linked upstream.

1. **`X-Msh-Version` and `User-Agent` must track `kimi-cli`.** Bumping involves exactly one line in `src/core/constants.ts`. See upstream `research/kimi-cli/src/kimi_cli/constant.py`. The UA prefix is `KimiCLI/` (not `KimiCodeCLI/`) — Moonshot's `kimi-for-coding` backend 403s with `access_terminated_error: only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code…` on any other prefix. Likewise, `X-Msh-Device-Model` must mirror kimi-cli's `_device_model()` shape, including the Darwin/Windows special cases (`macOS <version> <arch>`, `Windows 10/11 <arch>`, Linux `"{system} {release} {machine}"`) — NOT just `{arch}` — and `X-Msh-Os-Version` is the kernel build string from `os.version()`, NOT `"{type} {release}"`. Tested live against `api.kimi.com/coding/v1` on 2026-04-17 — any of those three fields off-spec → 403.
2. **`X-Msh-Device-Id` must be stable across runs.** Never regenerate a fresh UUID at import time. `getDeviceId()` reads/writes `~/.kimi/device_id`; that path is shared with `kimi-cli` on purpose.
3. **`Authorization` header is owned by `loader.fetch`.** Anything else (opencode core, the SDK, future hooks) must be overridden. Our `loader` deletes both `authorization` and `Authorization` before setting its own. The private `x-opencode-kimi-*` transport headers are also consumed and stripped there; they must never leak upstream.
4. **Thinking fields and variants are model metadata, not a global matrix.** For a discovered model with no reasoning support or `supports_thinking_type: "no"`, emit no `thinking`/`reasoning_effort` fields and expose no thinking variants. `"only"` (always-thinking) is always enabled: it exposes a single `on` variant so the always-on state is visible in the host picker (no `off`, no fake effort levels), and a stale configured `off` variant is neutralized to `on`. `"both"` without effort support exposes only `off` and `on`. When `think_efforts.support` is true, expose exactly `valid_efforts`, use `default_effort`, and send the selected value unchanged (for example K3 `max` stays `"max"`). Never invent static levels or clamp an official value. K2.7 standard/highspeed are always-thinking entries, so obsolete configured off/auto/level variants must be removed or neutralized. Compute this from the selected catalog model plus `input.model.options` and `input.model.variants[input.message.model.variant]`, not from `input.provider.info.id`. The `@opencode-ai/plugin` `ProviderContext` type claims `.info.id` exists, but the runtime shape opencode passes (see `research/opencode/packages/opencode/src/session/llm.ts::stream`, ~line 168, `provider: item`) is the flat `ProviderConfig` (`.id`). `input.model.providerID` is what every first-party plugin uses and avoids the runtime crash "undefined is not an object (evaluating 'input.provider.info.id')".

5. **`prompt_cache_key` only for current catalog models under this provider.** Attach it to every id in the in-memory `kimi-oauth-bridge` catalog (and the canonical cold fallback), never to another provider or an unmanaged sibling model. The actual wire injection happens in `loader.fetch`.
6. **The selected model id is authoritative on the wire.** `GET /coding/v1/models` yields the full entitled catalog, not a replacement slug for a singleton alias. In OpenCode 1.18.5, non-Models.dev providers are skipped by `provider.models`; the async `config(cfg)` hook must therefore read live OAuth, refresh/discover, and eagerly replace `cfg.provider[PROVIDER_ID].models` with every returned exact id before provider initialization. `config(cfg)` builds fresh config-format models directly from that catalog. On compatible hosts, `provider.models` uses an available configured provider model as an immutable template and patches its runtime metadata. Both paths preserve the exact wire ids and do not mutate caller-owned input; the JSON request body retains the exact selected id. Metadata remains in memory only. A successful nonempty response removes stale configured ids; a cold failure leaves configured `MODEL_ID = "kimi-for-coding"` intact, while a warm failure preserves the last successful catalog. Do not substitute Moonshot Platform ids.
7. **Auth store is opencode's, not kimi-cli's.** We use opencode's auth store for tokens under the `kimi-oauth-bridge` provider id. Do not read/write `~/.kimi/credentials/kimi-code.json`; that's kimi-cli's file and sharing it across independent apps causes token-race bugs. The plugin may live-read opencode's `auth.json` entry for this provider to bypass stale `OPENCODE_AUTH_CONTENT` workspace snapshots, but writes still go through opencode's auth store (`client.auth.set`). Also note that opencode's SDK auth schema only persists the standard oauth fields, so model discovery metadata cannot be stored there durably.
8. **Provider id must not collide with any id in the [models.dev](https://models.dev) catalog.** models.dev publishes `kimi-for-coding` as a separate API-key-driven integration. If we registered under that same id, `opencode auth login kimi-for-coding` would surface two methods under one entry and users could silently land on the wrong integration path. We deliberately use `kimi-oauth-bridge` instead; `MODEL_ID` is only the configured canonical cold fallback (rule 6).
9. **The OpenCode entry (`src/adapters/opencode/index.ts`, re-exported by root `src/index.ts`) must have exactly one export — the default `PluginModule` object `{ id, server }`.** opencode's plugin loader (`research/opencode/packages/opencode/src/plugin/index.ts`) first tries `readV1Plugin` (detect mode) on the default export. If it finds an object with `server` (and optional `id`), it uses the v1 path directly. The older legacy path (`getLegacyPlugins`) iterates every export and throws `Plugin export is not a function` on any non-callable value — a problem that surfaced on Windows where Bun's standalone-binary dynamic imports can produce module namespace objects with unexpected non-function metadata. The v1 format bypasses `getLegacyPlugins` entirely. Keep constants in `src/core/constants.ts` and import them in the adapter rather than re-exporting. `test/exports.test.ts` guards this. The failure mode of a broken export is silent in the CLI (the provider just doesn't appear in `opencode auth login`); the error only surfaces in `~/.local/share/opencode/log/*.log`.
10. **The post-login config hint and `config(cfg)` projection must cover the complete current catalog.** Every discovered model needs its own top-level `variants` object derived from its metadata. Each projected config model must set `limit: { context: context_length, output: 0 }`: `output: 0` deliberately uses OpenCode's default output ceiling and does not claim an unknown Kimi output limit. Do not set `input` heuristically; opencode's overflow logic treats `limit.input` as authoritative (`research/opencode/packages/opencode/src/session/overflow.ts`). For every host-generated `low`, `medium`, or `high` variant that is absent from Kimi metadata, emit a `{ disabled: true }` sentinel so the host cannot synthesize a fake effort level. `provider.models` remains the compatible-host projection path, not the sole runtime backfill.
11. **Concurrent refreshes must collapse to one in-flight OAuth exchange, even across plugin instances.** `config(cfg)`, `provider.models`, and `auth.loader` can all notice an expiring token at about the same time, and separate opencode workspace/plugin instances can inherit stale auth snapshots. `refreshAuth()` in the OpenCode adapter therefore shares one promise across overlapping callers, takes a provider-scoped auth-store lock before refreshing, re-reads opencode's live auth-store entry under that lock, and treats a changed on-disk token chain as authoritative — even for a forced (401-triggered) refresh, so two processes handling a 401 do not rotate twice (Oracle #9, in `src/core/refresh.ts`). `test/plugin.test.ts` and `test/auth-refresh.test.ts` cover loader-vs-loader, provider.models-vs-loader, cross-instance lock reuse, the forced-refresh-returns-latest regression, and the `invalid_grant` self-heal path where another process already rotated the refresh token.
12. **Media-input capabilities must be backfilled for every catalog model from `/coding/v1/models`.** `supports_image_in` and `supports_video_in` from Kimi discovery are not cosmetic metadata: opencode's provider transform (`research/opencode/packages/opencode/src/provider/transform.ts::unsupportedParts`) rewrites every image part into local `ERROR: Cannot read ... (this model does not support image input)` text before the request reaches our loader when `capabilities.input.image` is false. Therefore `config(cfg)` and the compatible-host `provider.models` path must patch every runtime catalog model, and `buildConfigBlock()` must include `attachment: true` plus appropriate `modalities.input` / `modalities.output` only when that model supports images/video. `test/plugin.test.ts` covers both paths.

### Working on this repo

- **Code style:** see `tsconfig.json` (strict, `noUncheckedIndexedAccess`, ES2022). Prefer small pure functions, avoid `try`/`catch` except where we genuinely convert one error shape to another.
- **Comments:** match the existing density — only explain non-obvious upstream-parity reasoning. Do not narrate the obvious ("// refresh the token"); instead reference upstream files when the reasoning is "because kimi-cli does it that way".
- **Dependencies:** runtime deps are limited to `@opentui/core` and `@opentui/solid` (for the TUI slash command). Dev/peer deps are `@opencode-ai/plugin` (OpenCode types) and `openclaw` (OpenClaw types — optional peer + pinned dev dep `2026.7.1-2`; never a runtime dep, the host provides it). Do not add further runtime deps.
- **Git commits:** small, logical, imperative subject ("Add oauth device flow"). Do not add a `Co-authored-by` trailer.
- **Upstream research:** the `research/` directory is a read-only git-ignored pair of shallow clones (opencode + kimi-cli) for grep. Never edit files there; re-clone if you suspect drift. When citing upstream in a comment, use the `research/…` path so the reference is resolvable.
- **Version bumps:** when kimi-cli bumps, (1) pull a fresh `research/kimi-cli`, (2) update `KIMI_CLI_VERSION` in `src/core/constants.ts`, (3) re-diff `_kimi_default_headers()` / `oauth.py` against `src/core/headers.ts` and `src/core/oauth.ts`, (4) smoke-test with `opencode auth login kimi-oauth-bridge` and a one-turn chat, (5) tag release.
- **Tests:** `test/` holds one file per source file plus `test/exports.test.ts` (the rule-9 guard). Tests mock `fetch` via `test/_util/fetchMock.ts`; no real credentials or network. They use the real `~/.kimi/device_id` on purpose — it is shared with kimi-cli by design and `getDeviceId` is idempotent, so tests don't clobber state. When adding a new contract to the list above, add the matching offline check to the corresponding test file rather than creating new ones.

### What not to do

- ❌ Don't collapse the dynamic catalog into one discovered model, rewrite a selected model id in `loader.fetch`, or use Moonshot Platform ids. The chat hooks may consult only the provider-scoped in-memory catalog to decide whether Kimi body fields apply.
- ❌ Don't rename the provider id back to `kimi-for-coding` or to anything else listed in models.dev. See rule 8.
- ❌ Don't add new header values that kimi-cli doesn't send. The fingerprint matters.
- ❌ Don't call out to other files to "share" the kimi-cli credentials. Different OAuth consumers must have independent refresh-token chains or one will invalidate the other.
- ❌ Don't introduce a build step for the **OpenCode** entry. The plugin ships as `.ts` and opencode's bun-based loader handles it. (The **OpenClaw** entry is the deliberate exception: `package.json#openclaw.runtimeExtensions` points at `dist/openclaw.js`, built by `prepack`/`build:openclaw` with `openclaw` externalized. OpenCode must keep resolving raw `.ts` from `src/index.ts`.)
- ❌ Don't add tests that require real Kimi credentials and check them in. If you add offline unit tests, put them under `test/` and mock `fetch`.
- ❌ Don't add named exports to the OpenCode entry (`src/adapters/opencode/index.ts`, re-exported by root `src/index.ts`) or change the default export away from the `{ id, server }` PluginModule shape. See rule 9.

### How to verify a change

Offline:

```sh
bunx tsc --noEmit                                  # type-check
bunx tsc --noEmit --project tsconfig.tests.json    # type-check tests/helpers
bun build --target=node --no-bundle src/index.ts   # syntax check (OpenCode entry)
bun run build:openclaw                             # bundle dist/openclaw.js with openclaw EXTERNALIZED
bun test                                           # offline unit tests
```

`build:openclaw` externalizes the `openclaw` host (`--external openclaw`) so the host is never bundled; confirm with `grep -c "from \"openclaw/" dist/openclaw.js` (3 import statements, not bundled source). `openclaw` is an optional peer + pinned dev dependency (`2026.7.1-2`); the adapter type-checks against it via `skipLibCheck` (node_modules `.d.ts` only — no strict setting is weakened).

Online (requires a real Kimi-for-coding account):

1. Install the local checkout via opencode's plugin flow (`opencode plugin /path/to/this/repo --global`) or point the `plugin` array in your opencode config at the repo root, as shown in `README.md`.
2. Paste the provider block from `README.md` into your opencode config.
3. `opencode auth login kimi-oauth-bridge` — confirm a token lands in opencode's `auth.json` with `type: "oauth"`, a JWT `access`, and `expires` ~15 min in the future.
4. Start opencode, select one exact id from the discovered `kimi-oauth-bridge` catalog, and ask the model to self-identify. Confirm the selected id is still the body `model` value.
5. Confirm `reasoning_content` deltas render as thinking content only for a model whose discovered metadata enables it.
6. In a second turn of the same session, confirm the response comes back faster (cache hit via `prompt_cache_key`).

If any of 3–6 fails, diff `research/kimi-cli` against the contracts above.

### House rules for AI agents

- Read this file first. Every time.
- Don't grow the dependency footprint to "simplify" something; this plugin's value is being small and audit-able.
- When in doubt, mirror kimi-cli exactly, then comment the upstream reference. "We used to deviate, it broke" — document it here.
- Keep `README.md` user-focused and this file contributor-focused. If you catch yourself duplicating, move content here and link from the README.
- Any new rule you add here must have a real incident or a grep-verified upstream source behind it. No speculative "best practices".
