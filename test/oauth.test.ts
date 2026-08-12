/// <reference path="./bun-test.d.ts" />

import { test, expect, afterEach } from "bun:test"
import {
  OAUTH_CLIENT_ID,
  OAUTH_DEVICE_AUTH_URL,
  OAUTH_DEVICE_GRANT,
  OAUTH_REFRESH_GRANT,
  OAUTH_TOKEN_URL,
} from "../src/core/constants.ts"
import { listModels, pollDeviceToken, refreshToken, startDeviceAuth } from "../src/core/oauth.ts"
import { installFetchMock, parseForm } from "./_util/fetchMock.ts"

// oauth.ts calls kimiHeaders() on every request, which reads/writes
// ~/.kimi/device_id. That file is shared with kimi-cli by design and
// getDeviceId is idempotent — no HOME redirect needed.

let mock: ReturnType<typeof installFetchMock> | undefined
afterEach(() => {
  mock?.restore()
  mock = undefined
})

test("startDeviceAuth posts client_id as form-encoded to the device endpoint", async () => {
  mock = installFetchMock(() => ({
    body: {
      device_code: "dc",
      user_code: "USER-1234",
      verification_uri: "https://auth.kimi.com/device",
      verification_uri_complete: "https://auth.kimi.com/device?u=USER-1234",
      expires_in: 600,
      interval: 5,
    },
  }))
  const d = await startDeviceAuth()
  expect(d.user_code).toBe("USER-1234")
  expect(mock.calls).toHaveLength(1)
  const call = mock.calls[0]!
  expect(call.url).toBe(OAUTH_DEVICE_AUTH_URL)
  expect(call.method).toBe("POST")
  expect(call.hasSignal).toBe(true)
  expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded")
  // Fingerprint headers must be present on every oauth call, not just chat.
  expect(call.headers["x-msh-version"]).toBeDefined()
  expect(call.headers["x-msh-device-id"]).toMatch(/^[0-9a-f]{32}$/)
  expect(parseForm(call.body)).toEqual({
    client_id: OAUTH_CLIENT_ID,
  })
})

test("refreshToken posts grant_type=refresh_token and returns normalized shape", async () => {
  mock = installFetchMock(() => ({
    body: { access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 900 },
  }))
  const t = await refreshToken("r1")
  expect(t).toEqual({ access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 900 })
  const call = mock.calls[0]!
  expect(call.url).toBe(OAUTH_TOKEN_URL)
  expect(call.hasSignal).toBe(true)
  expect(parseForm(call.body)).toEqual({
    client_id: OAUTH_CLIENT_ID,
    refresh_token: "r1",
    grant_type: OAUTH_REFRESH_GRANT,
  })
})

test("refreshToken retries transient 5xx and non-JSON responses before succeeding", async () => {
  mock = installFetchMock((_, i) => {
    if (i === 0) return { status: 502, bodyText: "<html>gateway</html>" }
    return { body: { access_token: "a3", refresh_token: "r3", token_type: "Bearer", expires_in: 900 } }
  })
  const t = await refreshToken("retry-me")
  expect(t.access_token).toBe("a3")
  expect(mock.calls).toHaveLength(2)
})

test("postForm wraps non-OK responses with error.code from the JSON body", async () => {
  mock = installFetchMock(() => ({
    status: 400,
    body: { error: "invalid_grant", error_description: "refresh token is dead" },
  }))
  await expect(refreshToken("bad")).rejects.toThrow(/invalid_grant/)
})

test("refreshToken throws a clear error when a non-retryable response is non-JSON", async () => {
  mock = installFetchMock(() => ({ status: 400, bodyText: "<html>bad request</html>" }))
  await expect(refreshToken("x")).rejects.toThrow(/non-JSON response/)
})

test("pollDeviceToken honors authorization_pending and returns on approval", async () => {
  // pollDeviceToken clamps with `device.interval ?? 5` then max(1, …)*1000,
  // so the effective poll wait is max(1, interval) seconds. Use interval=1
  // and a single pending cycle to keep the test ~2s.
  const device = {
    device_code: "dc",
    user_code: "U",
    verification_uri: "x",
    expires_in: 60,
    interval: 1,
  }
  mock = installFetchMock((_, i) => {
    if (i < 1) return { status: 400, body: { error: "authorization_pending" } }
    return { body: { access_token: "A", refresh_token: "R", token_type: "Bearer", expires_in: 900 } }
  })
  const t = await pollDeviceToken(device)
  expect(t.access_token).toBe("A")
  expect(mock.calls).toHaveLength(2)
  expect(mock.calls[0]!.hasSignal).toBe(true)
  // Sends device_code + the RFC 8628 grant type.
  expect(parseForm(mock.calls[0]!.body)).toEqual({
    client_id: OAUTH_CLIENT_ID,
    device_code: "dc",
    grant_type: OAUTH_DEVICE_GRANT,
  })
})

