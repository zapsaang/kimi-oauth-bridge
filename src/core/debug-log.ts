import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEBUG_LOG_ENV = "KIMI_OAUTH_BRIDGE_DEBUG_LOG"

export function resolveDebugLogPath(
  value: string | undefined = process.env[DEBUG_LOG_ENV],
  homeDir: string = os.homedir(),
): string | undefined {
  if (!value || value === "0" || value === "false") return undefined
  if (value === "1" || value === "true") {
    return path.join(homeDir, ".kimi", "kimi-oauth-bridge-debug.log")
  }
  return value
}

function userAgent(headers: Headers | Record<string, string>): string {
  if (headers instanceof Headers) return headers.get("user-agent") ?? ""
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "user-agent") return value
  }
  return ""
}

export function debugLogOutbound(
  source: string,
  method: string,
  url: string,
  headers: Headers | Record<string, string>,
): void {
  try {
    const logPath = resolveDebugLogPath()
    if (!logPath) return
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        t: new Date().toISOString(),
        source,
        method,
        url,
        ua: userAgent(headers),
      })}\n`,
      "utf8",
    )
  } catch {
    return
  }
}
