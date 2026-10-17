import { Hono } from "hono"
import { getDb, saveDb } from "../internal/model/db"
import { getStoreBackend } from "../internal/model/store/backend"
import { checkAdminAuth } from "../pkg/utils"
import { DaxiangDriver } from "../drivers/daxiang/driver"
import {
  DEFAULT_API_HOST,
  DEFAULT_USER_AGENT,
  authComplete,
  isOfficialApiHost,
  normalizeAddition,
} from "../drivers/daxiang/util"
import type {
  DaxiangAddition,
  DaxiangAuthResult,
  DaxiangAuthState,
} from "../drivers/daxiang/types"

const SSO_ORIGIN = "https://ssosv.sankuai.com"
const API_ORIGIN = DEFAULT_API_HOST
const CLIENT_ID = "xm-xai"
const CALLBACK_URL = "https://neixin.meituan.com/login/javasso/oauth/callback"
const SESSION_TTL = 15 * 60 * 1000
const SESSION_KEY_PREFIX = "openlist_daxiang_auth_"

export const daxiangAuthRouter = new Hono()

daxiangAuthRouter.use("*", async (c, next) => {
  if (!(await checkAdminAuth(c)))
    return c.json({ code: 401, message: "Unauthorized", data: null }, 401)
  await next()
})

type StoredSession = {
  kind: "daxiang-auth"
  session_id: string
  created_at: number
  expires_at: number
  ctx_id: string
  origin: string
  redirect: string
  cookie: string
  api_cookie?: string
  result?: DaxiangAuthResult
  state: DaxiangAuthState
}

function randomId(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let value = ""
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0")
  return value
}

function stateFor(session: StoredSession): DaxiangAuthState {
  const state = {
    ...session.state,
    session_id: session.session_id,
    expires_at: Math.floor(session.expires_at / 1000),
  }
  if (session.result && authComplete(session.result as any)) {
    state.status = "authenticated"
    state.authenticated = true
    state.message = undefined
    state.qr_code_url = undefined
  }
  return state
}

async function readSessions(
  env: any,
): Promise<{ db: any; sessions: StoredSession[] }> {
  const backend = await getStoreBackend(env)
  const sessions: StoredSession[] = []
  const now = Date.now()
  const keys = backend.list ? await backend.list(SESSION_KEY_PREFIX, env) : []
  for (const key of keys) {
    try {
      const raw = backend.get ? await backend.get(key, env) : null
      const parsed = JSON.parse(String(raw || "{}")) as StoredSession
      if (parsed.kind === "daxiang-auth" && parsed.expires_at > now)
        sessions.push(parsed)
      else if (backend.delete) await backend.delete(key, env)
    } catch {}
  }
  return { db: await getDb(env), sessions }
}

async function saveSession(env: any, session: StoredSession): Promise<void> {
  const backend = await getStoreBackend(env)
  if (!backend.put) throw new Error("storage backend cannot persist login sessions")
  await backend.put(
    `${SESSION_KEY_PREFIX}${session.session_id}`,
    JSON.stringify(session),
    env,
  )
}

async function loadSession(
  env: any,
  id: string,
): Promise<{ db: any; session: StoredSession }> {
  const { db, sessions } = await readSessions(env)
  const session = sessions.find((item) => item.session_id === String(id || ""))
  if (!session) throw new Error("daxiang login session expired")
  return { db, session }
}

async function deleteSession(env: any, id: string): Promise<void> {
  const backend = await getStoreBackend(env)
  if (backend.delete) await backend.delete(`${SESSION_KEY_PREFIX}${id}`, env)
}

function redirectUrl(): string {
  const destination = new URL("https://x.sankuai.com/")
  destination.searchParams.set("path", "/drive")
  const login = new URL("/login/loginRedirect", "https://x.sankuai.com")
  login.searchParams.set("f", "web")
  login.searchParams.set("ai", "1")
  login.searchParams.set("uuid", crypto.randomUUID())
  login.searchParams.set("redirect_uri", destination.toString())
  const callback = new URL(CALLBACK_URL)
  callback.searchParams.set("original-url", `${login.pathname}${login.search}`)
  return callback.toString()
}

function authorizeUrl(
  origin: string,
  redirect: string,
  ctxId?: string,
): string {
  const url = new URL(`${origin}/sson/auth/oidc/v1/authorize`)
  url.searchParams.set("loginProtocol", "OIDC")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", redirect)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", "openid")
  url.searchParams.set("state", "https://x.sankuai.com/drive")
  url.searchParams.set("locale", "zh")
  if (ctxId) url.searchParams.set("ctxId", ctxId)
  return url.toString()
}

