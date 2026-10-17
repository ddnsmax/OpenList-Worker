import {
  calcFileType,
  FileItem,
  StorageDriver,
} from "../../internal/driver/base"
import type { DaxiangAddition, DaxiangListData } from "./types"
import { DaxiangAuthError, DaxiangClient } from "./client"
import {
  authComplete,
  encodeCfp,
  firstString,
  boolValue,
  joinPath,
  isOfficialApiHost,
  normalizeAddition,
  normalizePath,
  itemFromMap,
  numberValue,
} from "./util"

const CHUNK_SIZE = 20 * 1024 * 1024
const RETRIES = 3

function parseAdditional(input: any): DaxiangAddition {
  return normalizeAddition(input || {})
}
function dirname(path: string): string {
  const clean = normalizePath(path)
  const i = clean.lastIndexOf("/")
  return i > 0 ? clean.slice(0, i) : "/"
}
function basename(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).pop() || ""
}

export class DaxiangDriver implements StorageDriver {
  private readonly addition: DaxiangAddition
  private readonly client: DaxiangClient
  private readonly onAddition?: (
    addition: DaxiangAddition,
  ) => void | Promise<void>
  private baseAPI = ""
  private uploadAPI = ""

  constructor(
    input: DaxiangAddition,
    onAddition?: (addition: DaxiangAddition) => void | Promise<void>,
  ) {
    this.addition = parseAdditional(input)
    this.onAddition = onAddition
    this.client = new DaxiangClient(this.addition, async (next) => {
      await onAddition?.(next)
    })
  }

  async init(): Promise<void> {
    if (!authComplete(this.addition))
      throw new Error("Daxiang requires ck, al, uid, uuid and cookie or dx_sso")
    const root = normalizePath(this.addition.root_folder_path || "/")
    const expected = `/person/${this.addition.uid}`
    const physicalRoot = root === "/" ? expected : root
    if (physicalRoot !== expected && !physicalRoot.startsWith(`${expected}/`))
      throw new Error(`Daxiang root path must be within ${expected}`)
    this.addition.root_folder_path = physicalRoot
    if (!isOfficialApiHost(String(this.addition.api_host || "")))
      throw new Error("Daxiang API host is not an official neixin.cn address")
    this.baseAPI = `${String(this.addition.api_host).replace(/\/$/, "")}/pan/base`
    this.uploadAPI = `${String(this.addition.api_host).replace(/\/$/, "")}/pan/ul`
    await this.request("/7/storage/path_info.json", { path: physicalRoot })
  }

  /**
   * resolvePath() operates on the mount-relative path.  Daxiang's API does
   * not have a virtual root: every account is rooted at /person/<uid>.
   * Keep this conversion at the driver boundary so requests made before the
   * normalized addition has been persisted are still scoped to the account.
   */
  private physicalPath(value: string): string {
    const clean = normalizePath(value || "/")
    const expected = `/person/${String(this.addition.uid || "").trim()}`
    if (!expected || expected === "/person/") return clean
    if (clean === expected || clean.startsWith(`${expected}/`)) return clean
    const configured = normalizePath(this.addition.root_folder_path || "/")
    if (configured !== "/") {
      if (clean === configured || clean.startsWith(`${configured}/`)) return clean
      return joinPath(configured, clean)
    }
    return clean === "/" ? expected : joinPath(expected, clean)
  }

  private async request<T = any>(
    endpoint: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    try {
      return await this.client.json<T>(endpoint, payload, headers)
    } catch (error) {
      if (error instanceof DaxiangAuthError)
        throw new Error("Daxiang authentication expired")
      throw error
    }
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const directory = this.physicalPath(
      physicalPath || this.addition.root_folder_path || "/",
    )
    const result: FileItem[] = []
    for (let page = 0; page < 10000; page++) {
      const data = await this.request<DaxiangListData>(
        "/7/sync/path_childs.json",
        {
          path: directory,
          limit: 200,
          offset: page * 200,
          orderBy: "UTS",
          orderType: "DESC",
          category: "",
        },
      )
      const children = data?.childs || []
      const before = result.length
      for (const child of children) result.push(itemFromMap(child))
      if (!boolValue(data?.hasNext)) return result
      if (result.length === before)
        throw new Error("Daxiang pagination returned no progress")
    }
    throw new Error("Daxiang pagination limit exceeded")
  }

