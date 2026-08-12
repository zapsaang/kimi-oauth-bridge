// OpenClaw plugin entry. Registers the Kimi OAuth provider with OpenClaw.
//
// The entry `id` equals `PROVIDER_ID` (the shared identity constant) so a user
// has ONE auth/login surface across both hosts (Oracle #14). Guarded by a
// contract test alongside the manifest + package name.
//
// This is a SEPARATE entry from the OpenCode adapter (src/index.ts). OpenCode's
// loader must keep resolving the `{ id, server }` PluginModule from the repo
// root; OpenClaw resolves this entry through the `openclaw` package.json field
// (`extensions` / `runtimeExtensions`).

import { definePluginEntry } from "openclaw/plugin-sdk/core"

import { PROVIDER_ID } from "../../core/constants.ts"
import { kimiProvider } from "./provider.ts"

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Kimi Code (OAuth device-code)",
  description:
    "Brings the official Kimi Code OAuth device flow and Kimi-specific coding request fields to OpenClaw, mirroring upstream kimi-cli.",
  register(api) {
    api.registerProvider(kimiProvider)
  },
})
