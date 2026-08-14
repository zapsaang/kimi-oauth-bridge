import { test, expect } from "bun:test"
import fs from "node:fs"
import * as mod from "../src/index.ts"

// Regression guard for the 1.0.0 bug + the Windows loading fix:
// opencode's plugin loader first tries readV1Plugin (detect mode) on the
// default export. If it finds { id?, server } it uses the v1 path and
// never touches getLegacyPlugins. The legacy path iterates every export and
// throws "Plugin export is not a function" on any non-callable value — a
// problem that surfaced on Windows where Bun standalone dynamic imports can
// produce module namespaces with extra non-function metadata.
//
// This test ensures the module exports exactly one default PluginModule
// object with a callable `server` and no named exports.
test("src/index.ts exports exactly one default PluginModule object", () => {
  const keys = Object.keys(mod)
  expect(keys).toEqual(["default"])
  const plugin = (mod as { default: unknown }).default
  expect(typeof plugin).toBe("object")
  expect(plugin).not.toBeNull()
  const obj = plugin as Record<string, unknown>
  expect(typeof obj.server).toBe("function")
  expect("id" in obj).toBe(true)
})

test("package exposes a separate TUI entrypoint", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports?: Record<string, string>
  }
  expect(pkg.exports?.["./tui"]).toBe("./src/tui.tsx")
  expect(fs.existsSync(new URL("../src/tui.tsx", import.meta.url))).toBe(true)
})

// Host-adapter boundary guard. src/core/* is the only code shared by both
// host adapters; adapters/opencode and adapters/openclaw must never import
// each other or the other host's SDK. Specifiers are extracted from real
// import/export statements only — adapter files legitimately mention
// "openclaw" in prose comments, so a naive substring scan would false-positive.
type HostBoundary = {
  sdk: string
  segments: readonly string[]
}

const isForbiddenSpecifier = (spec: string, boundary: HostBoundary): boolean =>
  spec === boundary.sdk ||
  spec.startsWith(`${boundary.sdk}/`) ||
  boundary.segments.some((segment) => spec.includes(segment))

// [^;]*? spans multi-line imports without crossing statement boundaries.
const FROM_STATEMENT = /(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g
const SIDE_EFFECT_IMPORT = /import\s*["']([^"']+)["']/g

const moduleSpecifiers = (source: string): string[] => {
  const specs: string[] = []
  for (const match of source.matchAll(FROM_STATEMENT)) {
    if (match[1] !== undefined) specs.push(match[1])
  }
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) {
    if (match[1] !== undefined) specs.push(match[1])
  }
  return specs
}

const sourceFilesUnder = (dirUrl: URL): URL[] =>
  fs
    .readdirSync(dirUrl, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => new URL(entry, dirUrl))

const boundaryViolations = (files: readonly URL[], boundary: HostBoundary): string[] => {
  const violations: string[] = []
  for (const file of files) {
    for (const spec of moduleSpecifiers(fs.readFileSync(file, "utf8"))) {
      if (isForbiddenSpecifier(spec, boundary)) {
        violations.push(`${file.pathname} -> ${spec}`)
      }
    }
  }
  return violations
}

const FROM_OPENCODE: HostBoundary = { sdk: "openclaw", segments: ["adapters/openclaw", "../openclaw"] }
const FROM_OPENCLAW: HostBoundary = {
  sdk: "@opencode-ai",
  segments: ["adapters/opencode", "../opencode"],
}

test("adapters/opencode never imports the openclaw adapter or SDK", () => {
  const files = sourceFilesUnder(new URL("../src/adapters/opencode/", import.meta.url))
  expect(files.length).toBeGreaterThan(0)
  expect(boundaryViolations(files, FROM_OPENCODE)).toEqual([])
})

test("adapters/openclaw never imports the opencode adapter or SDK", () => {
  const files = sourceFilesUnder(new URL("../src/adapters/openclaw/", import.meta.url))
  expect(files.length).toBeGreaterThan(0)
  expect(boundaryViolations(files, FROM_OPENCLAW)).toEqual([])
})

test("root OpenCode entries never reference the openclaw side", () => {
  const roots = [new URL("../src/index.ts", import.meta.url), new URL("../src/tui.tsx", import.meta.url)]
  expect(boundaryViolations(roots, FROM_OPENCODE)).toEqual([])
})

// Proves the classifier bites without committing a broken tree.
test("boundary predicate rejects cross-host specifiers and spares core", () => {
  expect(isForbiddenSpecifier("../../openclaw/catalog.ts", FROM_OPENCODE)).toBe(true)
  expect(isForbiddenSpecifier("openclaw/plugin-sdk/core", FROM_OPENCODE)).toBe(true)
  expect(isForbiddenSpecifier("@opencode-ai/plugin", FROM_OPENCLAW)).toBe(true)
  expect(isForbiddenSpecifier("../adapters/opencode/auth-store.ts", FROM_OPENCLAW)).toBe(true)
  expect(isForbiddenSpecifier("../../core/headers.ts", FROM_OPENCODE)).toBe(false)
  expect(isForbiddenSpecifier("../../core/oauth.ts", FROM_OPENCLAW)).toBe(false)
  expect(isForbiddenSpecifier("./provider.ts", FROM_OPENCLAW)).toBe(false)
})