  async browseFolders(
    current: string,
  ): Promise<{
    root: string
    current: string
    folders: { name: string; path: string }[]
  }> {
    if (!authComplete(this.addition))
      throw new Error("Daxiang login credentials are incomplete")
    const root = `/person/${this.addition.uid}`
    const candidate = normalizePath(current || "/")
    const directory = candidate === "/" ? root : this.physicalPath(candidate)
    if (directory !== root && !directory.startsWith(`${root}/`))
      throw new Error(`folder path must be within ${root}`)
    const folders: { name: string; path: string }[] = []
    for (let page = 0; page < 10000; page++) {
      const data = await this.request<DaxiangListData>(
        "/7/sync/path_childs.json",
        {
          path: directory,
          limit: 200,
          offset: page * 200,
          orderBy: "UTS",
          orderType: "DESC",
          category: "",
        },
      )
      const children = data?.childs || []
      for (const child of children) {
        const item = itemFromMap(child)
        if (item.is_dir)
          folders.push({
            name: item.name,
            path:
              firstString(
                (child || {}) as Record<string, unknown>,
                "path",
                "fullPath",
                "filePath",
              ) || joinPath(directory, item.name),
          })
      }
      if (!boolValue(data?.hasNext))
        return { root, current: directory, folders }
      if (!children.length)
        throw new Error("Daxiang folder pagination returned no progress")
    }
    throw new Error("Daxiang folder pagination limit exceeded")
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const clean = this.physicalPath(physicalPath || "/")
    if (clean === "/" || clean === this.addition.root_folder_path)
      return {
        name: basename(clean) || "root",
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: clean,
        type: 1,
        raw_url: "",
      }
    const parent = dirname(clean)
    const name = basename(clean)
    const files = await this.list("", parent)
    const found = files.find((item) => item.name === name || item.sign === name)
    if (!found) throw new Error(`Daxiang item not found: ${clean}`)
    if (found.is_dir) return found
    const data = await this.request<{ downloadUrl?: string }>(
      "/7/swift/download_tempurl.json",
      { path: clean, strictAuth: true, wmParam: {} },
    )
    if (!data.downloadUrl)
      throw new Error("Daxiang returned an empty download URL")
    if (!isOfficialUrl(data.downloadUrl))
      throw new Error("Daxiang returned a disallowed download address")
    return {
      ...found,
      raw_url: data.downloadUrl,
      raw_url_headers: {
        "User-Agent": this.addition.user_agent || "",
        Referer: "https://x.sankuai.com/",
      },
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const full = this.physicalPath(physicalPath)
    await this.request("/7/storage/create_dir.json", {
      path: full,
      isDir: 1,
      md5: "",
      objectPath: "",
    })
  }

  private async opver(path: string): Promise<unknown> {
    const data = await this.request<{ opver?: unknown }>(
      "/7/sync/queryopver.json",
      { path },
    )
    if (data?.opver === undefined) throw new Error("Daxiang returned no opver")
    return data.opver
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const clean = this.physicalPath(physicalPath)
    const found = (await this.list("", dirname(clean))).find(
      (x) => x.name === basename(clean),
    )
    await this.request("/7/storage/rename.json", {
      path: clean,
      newName,
      opver: await this.opver(clean),
      isDir: found?.is_dir ? 1 : 0,
    })
  }

  private async moveOrCopy(
    srcPhysical: string,
    dstPhysical: string,
    move: boolean,
  ): Promise<void> {
    const source = this.physicalPath(srcPhysical)
    const destination = this.physicalPath(dstPhysical)
    if (!source || !destination || source === destination)
      throw new Error("Daxiang source and destination are invalid")
    if (destination.startsWith(`${source}/`))
      throw new Error("Daxiang cannot move or copy a directory into itself")
    const found = (await this.list("", dirname(source))).find(
      (x) => x.name === basename(source),
    )
    const item = {
      path: source,
      newPath: destination,
      isDir: found?.is_dir ? 1 : 0,
      opver: await this.opver(source),
    }
    await this.request(
      move ? "/7/storage/batch_move.json" : "/7/storage/batch_copy.json",
      move ? { moveFiles: [item] } : { copyFiles: [item] },
    )
  }
  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    return this.moveOrCopy(srcPhysical, dstPhysical, true)
  }
  async copy(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    return this.moveOrCopy(srcPhysical, dstPhysical, false)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const clean = this.physicalPath(physicalPath)
    const found = (await this.list("", dirname(clean))).find(
      (x) => x.name === basename(clean),
    )
    const item: Record<string, unknown> = {
      path: clean,
      name: basename(clean),
      isDir: found?.is_dir ? 1 : 0,
      opver: await this.opver(clean),
    }
    if (found?.sign && found.sign !== clean) item.id = found.sign
    await this.request("/7/storage/batch_del.json", { delFiles: [item] })
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const full = this.physicalPath(physicalPath)
    const name = basename(full)
    const parent = dirname(full)
    const stage = joinPath(
      parent,
      `.openlist-upload-${crypto.randomUUID?.() || Date.now()}${name.includes(".") ? `.${name.split(".").pop()}` : ""}`,
    )
    if (content.byteLength <= CHUNK_SIZE)
      await this.uploadSingle(stage, name, content)
    else await this.uploadMultipart(stage, name, content)
    await this.commitUpload(stage, full, name)
  }

  private async commitUpload(stage: string, target: string, targetName: string): Promise<void> {
    const parent = dirname(target)
    const existing = (await this.list("", parent)).find((item) => item.name === targetName)
    let backup = ""
    if (existing) {
      backup = joinPath(parent, `.openlist-backup-${crypto.randomUUID?.() || Date.now()}${targetName.includes(".") ? `.${targetName.split(".").pop()}` : ""}`)
      await this.rename("", target, basename(backup))
    }
    try {
      await this.moveOrCopy(stage, target, true)
    } catch (error) {
      if (backup) {
        try { await this.rename("", backup, targetName) } catch {}
      }
      try { await this.remove("", stage, [basename(stage)]) } catch {}
      throw error
    }
    if (backup) await this.remove("", backup, [basename(backup)])
  }

