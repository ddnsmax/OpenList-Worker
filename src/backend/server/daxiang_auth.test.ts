import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { getDb, saveDb } from "../internal/model/db"
import { daxiangAuthRouter, materializeDaxiangAddition } from "./daxiang_auth"
import { adminRouter } from "./admin"

const prefix = "/api/admin/daxiang"
const token = "daxiang-regression-admin"
const credentials = {
  xsid: "test-ck",
  alToken: "test-al",
  uid: "159",
  uuid: "test-uuid",
  dxSsoId: "test-sso",
}

async function fixture(t: any) {
  const data = new Map<string, string>()
  let hideList = false
  const env = {
    DB_DRIVER: "blob",
    DB_FORMAT: "map",
    JWT_SECRET: "daxiang-test-secret-not-a-real-key",
    ESA_BLOB: {
      get: async (key: string) =>
        data.has(key) ? { text: async () => data.get(key)! } : null,
      put: async (key: string, value: string) => { data.set(key, value) },
      delete: async (key: string) => { data.delete(key) },
      list: async ({ prefix }: { prefix: string }) => ({
        keys: hideList ? [] : [...data.keys()]
          .filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      }),
    },
  }
  await getDb(env)
  await saveDb({
    settings: [{ key: "token", value: token }],
    users: [], storages: [], shares: [], metas: [],
  }, env, { force: true })
  const app = new Hono()
  app.route(prefix, daxiangAuthRouter)
  app.route("/api/admin", adminRouter)
  const steps: {
    path: string
    body: any
    status?: number
    headers?: Record<string, string>
    check?: (url: URL, init: RequestInit) => void
  }[] = []
  t.mock.method(globalThis, "fetch", async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const step = steps.shift()
    assert.ok(step, `unexpected external request: ${url.pathname}`)
    assert.equal(url.pathname, step.path)
    step.check?.(url, init)
    const response = new Response(
      typeof step.body === "string" ? step.body : JSON.stringify(step.body),
      { status: step.status || 200, headers: step.headers },
    )
    Object.defineProperty(response, "url", { value: url.toString() })
    return response
  })
  t.after(() => { t.mock.restoreAll() })
  async function request(path: string, body: any = {}, method = "POST") {
    const response = await app.request(
      path.startsWith("/api/") ? path : prefix + path,
      {
        method,
        headers: { Authorization: token, "Content-Type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      }, env,
    )
    return { status: response.status, body: await response.json() as any }
  }
  async function start() {
    steps.push(
      { path: "/sson/auth/oidc/v1/authorize",
        body: '<meta name="ctxId" content="ctx-test">',
        headers: { "set-cookie": "sso_session=fixture; Path=/" } },
      { path: "/sson/auth/profiles/v1/web/loginPage",
        body: { action: { payload: { factors: ["FC_QRCODE"] } } } },
    )
    const started = await request("/auth/start")
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const session_id = started.body.data.session_id
    const qr = await request("/auth/qr/start", { session_id })
    assert.equal(qr.status, 200, JSON.stringify(qr.body))
    assert.match(qr.body.data.qr_code_url, /qrcode\/v1\/ctx-test/)
    return session_id
  }
  return { request, start, steps, data, env,
    hideList: () => { hideList = true },
    done: () => assert.equal(steps.length, 0, "all callback steps must execute") }
}

for (const kind of ["http", "href", "assign", "replace", "meta"]) {
  test(`扫码通过 ${kind} 回调完成认证、浏览、保存、复用和退出`, async (t) => {
    const f = await fixture(t)
    const session_id = await f.start()
    const target = "/finish?ticket=a%26b&mode=web#uuid=test-uuid"
    const escaped = target.replace(/&/g, "&amp;")
    const html = kind === "meta"
      ? `<meta http-equiv="refresh" content="0;url=${escaped}">`
      : kind === "href"
        ? `<script>window.location.href="${escaped}"</script>`
        : `<script>window.location.${kind}("${escaped}")</script>`
    f.steps.push(
      { path: "/sson/auth/qrcode/v1/status",
        body: { action: { payload: { redirectUrl: "https://neixin.meituan.com/callback" } } } },
      { path: "/callback", body: kind === "http" ? "" : html,
        status: kind === "http" ? 302 : 200,
        headers: {
          "set-cookie": "bridge=kept; Path=/, dxSsoId=test-sso; Path=/, uid=159; Path=/",
          ...(kind === "http" ? { location: target } : {}),
        } },
      { path: "/finish",
        body: '<script>createAndLoadImg("/setcookie?uu=test-uuid&amp;u=159")</script>',
        check: (url, init) => {
          assert.equal(url.searchParams.get("ticket"), "a&b")
          assert.match(new Headers(init.headers).get("cookie")!, /bridge=kept/)
        } },
      { path: "/setcookie", body: "", headers: { "set-cookie": "aux=kept; Path=/" },
        check: (url) => assert.equal(url.searchParams.get("u"), "159") },
      { path: "/login/im_token/generate",
        body: { rescode: 0, data: { xsid: "test-ck", alToken: "test-al" } },
        check: (_url, init) => {
          const h = new Headers(init.headers)
          assert.equal(h.get("uu"), "test-uuid")
          assert.match(h.get("cookie")!, /bridge=kept/)
          assert.match(h.get("cookie")!, /aux=kept/)
        } },
    )
    const status = await f.request("/auth/qr/status", { session_id })
    assert.equal(status.status, 200, JSON.stringify(status.body))
    assert.equal(status.body.data.authenticated, true)
    assert.equal(status.body.data.qr_code_url, undefined)
    for (const path of ["/", "/person/159/photos"]) {
      const physical = path === "/" ? "/person/159" : path
      f.steps.push(
        { path: "/pan/base/7/storage/path_info.json", body: { data: {} } },
        { path: "/pan/base/7/sync/path_childs.json",
          body: { data: { childs: [{ name: "child", path: physical + "/child", isDir: 1 }], hasNext: false } },
          check: (_url, init) => {
            assert.ok(JSON.parse(String(init.body)).path.includes(physical))
            assert.equal(new Headers(init.headers).get("ck"), "test-ck")
          } },
      )
      const folders = await f.request("/auth/folders", { session_id, path })
      assert.equal(folders.status, 200, JSON.stringify(folders.body))
      assert.ok(folders.body.data.current.includes(physical))
      assert.deepEqual(folders.body.data.folders, [{ name: "child", path: physical + "/child" }])
    }
    f.steps.push({ path: "/pan/base/7/storage/path_info.json", body: { data: {} } })
    const saved = await f.request("/api/admin/storage/create", {
      driver: "Daxiang", mount_path: "/elephant",
      addition: JSON.stringify({ auth_session_id: session_id, root_folder_path: "/person/159/photos" }),
    })
    assert.equal(saved.body.code, 200, JSON.stringify(saved.body))
    const db = await getDb(f.env)
    const storage = db.storages.find((s: any) => s.mount_path === "/elephant")
    assert.ok(storage)
    const addition = JSON.parse(storage.addition)
    assert.equal(addition.root_folder_path, "/person/159/photos")
    assert.equal(addition.ck, "test-ck")
    assert.match(addition.cookie, /bridge=kept/)
    assert.equal(addition.auth_session_id, undefined)
    const reused = await f.request("/auth/reuse", { storage_id: storage.id })
    assert.equal(reused.body.data.authenticated, true)
    const logout = await f.request("/auth/logout", { storage_id: storage.id })
    assert.equal(logout.body.code, 200)
    const after = await f.request(`/auth/status?storage_id=${storage.id}`, {}, "GET")
    assert.equal(after.body.data.authenticated, false)
    f.done()
  })
}

for (const stage of ["loginPage", "identifier", "autologin"]) {
  test(`TGC 恢复流程继续处理 ${stage} 返回的 redirectUrl`, async (t) => {
    const f = await fixture(t)
    const session_id = await f.start()
    const redirect = { action: { payload: {
      redirectUrl: "https://neixin.meituan.com/complete",
    } } }
    f.steps.push(
      { path: "/sson/auth/qrcode/v1/status", body: { action: { payload: { message: "tgc already exists" } } } },
      { path: "/sson/auth/oidc/v1/authorize", body: '<meta name="ctxId" content="ctx-refreshed">' },
      { path: "/sson/auth/profiles/v1/web/loginPage",
        body: stage === "loginPage" ? redirect : { action: { payload: { historyMis: "fixture-user" } } },
        check: (url) => assert.equal(url.searchParams.get("ctxId"), "ctx-refreshed") },
    )
    if (stage !== "loginPage") f.steps.push({
      path: "/sson/auth/identifier/v1/submit",
      body: stage === "identifier" ? redirect : { action: { payload: { data: { factors: ["FC_MOA_AUTO"] } } } },
    })
    if (stage === "autologin") f.steps.push({ path: "/sson/auth/moa/autologin", body: redirect })
    f.steps.push({ path: "/complete", body: JSON.stringify(credentials) })
    const status = await f.request("/auth/qr/status", { session_id })
    assert.equal(status.status, 200, JSON.stringify(status.body))
    assert.equal(status.body.data.authenticated, true)
    f.done()
  })
}

test("会话按 ID 读取，不依赖 Blob 列表及时可见；过期和取消仍被拒绝", async (t) => {
  const f = await fixture(t)
  const session_id = await f.start()
  f.hideList()
  f.steps.push({ path: "/sson/auth/qrcode/v1/status", body: { action: { payload: credentials } } })
  const status = await f.request("/auth/qr/status", { session_id })
  assert.equal(status.status, 200, JSON.stringify(status.body))
  assert.equal(status.body.data.authenticated, true)
  const key = "openlist_daxiang_auth_" + session_id
  const session = JSON.parse(f.data.get(key)!)
  session.expires_at = Date.now() - 1
  f.data.set(key, JSON.stringify(session))
  assert.equal((await f.request("/auth/qr/status", { session_id })).status, 502)
  await f.request("/auth/cancel", { session_id })
  assert.equal(f.data.has(key), false)
  f.done()
})

test("未扫码、二维码过期、非法回调和令牌交换失败不允许浏览或保存", async (t) => {
  const f = await fixture(t)
  const session_id = await f.start()
  for (const bizCode of [1060004, 1060001]) {
    f.steps.push({ path: "/sson/auth/qrcode/v1/status", body: { action: { bizCode, payload: {} } } })
    const result = await f.request("/auth/qr/status", { session_id })
    assert.equal(result.body.data.authenticated, false)
    assert.equal(result.body.data.status, bizCode === 1060001 ? "expired" : "qr")
  }
  f.steps.push({ path: "/sson/auth/qrcode/v1/status",
    body: { action: { payload: { redirectUrl: "https://outside.invalid/callback" } } } })
  assert.equal((await f.request("/auth/qr/status", { session_id })).status, 502)
  f.steps.push(
    { path: "/sson/auth/qrcode/v1/status",
      body: { action: { payload: { redirectUrl: "https://neixin.meituan.com/callback" } } } },
    { path: "/callback", body: JSON.stringify({ uid: "159", uuid: "test-uuid", dxSsoId: "test-sso" }) },
    { path: "/login/im_token/generate", status: 401, body: {} },
  )
  assert.equal((await f.request("/auth/qr/status", { session_id })).status, 502)
  assert.equal((await f.request("/auth/folders", { session_id })).status, 502)
  await assert.rejects(materializeDaxiangAddition(f.env, { auth_session_id: session_id }), /not authenticated/)
  f.done()
})