function collectSetCookies(response: Response, current: string): string {
  const values: string[] = []
  const headers: any = response.headers as any
  if (typeof headers.getSetCookie === "function")
    values.push(...headers.getSetCookie())
  const combined = response.headers.get("set-cookie")
  if (combined) values.push(combined)
  const map = new Map<string, string>()
  for (const part of String(current || "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  for (const line of values)
    for (const record of line.split(/,(?=[^;,=]+=[^;,]+)/)) {
      const first = record.split(";")[0]
      const i = first.indexOf("=")
      if (i > 0) map.set(first.slice(0, i).trim(), first.slice(i + 1).trim())
    }
  return [...map.entries()].map(([key, value]) => `${key}=${value}`).join("; ")
}

function findString(value: unknown, keys: string[]): string {
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        keys.some((wanted) => wanted.toLowerCase() === key.toLowerCase()) &&
        (typeof child === "string" || typeof child === "number")
      ) {
        const result = String(child).trim()
        if (result) return result
      }
      const nested = findString(child, keys)
      if (nested) return nested
    }
  }
  return ""
}

function mergeTextResult(target: DaxiangAuthResult, raw: string): void {
  let text = String(raw || "")
  for (let i = 0; i < 2; i++) {
    const decoded = text
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/\\\//g, "/")
    if (decoded === text) break
    text = decoded
    try {
      const unescaped = decodeURIComponent(text)
      if (unescaped === text) break
      text = unescaped
    } catch {
      break
    }
  }
  const add = (keys: string[], targetKeys: string[]) => {
    for (const key of keys) {
      const json = new RegExp(`[\\\"']${key}[\\\"']\\s*:\\s*[\\\"']([^\\\"']+)`, "i").exec(text)
      const query = new RegExp(`(?:[?&#]|&&)${key}=([^&\\\"'<>\\s]+)`, "i").exec(text)
      const value = json?.[1] || query?.[1]
      if (value) {
        mergeResult(target, resultFromValue({ [targetKeys[0]]: value }))
        return
      }
    }
  }
  add(["appId", "app_id"], ["app_id"])
  add(["ai"], ["app_id"])
  add(["xsid", "ck"], ["ck"])
  add(["alToken", "altoken", "al"], ["al"])
  add(["uid", "u"], ["uid"])
  add(["uuid", "uu"], ["uuid"])
  add(["dxSign", "dx-sign"], ["dx_sign"])
  add(["dxSsoId", "dxSso", "dx-sso"], ["dx_sso"])
}

function mergeHeaderResult(target: DaxiangAuthResult, headers: Headers): void {
  mergeResult(target, resultFromValue(Object.fromEntries(headers.entries())))
}