  private async uploadSingle(
    path: string,
    fileName: string,
    content: Uint8Array,
  ): Promise<void> {
    const data = await this.client.upload(
      "/7/storage/create.json",
      fileName,
      "application/octet-stream",
      content,
      encodeCfp({ path, isDir: 0 }),
    )
    if (!data) throw new Error("Daxiang upload returned no data")
  }
  private async uploadMultipart(
    path: string,
    fileName: string,
    content: Uint8Array,
  ): Promise<void> {
    const init = await this.client.uploadJson<{ uploadId?: string }>(
      "/7/ul/multi/init.json",
      { type: "NORMAL" },
    )
    const uploadId = String(init?.uploadId || "")
    if (!uploadId) throw new Error("Daxiang returned an empty upload ID")
    const parts: string[] = []
    for (
      let offset = 0, index = 0;
      offset < content.byteLength;
      offset += CHUNK_SIZE, index++
    ) {
      const chunk = content.slice(
        offset,
        Math.min(offset + CHUNK_SIZE, content.byteLength),
      )
      let part: any
      let last: unknown
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          part = await this.client.upload(
            "/7/ul/part/upload.json",
            fileName,
            "application/octet-stream",
            chunk,
            encodeCfp({ uploadId, partNum: index }),
          )
          break
        } catch (e) {
          last = e
          if (attempt + 1 < RETRIES)
            await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
        }
      }
      if (!part) throw last || new Error("Daxiang part upload failed")
      parts.push(String(part.partId || ""))
    }
    await this.client.uploadJson(
      "/7/storage/multi/create.json",
      { uploadId, partIds: parts },
      { cfp: encodeCfp({ path, isDir: 0 }), mat: "XSID" },
    )
  }

  async createUploadSession(
    _virtualDir: string,
    physicalDir: string,
    fileName: string,
    size: number,
  ): Promise<{
    reuse: boolean
    partCount: number
    chunkSize: number
    session: string
  }> {
    const partCount = Math.max(
      1,
      Math.ceil(Math.max(0, Number(size) || 0) / CHUNK_SIZE),
    )
    const init = await this.client.uploadJson<{ uploadId?: string }>(
      "/7/ul/multi/init.json",
      { type: "NORMAL" },
    )
    const uploadId = String(init?.uploadId || "")
    if (!uploadId) throw new Error("Daxiang returned an empty upload ID")
    const targetPath = this.physicalPath(joinPath(physicalDir, fileName))
    const stagePath = joinPath(
      dirname(targetPath),
      `.openlist-upload-${crypto.randomUUID?.() || Date.now()}${fileName.includes(".") ? `.${fileName.split(".").pop()}` : ""}`,
    )
    return {
      reuse: false,
      partCount,
      chunkSize: CHUNK_SIZE,
      session: JSON.stringify({
        uploadId,
        path: stagePath,
        targetPath,
        fileName,
        partCount,
        size,
      }),
    }
  }
  async uploadPart(
    sessionToken: string,
    partNumber: number,
    content: Buffer,
  ): Promise<{ partNumber: number; partMd5?: string }> {
    const session = JSON.parse(sessionToken)
    if (partNumber < 1 || partNumber > session.partCount)
      throw new Error("Daxiang invalid part number")
    const part = await this.client.upload(
      "/7/ul/part/upload.json",
      session.fileName,
      "application/octet-stream",
      content,
      encodeCfp({ uploadId: session.uploadId, partNum: partNumber - 1 }),
    )
    return { partNumber, partMd5: String(part.partId || "") }
  }
  async completeUploadSession(
    sessionToken: string,
    partTokens: any[] = [],
  ): Promise<void> {
    const session = JSON.parse(sessionToken)
    if (partTokens.length !== session.partCount || partTokens.some((value) => !String(value || "")))
      throw new Error("Daxiang multipart upload is missing parts")
    await this.client.uploadJson(
      "/7/storage/multi/create.json",
      { uploadId: session.uploadId, partIds: partTokens.map(String) },
      { cfp: encodeCfp({ path: session.path, isDir: 0 }), mat: "XSID" },
    )
    await this.commitUpload(
      session.path,
      session.targetPath || session.path,
      session.fileName,
    )
  }
}

function isOfficialUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return false
    const host = url.hostname.toLowerCase().replace(/\.$/, "")
    return (
      !/^\d/.test(host) &&
      ["neixin.cn", "meituan.com", "meituan.net", "sankuai.com"].some(
        (domain) => host === domain || host.endsWith(`.${domain}`),
      )
    )
  } catch {
    return false
  }
}

export function normalizeDaxiangAddition(a: any): DaxiangAddition {
  return parseAdditional(a)
}
