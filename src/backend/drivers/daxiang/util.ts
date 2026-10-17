import { calcFileType, FileItem } from "../../internal/driver/base"
import type {
  DaxiangAddition,
  DaxiangApiEnvelope,
  DaxiangAuthResult,
} from "./types"

export const DEFAULT_API_HOST = "https://api.neixin.cn"
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"

export function isOfficialApiHost(raw: string): boolean {
  try {
    const url = new URL(String(raw || DEFAULT_API_HOST))
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return false
    const host = url.hostname.toLowerCase().replace(/\.$/, "")
    return host === "api.neixin.cn" || host.endsWith(".neixin.cn")
  } catch {
    return false
  }
}

export function normalizeAddition(
  input: DaxiangAddition = {},
): DaxiangAddition {
  const a = { ...input }
  a.api_host = String(a.api_host || DEFAULT_API_HOST)
    .trim()
    .replace(/\/$/, "")
  a.user_agent = String(a.user_agent || DEFAULT_USER_AGENT).trim()
  a.app_id = String(a.app_id || "1").trim()
  a.keep_alive_minutes = Number.isFinite(Number(a.keep_alive_minutes))
    ? Number(a.keep_alive_minutes)
    : 3
  a.root_folder_path = normalizePath(a.root_folder_path || "/")
  return a
}

export function normalizePath(value: string): string {
  const text = String(value || "/").replace(/\\/g, "/")
  const parts: string[] = []
  for (const part of text.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length) parts.pop()
      continue
    }
    parts.push(part)
  }
  return "/" + parts.join("/")
}

export function joinPath(parent: string, name: string): string {
  return normalizePath(`${parent || "/"}/${name || ""}`)
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint")
    return String(value)
  return ""
}

export function firstString(
  values: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = stringValue(values[key]).trim()
    if (value) return value
  }
  return ""
}

export function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value
  return value === 1 || value === "1" || String(value).toLowerCase() === "true"
}

export function timeValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const direct = new Date(value)
    if (!Number.isNaN(direct.getTime())) return direct.toISOString()
    const local = new Date(value.replace(" ", "T") + "+08:00")
    if (!Number.isNaN(local.getTime())) return local.toISOString()
  }
  const n = numberValue(value)
  if (n > 0) {
    const date = new Date(n > 100000000000 ? n : n * 1000)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

export function itemFromMap(input: Record<string, unknown>): FileItem {
  const nested = input.storageInfo
  const values =
    nested && typeof nested === "object"
      ? { ...input, ...(nested as Record<string, unknown>) }
      : input
  const path = firstString(values, "path", "fullPath", "filePath")
  const name =
    firstString(values, "name", "fileName", "title") ||
    path.split("/").pop() ||
    ""
  if (!path || !name) throw new Error("invalid Daxiang object response")
  const isDir = boolValue(values.isDir ?? values.isDirectory ?? values.folder)
  const size = numberValue(values.size ?? values.fileSize ?? values.length)
  return {
    name,
    size,
    is_dir: isDir,
    modified: timeValue(
      values.uts ??
        values.updated ??
        values.updateTime ??
        values.modified ??
        values.mtime,
    ),
    sign: firstString(values, "id", "fileId", "treeId", "unifyId") || path,
    type: calcFileType(name, isDir),
    raw_url: "",
  }
}

export function authResultFromAddition(a: DaxiangAddition): DaxiangAuthResult {
  return {
    cookie: String(a.cookie || ""),
    app_id: String(a.app_id || "1"),
    ck: String(a.ck || ""),
    al: String(a.al || ""),
    uid: String(a.uid || ""),
    uuid: String(a.uuid || ""),
    dx_sign: String(a.dx_sign || ""),
    dx_sso: String(a.dx_sso || ""),
  }
}

export function applyAuthResult(
  a: DaxiangAddition,
  result: DaxiangAuthResult,
): DaxiangAddition {
  return {
    ...a,
    cookie: result.cookie,
    app_id: result.app_id || "1",
    ck: result.ck,
    al: result.al,
    uid: result.uid,
    uuid: result.uuid,
    dx_sign: result.dx_sign,
    dx_sso: result.dx_sso,
    credential_updated_at: Date.now(),
  }
}

export function encodeCfp(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function authComplete(a: DaxiangAddition): boolean {
  return Boolean(a.ck && a.al && a.uid && a.uuid && (a.cookie || a.dx_sso))
}

export function parseEnvelope<T>(raw: unknown): {
  data: T
  envelope: DaxiangApiEnvelope<T>
} {
  const envelope = (raw || {}) as DaxiangApiEnvelope<T>
  let code = Number(envelope.rescode || 0) || Number(envelope.code || 0)
  let message = String(envelope.message || "")
  if (envelope.error && typeof envelope.error === "object") {
    const error = envelope.error as any
    code = Number(error.code || code)
    message = String(error.message || message)
  }
  if (code && code !== 200 && code !== 1000000 && code !== 1000200) {
    throw new Error(
      `Daxiang API error ${code}: ${message || "request rejected"}`,
    )
  }
  return {
    data: (envelope.data === undefined ? {} : envelope.data) as T,
    envelope,
  }
}