function mergeCookieResult(target: DaxiangAuthResult, cookie: string): void {
  const values: Record<string, string> = {}
  for (const part of String(cookie || "").split(";")) {
    const index = part.indexOf("=")
    if (index > 0) values[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  mergeResult(target, resultFromValue(values))
}

function actionRedirect(payload: any): string {
  return findString(payload, ["redirectUrl", "redirectURL"])
}

function isTrustedAuthUrl(value: URL): boolean {
  if (value.protocol !== "https:" || value.username || value.password)
    return false
  const host = value.hostname.toLowerCase().replace(/\.$/, "")
  return ["ssosv.sankuai.com", "sankuai.com", "meituan.com", "meituan.net", "neixin.cn"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  )
}

function clientRedirect(body: string): string {
  const patterns = [
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)/i,
    /(?:window\.)?location\.(?:assign|replace)\s*\(\s*["']([^"']+)/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url\s*=\s*([^"';>]+)/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(body)
    if (match?.[1]) return match[1].trim().replace(/\\\//g, "/")
  }
  return ""
}

async function followAuxiliary(
  session: StoredSession,
  current: URL,
  body: string,
  result: DaxiangAuthResult,
): Promise<void> {
  const pattern = /createAndLoadImg\s*\(\s*["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  let count = 0
  while ((match = pattern.exec(body)) && count++ < 4) {
    const next = new URL(match[1].replace(/\\\//g, "/"), current)
    if (!isTrustedAuthUrl(next))
      throw new Error("daxiang SSO auxiliary request used a disallowed host")
    const response = await fetch(next, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json",
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: current.toString(),
        Cookie: session.cookie,
      },
    })
    session.cookie = collectSetCookies(response, session.cookie)
    mergeHeaderResult(result, response.headers)
    mergeCookieResult(result, session.cookie)
    mergeTextResult(result, await response.text())
  }
}

function resultFromValue(value: unknown): DaxiangAuthResult {
  return {
    cookie: "",
    app_id: findString(value, ["appId", "app_id", "ai"]),
    ck: findString(value, ["xsid", "ck"]),
    al: findString(value, ["alToken", "al"]),
    uid: findString(value, ["uid", "u"]),
    uuid: findString(value, ["uuid", "uu"]),
    dx_sign: findString(value, ["dxSign", "dx-sign"]),
    dx_sso: findString(value, ["dxSsoId", "dxSso", "dx-sso"]),
  }
}

function mergeResult(
  target: DaxiangAuthResult,
  source: DaxiangAuthResult,
): DaxiangAuthResult {
  for (const key of [
    "cookie",
    "app_id",
    "ck",
    "al",
    "uid",
    "uuid",
    "dx_sign",
    "dx_sso",
  ] as const)
    if (source[key]) target[key] = source[key]
  return target
}

async function ssoRequest(
  session: StoredSession,
  endpoint: string,
  payload: unknown,
): Promise<{ action: any; response: Response; body: any }> {
  const url = new URL(`${session.origin}${endpoint}`)
  if (session.ctx_id) url.searchParams.set("ctxId", session.ctx_id)
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      locale: "zh",
      clientId: CLIENT_ID,
      redirectUri: encodeURIComponent(session.redirect),
      Origin: session.origin,
      Referer: `${session.origin}/`,
      "User-Agent": DEFAULT_USER_AGENT,
      "Url-Ctx-Id": session.ctx_id,
      ctxId: session.ctx_id,
      Cookie: session.cookie,
    },
    body: JSON.stringify(payload ?? {}),
  })
  session.cookie = collectSetCookies(response, session.cookie)
  const body: any = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(`sso request returned HTTP ${response.status}`)
  const code = Number(body.code || 0)
  if (code && code !== 1000000 && code !== 1000200)
    throw new Error(
      String(body.msg || body.message || `sso request failed (${code})`),
    )
  if (body.ctxId) session.ctx_id = String(body.ctxId)
  return { action: body.action || {}, response, body }
}

async function fetchRedirectChain(
  url: string,
  session: StoredSession,
): Promise<{ response: Response; body: string; result: DaxiangAuthResult }> {
  let current = new URL(url)
  let response: Response | undefined
  let body = ""
  const result: DaxiangAuthResult = resultFromValue({})
  for (let i = 0; i < 12; i++) {
    if (!isTrustedAuthUrl(current))
      throw new Error("daxiang SSO redirected to a disallowed host")
    response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json",
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: session.origin + "/",
        Cookie: session.cookie,
      },
    })
    session.cookie = collectSetCookies(response, session.cookie)
    body = await response.text()
    mergeResult(result, resultFromValue(Object.fromEntries(current.searchParams.entries())))
    mergeHeaderResult(result, response.headers)
    mergeCookieResult(result, session.cookie)
    mergeTextResult(result, body)
    await followAuxiliary(session, current, body, result)
    const location = response.headers.get("location")
    if (response.status < 300 || response.status >= 400 || !location) break
    current = new URL(location, current)
  }
  if (!response) throw new Error("daxiang redirect request failed")
  mergeResult(result, resultFromValue(Object.fromEntries(current.searchParams.entries())))
  mergeCookieResult(result, session.cookie)
  return { response, body, result }
}

