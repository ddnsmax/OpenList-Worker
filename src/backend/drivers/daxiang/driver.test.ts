import assert from "node:assert/strict"
import { test } from "node:test"
import { DaxiangDriver } from "./driver"

test("大象驱动把挂载根目录映射到账号物理根目录", async () => {
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body || "{}"))
    if (url.includes("path_info.json")) {
      paths.push(String(body.path))
      return new Response(JSON.stringify({ rescode: 0, data: {} }), { status: 200 })
    }
    if (url.includes("path_childs.json")) {
      paths.push(String(body.path))
      return new Response(
        JSON.stringify({
          rescode: 0,
          data: {
            childs: [
              {
                path: "/person/7/docs/a.txt",
                name: "a.txt",
                isDir: 0,
                size: 1,
              },
              {
                path: "/person/7/docs/sub",
                name: "sub",
                isDir: 1,
              },
            ],
            hasNext: false,
          },
        }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch
  try {
    const driver = new DaxiangDriver({
      uid: "7",
      ck: "ck",
      al: "al",
      uuid: "uuid",
      cookie: "sid=sid",
      root_folder_path: "/",
    })
    await driver.init()
    const items = await driver.list("/", "/")
    assert.deepEqual(paths, ["/person/7", "/person/7"])
    assert.equal(items.length, 2)
    assert.equal(items[0].name, "a.txt")
    assert.equal(items[1].is_dir, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
