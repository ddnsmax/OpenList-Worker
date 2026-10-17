import type { DaxiangAddition, DaxiangApiEnvelope } from "./types"
import { DEFAULT_API_HOST, DEFAULT_USER_AGENT, parseEnvelope } from "./util"

export class DaxiangAuthError extends Error {}

export class DaxiangClient {
  readonly addition: DaxiangAddition
  private readonly onCredentials?: (
    addition: DaxiangAddition,
  ) => void | Promise<void>

  constructor(
    addition: DaxiangAddition,
    onCredentials?: (addition: DaxiangAddition) => void | Promise<void>,
  ) {
    this.addition = addition
    this.onCredentials = onCredentials
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const a = this.addition
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      Origin: "https://x.sankuai.com",
      Referer: "https://x.sankuai.com/",
      "User-Agent": a.user_agent || DEFAULT_USER_AGENT,
      ai: a.app_id || "1",
      al: a.al || "",
      ck: a.ck || "",
      dt: "2",
      pt: "web",
      u: a.uid || "",
      uu: a.uuid || "",
    }
    if (a.dx_sign) headers["dx-sign"] = a.dx_sign
    if (a.dx_sso) headers["dx-sso"] = a.dx_sso
    if (a.cookie) headers.Cookie = a.cookie
    return { ...headers, "Content-Type": "application/json", ...extra }
  }

  private async updateCookies(response: Response): Promise<void> {
    const headers = response.headers
    const next = { ...this.addition }
    let changed = false
    for (const [key, target] of [
      ["dx-sso", "dx_sso"],
      ["dx-sign", "dx_sign"],
      ["ck", "ck"],
      ["xsid", "ck"],
      ["al", "al"],
      ["alToken", "al"],
    ] as const) {
      const value = headers.get(key)?.trim()
      if (value && (next as any)[target] !== value) {
        ;(next as any)[target] = value
        changed = true
      }
    }
    const setCookies = headers.get("set-cookie") || ""
    if (setCookies) {
      const cookies = new Map<string, string>()
      for (const part of String(next.cookie || "").split(";")) {
        const i = part.indexOf("=")
        if (i > 0)
          cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
      }
      for (const record of setCookies.split(/,(?=[^;,=]+=[^;,]+)/)) {
        const first = record.split(";")[0]
        const i = first.indexOf("=")
        if (i > 0)
          cookies.set(first.slice(0, i).trim(), first.slice(i + 1).trim())
      }
      const cookie = [...cookies.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
      if (cookie && cookie !== next.cookie) {
        next.cookie = cookie
        changed = true
      }
    }
    if (changed) {
      Object.assign(this.addition, next)
      await this.onCredentials?.(this.addition)
    }
  }

  async json<T = any>(
    endpoint: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const url = `${String(this.addition.api_host || DEFAULT_API_HOST).replace(/\/$/, "")}/pan/base${endpoint}`
    const trace = `${crypto.randomUUID?.().replace(/-/g, "") || Math.random().toString(36).slice(2)}${Date.now()}`
    const response = await fetch(`${url}?__reqTraceID=${trace}`, {
      method: "POST",
      headers: this.headers(extraHeaders),
      body: JSON.stringify(payload ?? {}),
    })
    await this.updateCookies(response)
    if (response.status === 401)
      throw new DaxiangAuthError("Daxiang authentication expired")
    if (!response.ok)
      throw new Error(`Daxiang request failed with HTTP ${response.status}`)
    let body: any
    try {
      body = await response.json()
    } catch {
      throw new Error("invalid Daxiang response")
    }
    return parseEnvelope<T>(body).data
  }

  async upload(
    endpoint: string,
    fileName: string,
    mime: string,
    body: Uint8Array,
    cfp: string,
  ): Promise<any> {
    const form = new FormData()
    const bytes = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer
    form.append(
      "file",
      new Blob([bytes], { type: mime || "application/octet-stream" }),
      fileName,
    )
    const base = String(this.addition.api_host || DEFAULT_API_HOST).replace(
      /\/$/,
      "",
    )
    const response = await fetch(
      `${base}/pan/ul${endpoint}?__reqTraceID=${Date.now()}${Math.random().toString(36).slice(2)}`,
      {
        method: "POST",
        headers: (() => {
          const headers = this.headers({ mat: "XSID", cfp })
          delete headers["Content-Type"]
          return headers
        })(),
        body: form,
      },
    )
    await this.updateCookies(response)
    if (!response.ok)
      throw new Error(`Daxiang upload failed with HTTP ${response.status}`)
    return parseEnvelope(await response.json()).data
  }

  async uploadJson<T = any>(
    endpoint: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const base = String(this.addition.api_host || DEFAULT_API_HOST).replace(/\/$/, "")
    const response = await fetch(
      `${base}/pan/ul${endpoint}?__reqTraceID=${Date.now()}${Math.random().toString(36).slice(2)}`,
      {
        method: "POST",
        headers: this.headers(extraHeaders),
        body: JSON.stringify(payload ?? {}),
      },
    )
    await this.updateCookies(response)
    if (!response.ok)
      throw new Error(`Daxiang upload request failed with HTTP ${response.status}`)
    return parseEnvelope<T>(await response.json()).data
  }
}
