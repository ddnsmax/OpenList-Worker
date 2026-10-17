import assert from "node:assert/strict"
import { test } from "node:test"
import {
  authComplete,
  isOfficialApiHost,
  normalizePath,
} from "./util"

test("大象路径规范化不会保留 .. 段", () => {
  assert.equal(normalizePath("/person/7/../docs"), "/person/docs")
  assert.equal(normalizePath("foo\\bar"), "/foo/bar")
})

test("大象 API 只接受官方 neixin.cn HTTPS 地址", () => {
  assert.equal(isOfficialApiHost("https://api.neixin.cn"), true)
  assert.equal(isOfficialApiHost("https://sub.api.neixin.cn/"), true)
  assert.equal(isOfficialApiHost("http://api.neixin.cn"), false)
  assert.equal(isOfficialApiHost("https://example.invalid"), false)
  assert.equal(isOfficialApiHost("https://api.neixin.cn:8443"), false)
})

test("大象凭证完整性要求账号字段和会话凭证", () => {
  assert.equal(
    authComplete({ ck: "ck", al: "al", uid: "7", uuid: "u", cookie: "c" }),
    true,
  )
  assert.equal(
    authComplete({ ck: "ck", al: "al", uid: "7", uuid: "u" }),
    false,
  )
})