async function startSession(env: any): Promise<StoredSession> {
  const origin = SSO_ORIGIN
  const redirect = redirectUrl()
  let current = new URL(authorizeUrl(origin, redirect))
  let response: Response | undefined
  let body = ""
  let cookie = ""
  for (let i = 0; i < 12; i++) {
    if (!isTrustedAuthUrl(current))
      throw new Error("daxiang SSO redirected to a disallowed host")
    response = await fetch(current, {
      redirect: "manual",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        Cookie: cookie,
      },
    })
    cookie = collectSetCookies(response, cookie)
    body = await response.text()
    const location = response.headers.get("location")
    if (response.status < 300 || response.status >= 400 || !location) break
    current = new URL(location, current)
  }
  if (!response || !response.ok)
    throw new Error(`sso authorize returned HTTP ${response?.status || 0}`)
  const ctxId =
    current.searchParams.get("ctxId") ||
    body.match(/<meta\s+name=["']ctxId["']\s+content=["']([^"']+)/i)?.[1] ||
    ""
  if (!ctxId) throw new Error("sso did not return ctxId")
  const session: StoredSession = {
    kind: "daxiang-auth",
    session_id: randomId(),
    created_at: Date.now(),
    expires_at: Date.now() + SESSION_TTL,
    ctx_id: ctxId,
    origin,
    redirect,
    cookie,
    api_cookie: "",
    state: {
      session_id: "",
      status: "ready",
      authenticated: false,
      expires_at: 0,
    },
  }
  session.state.session_id = session.session_id
  const page = await ssoRequest(
    session,
    "/sson/auth/profiles/v1/web/loginPage",
    {},
  )
  session.state.message = findString(page.action?.payload, ["msg", "message"])
  session.state.factors = Array.isArray(page.action?.payload?.factors)
    ? page.action.payload.factors.map(String)
    : undefined
  await saveSession(env, session)
  return session
}

function resultFromSession(session: StoredSession): DaxiangAuthResult | null {
  if (!session.result) return null
  return {
    ...session.result,
    cookie: session.result.cookie || session.api_cookie || "",
    app_id: session.result.app_id || "1",
  }
}

function consumeResult(session: StoredSession): DaxiangAuthResult | null {
  const result = resultFromSession(session)
  if (!result || !authComplete(result as any)) return null
  return result
}

async function pollSession(
  env: any,
  session: StoredSession,
): Promise<StoredSession> {
  const response = await ssoRequest(session, "/sson/auth/qrcode/v1/status", {})
  const action = response.action || {}
  const payload = action.payload || {}
  session.api_cookie = session.api_cookie || ""
  const result = mergeResult(
    resultFromSession(session) || {
      cookie: session.api_cookie || "",
      app_id: "1",
      ck: "",
      al: "",
      uid: "",
      uuid: "",
      dx_sign: "",
      dx_sso: "",
    },
    resultFromValue(payload),
  )
  result.cookie = session.api_cookie || ""
  if (authComplete(result as any)) {
    session.result = result
    session.state.status = "authenticated"
    session.state.authenticated = true
    await saveSession(env, session)
    return session
  }
  const message = findString(payload, ["msg", "message", "lockTip"])
  if (message) session.state.message = message
  if (Number(action.bizCode || response.body?.bizCode) === 1060001)
    session.state.status = "expired"
  else session.state.status = "qr"
  const redirect = actionRedirect(payload)
  if (
    redirect ||
    String(session.state.message || "")
      .toLowerCase()
      .includes("tgc")
  ) {
    const directRedirect = actionRedirect(payload)
    const followTarget = directRedirect
      ? new URL(directRedirect, session.origin)
      : new URL(authorizeUrl(session.origin, session.redirect, session.ctx_id))
    if (!isTrustedAuthUrl(followTarget))
      throw new Error("daxiang SSO redirected to a disallowed host")
    const follow = await fetchRedirectChain(
      followTarget.toString(),
      session,
    )
    session.api_cookie = collectSetCookies(
      follow.response,
      session.api_cookie || "",
    )
    const text = follow.body
    mergeResult(result, follow.result)
    const url = new URL(follow.response.url)
    mergeResult(result, resultFromValue(Object.fromEntries(url.searchParams.entries())))
    mergeTextResult(result, text)
    result.cookie = session.api_cookie || ""
    if (result.uid && result.dx_sso && (!result.ck || !result.al)) {
      const exchange = await fetch(`${API_ORIGIN}/login/im_token/generate`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Origin: "https://x.sankuai.com",
          Referer: "https://x.sankuai.com/",
          "User-Agent": DEFAULT_USER_AGENT,
          ai: result.app_id || "1",
          dt: "2",
          pt: "web",
          u: result.uid,
          uu: result.uuid,
          "dx-sso": result.dx_sso,
          "dx-sign": result.dx_sign,
          Cookie: session.api_cookie || "",
        },
        body: JSON.stringify({ uid: result.uid, ssoId: result.dx_sso }),
      })
      if (!exchange.ok) throw new Error(`daxiang token exchange returned HTTP ${exchange.status}`)
      const envelope: any = await exchange.json().catch(() => ({}))
      const code = Number(envelope.rescode || envelope.code || 0)
      if (code) throw new Error(String(envelope.message || `daxiang token exchange failed (${code})`))
      mergeResult(result, resultFromValue(envelope.data || envelope))
      session.api_cookie = collectSetCookies(exchange, session.api_cookie || "")
      result.cookie = session.api_cookie
    }
    if (!authComplete(result as any)) {
      const page = await ssoRequest(
        session,
        "/sson/auth/profiles/v1/web/loginPage",
        {},
      )
      const historyMis = findString(page.action?.payload, ["historyMis"])
      if (historyMis) {
        const identified = await ssoRequest(
          session,
          "/sson/auth/identifier/v1/submit",
          {
            identifier: historyMis,
            identifierType: "ACCOUNT_PASSWORD_ENTRANCE",
          },
        )
        const factors = identified.action?.payload?.factors
        if (Array.isArray(factors) && factors.some((item: unknown) => String(item).toUpperCase() === "FC_MOA_AUTO")) {
          const automatic = await ssoRequest(session, "/sson/auth/moa/autologin", {})
          mergeResult(result, resultFromValue(automatic.action?.payload))
        }
        mergeResult(result, resultFromValue(identified.action?.payload))
      }
    }
    if (authComplete(result as any)) {
      session.result = result
      session.state.status = "authenticated"
      session.state.authenticated = true
      session.state.message = undefined
    }
  }
  await saveSession(env, session)
  return session
}