test("pollDeviceToken surfaces expired_token with an actionable message", async () => {
  mock = installFetchMock(() => ({ status: 400, body: { error: "expired_token" } }))
  await expect(
    pollDeviceToken({ device_code: "dc", user_code: "U", verification_uri: "x", expires_in: 60, interval: 1 }),
  ).rejects.toThrow(/device code expired/)
})

test("pollDeviceToken rethrows unknown errors without looping", async () => {
  mock = installFetchMock(() => ({ status: 400, body: { error: "access_denied", error_description: "nope" } }))
  await expect(
    pollDeviceToken({ device_code: "dc", user_code: "U", verification_uri: "x", expires_in: 60, interval: 1 }),
  ).rejects.toThrow(/access_denied/)
  // Exactly one call; not retried.
  expect(mock!.calls).toHaveLength(1)
})

test("listModels validates rich Kimi Code capability metadata without retaining malformed fields", async () => {
  mock = installFetchMock(() => ({
    body: {
      data: [
        {
          id: "k3",
          display_name: "Kimi K3",
          context_length: 262144,
          protocol: "chat_completions",
          supports_reasoning: true,
          supports_tool_use: true,
          supports_image_in: true,
          supports_video_in: false,
          supports_thinking_type: "both",
          think_efforts: {
            support: true,
            valid_efforts: ["low", "high", "max"],
            default_effort: "high",
          },
        },
        {
          id: "minimal",
          context_length: "not-a-number",
          supports_reasoning: "not-a-boolean",
          supports_thinking_type: "sometimes",
          think_efforts: { support: "not-a-boolean", valid_efforts: ["low", 1] },
        },
        { id: 42, display_name: "discarded" },
      ],
    },
  }))

  const models = await listModels("access-token")

  expect(models).toEqual([
    {
      id: "k3",
      display_name: "Kimi K3",
      context_length: 262144,
      protocol: "chat_completions",
      supports_reasoning: true,
      supports_tool_use: true,
      supports_image_in: true,
      supports_video_in: false,
      supports_thinking_type: "both",
      think_efforts: {
        support: true,
        valid_efforts: ["low", "high", "max"],
        default_effort: "high",
      },
    },
    { id: "minimal" },
  ])
  expect(mock.calls).toHaveLength(1)
  expect(mock.calls[0]!.method).toBe("GET")
  expect(mock.calls[0]!.headers.authorization).toBe("Bearer access-token")
  expect(mock.calls[0]!.hasSignal).toBe(true)
})

// S5 — protocol field is parsed but NEVER mapped to a guessed transport
// (Oracle #6: anthropic/openai transport mapping is unverified). The plugin
// keeps @ai-sdk/openai-compatible / chat-completions as the verified current
// behavior regardless of the discovered protocol string. An unknown or absent
// protocol must parse without throwing and without inventing a transport.
test("listModels parses unknown/absent protocol verbatim without throwing or mapping a transport", async () => {
  mock = installFetchMock(() => ({
    body: {
      data: [
        { id: "unknown-proto", protocol: "anthropic", context_length: 8192 },
        { id: "no-proto", context_length: 4096 },
      ],
    },
  }))
  const models = await listModels("access-token")
  expect(models).toHaveLength(2)
  expect(models[0]!.id).toBe("unknown-proto")
  expect(models[0]!.protocol).toBe("anthropic")
  expect(models[1]!.id).toBe("no-proto")
  expect(models[1]!.protocol).toBeUndefined()
})

// S3 — parse-site rejection: proto-polluting / control-char model ids never
// reach the catalog. isSafeModelId is applied inside parseModelInfo so a
// hostile or malformed `/models` payload cannot inject a poisoned key.
test("listModels drops proto-polluting and control-char model ids at parse", async () => {
  mock = installFetchMock(() => ({
    body: {
      data: [
        { id: "__proto__", context_length: 999 },
        { id: "constructor", context_length: 999 },
        { id: "prototype", context_length: 999 },
        { id: "bad\tid", context_length: 999 },
        { id: "", context_length: 999 },
        { id: 42, context_length: 999 },
        { id: "safe-id", context_length: 4096 },
      ],
    },
  }))
  const models = await listModels("access-token")
  expect(models.map((m) => m.id)).toEqual(["safe-id"])
})
