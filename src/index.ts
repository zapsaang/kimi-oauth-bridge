// Root entry. Re-exports the OpenCode adapter's PluginModule default export.
// opencode loads raw .ts (no build step); package.json main/exports point here.
// The actual implementation lives in ./adapters/opencode/index.ts so the
// host-neutral core (./core/*) can be reused by a future second host.
export { default } from "./adapters/opencode/index.ts"