export async function materializeDaxiangAddition(
  env: any,
  additionInput: any,
): Promise<DaxiangAddition> {
  const addition = normalizeAddition(additionInput || {})
  const id = String(addition.auth_session_id || "")
  if (!id) return addition
  const { session } = await loadSession(env, id)
  const result = consumeResult(session)
  if (!result || !authComplete(result as any))
    throw new Error("daxiang login session is not authenticated")
  await deleteSession(env, id)
  return {
    ...addition,
    ...result,
    credential_updated_at: Date.now(),
    auth_session_id: undefined,
  }
}

function clearCredentials(input: any): DaxiangAddition {
  const next = { ...normalizeAddition(input) }
  for (const key of [
    "cookie",
    "app_id",
    "ck",
    "al",
    "uid",
    "uuid",
    "dx_sign",
    "dx_sso",
    "auth_session_id",
    "credential_updated_at",
  ])
    delete (next as any)[key]
  return next
}

function storageAddition(storage: any): DaxiangAddition {
  try {
    return normalizeAddition(
      typeof storage?.addition === "string"
        ? JSON.parse(storage.addition || "{}")
        : storage?.addition || {},
    )
  } catch {
    return normalizeAddition({})
  }
}

daxiangAuthRouter.post("/auth/start", async (c) => {
  try {
    const session = await startSession(c.env)
    return c.json({ code: 200, message: "success", data: stateFor(session) })
  } catch (error: any) {
    return c.json(
      { code: 502, message: error?.message || String(error), data: null },
      502,
    )
  }
})
daxiangAuthRouter.post("/auth/qr/start", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { session } = await loadSession(c.env, body.session_id)
    session.state.status = "qr"
    session.state.qr_code_url = `${session.origin}/sson/auth/qrcode/v1/${encodeURIComponent(session.ctx_id)}?locale=zh`
    await saveSession(c.env, session)
    return c.json({ code: 200, message: "success", data: stateFor(session) })
  } catch (error: any) {
    return c.json(
      { code: 400, message: error?.message || String(error), data: null },
      400,
    )
  }
})
daxiangAuthRouter.post("/auth/qr/status", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { session } = await loadSession(c.env, body.session_id)
    const next = await pollSession(c.env, session)
    return c.json({ code: 200, message: "success", data: stateFor(next) })
  } catch (error: any) {
    return c.json(
      { code: 502, message: error?.message || String(error), data: null },
      502,
    )
  }
})
daxiangAuthRouter.post("/auth/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await deleteSession(c.env, body.session_id || c.req.query("session_id") || "")
  return c.json({ code: 200, message: "success", data: null })
})
daxiangAuthRouter.get("/auth/accounts", async (c) => {
  const db = await getDb(c.env)
  const seen = new Set<string>()
  const accounts: any[] = []
  for (const storage of db.storages || []) {
    if (String(storage.driver).toLowerCase() !== "daxiang") continue
    const addition = storageAddition(storage)
    if (!authComplete(addition as any)) continue
    const key = `${String(addition.api_host || DEFAULT_API_HOST).toLowerCase()}\0${addition.uid}`
    if (seen.has(key)) continue
    seen.add(key)
    accounts.push({ storage_id: storage.id, mount_path: storage.mount_path })
  }
  return c.json({ code: 200, message: "success", data: accounts })
})
daxiangAuthRouter.get("/auth/status", async (c) => {
  const id = Number(c.req.query("storage_id") || 0)
  const db = await getDb(c.env)
  const storage = (db.storages || []).find(
    (item: any) => Number(item.id) === id,
  )
  if (!storage || String(storage.driver).toLowerCase() !== "daxiang")
    return c.json(
      { code: 404, message: "daxiang storage not found", data: null },
      404,
    )
  return c.json({
    code: 200,
    message: "success",
    data: { authenticated: authComplete(storageAddition(storage) as any) },
  })
})
daxiangAuthRouter.post("/auth/reuse", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const db = await getDb(c.env)
    const storage = (db.storages || []).find(
      (item: any) => Number(item.id) === Number(body.storage_id),
    )
    if (!storage) throw new Error("daxiang storage not found")
    const addition = storageAddition(storage)
    if (!authComplete(addition as any))
      throw new Error("daxiang login credentials are incomplete")
    const session: StoredSession = {
      kind: "daxiang-auth",
      session_id: randomId(),
      created_at: Date.now(),
      expires_at: Date.now() + SESSION_TTL,
      ctx_id: "",
      origin: SSO_ORIGIN,
      redirect: redirectUrl(),
      cookie: addition.cookie || "",
      result: {
        cookie: addition.cookie || "",
        app_id: addition.app_id || "1",
        ck: addition.ck || "",
        al: addition.al || "",
        uid: addition.uid || "",
        uuid: addition.uuid || "",
        dx_sign: addition.dx_sign || "",
        dx_sso: addition.dx_sso || "",
      },
      state: {
        session_id: "",
        status: "authenticated",
        authenticated: true,
        expires_at: 0,
      },
    }
    session.state.session_id = session.session_id
    await saveSession(c.env, session)
    return c.json({ code: 200, message: "success", data: stateFor(session) })
  } catch (error: any) {
    return c.json(
      { code: 400, message: error?.message || String(error), data: null },
      400,
    )
  }
})
daxiangAuthRouter.post("/auth/logout", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const db = await getDb(c.env)
    const storage = (db.storages || []).find(
      (item: any) => Number(item.id) === Number(body.storage_id),
    )
    if (!storage || String(storage.driver).toLowerCase() !== "daxiang")
      throw new Error("daxiang storage not found")
    const current = storageAddition(storage)
    const accountKey = `${String(current.api_host || DEFAULT_API_HOST).toLowerCase()}\0${String(current.uid || "")}`
    for (const candidate of db.storages || []) {
      if (String(candidate.driver).toLowerCase() !== "daxiang") continue
      const candidateAddition = storageAddition(candidate)
      const candidateKey = `${String(candidateAddition.api_host || DEFAULT_API_HOST).toLowerCase()}\0${String(candidateAddition.uid || "")}`
      if (candidateKey !== accountKey) continue
      candidate.addition = JSON.stringify(clearCredentials(candidateAddition))
      candidate.status = "daxiang not logged in"
      candidate.modified = Date.now()
    }
    await saveDb(db, c.env)
    return c.json({ code: 200, message: "success", data: null })
  } catch (error: any) {
    return c.json(
      { code: 400, message: error?.message || String(error), data: null },
      400,
    )
  }
})
daxiangAuthRouter.post("/auth/folders", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    let addition: DaxiangAddition
    if (body.session_id) {
      const { session } = await loadSession(c.env, body.session_id)
      const result = resultFromSession(session)
      if (!result) throw new Error("daxiang login session is unavailable")
      addition = normalizeAddition({ ...result, api_host: DEFAULT_API_HOST })
    } else {
      const db = await getDb(c.env)
      const storage = (db.storages || []).find(
        (item: any) => Number(item.id) === Number(body.storage_id),
      )
      if (!storage) throw new Error("daxiang storage not found")
      addition = storageAddition(storage)
    }
    if (!isOfficialApiHost(String(addition.api_host || "")))
      throw new Error("Daxiang API host is not an official neixin.cn address")
    if (!authComplete(addition as any))
      throw new Error("daxiang login credentials are incomplete")
    const driver = new DaxiangDriver(addition)
    await driver.init()
    const listing = await driver.browseFolders(String(body.path || "/"))
    return c.json({ code: 200, message: "success", data: listing })
  } catch (error: any) {
    return c.json(
      { code: 502, message: error?.message || String(error), data: null },
      502,
    )
  }
})
