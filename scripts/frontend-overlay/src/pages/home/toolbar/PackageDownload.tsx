import "~/utils/zip-stream.js"
import streamSaver from "streamsaver"
import { getLinkByDirAndObj, useRouter, useT } from "~/hooks"
import { api, fsList, joinBase, pathBase, pathJoin } from "~/utils"
import { password, selectedObjs as _selectedObjs } from "~/store"
import { createSignal, For, Show } from "solid-js"
import {
  Button,
  Heading,
  ModalBody,
  ModalFooter,
  Text,
  VStack,
} from "@hope-ui/solid"
import { Obj } from "~/types"

streamSaver.mitm = joinBase("streamer", "mitm.html")
const trimSlash = (str: string) => {
  return str.replace(/^\/+|\/+$/g, "")
}

let totalSize = 0
interface File {
  path: string
  url: string
  source: string
}

const PackageDownload = (props: { onClose: () => void }) => {
  const t = useT()
  const [cur, setCur] = createSignal(t("home.package_download.initializing"))
  const [downloadURL, setDownloadURL] = createSignal("")
  const [downloadName, setDownloadName] = createSignal("")
  const [status, setStatus] = createSignal(0)
  const { pathname, isShare } = useRouter()
  const selectedObjs = _selectedObjs()
  const fetchFolderStructure = async (
    pre: string,
    obj: Obj,
  ): Promise<File[] | string> => {
    if (!obj.is_dir) {
      totalSize += obj.size
      return [
        {
          path: pathJoin(pre, obj.name),
          source: pathJoin(pathname(), pre, obj.name),
          url: getLinkByDirAndObj(
            pathJoin(pathname(), pre),
            obj,
            "direct",
            isShare(),
            true,
          ),
        },
      ]
    } else {
      const resp = await fsList(pathJoin(pathname(), pre, obj.name), password())
      if (resp.code !== 200) {
        return resp.message
      }
      const res: File[] = []
      for (const _obj of resp.data.content ?? []) {
        const _res = await fetchFolderStructure(pathJoin(pre, obj.name), _obj)
        if (typeof _res === "string") {
          return _res
        } else {
          res.push(..._res)
        }
      }
      return res
    }
  }
  const [fetchings, setFetchings] = createSignal<string[]>([])
  const tryDaxiangPackage = async (saveName: string) => {
    const response = await fetch(`${api}/api/fs/daxiang_package`, {
      method: "POST",
      headers: {
        Authorization: localStorage.getItem("token") || "",
        "Content-Type": "application/json;charset=utf-8",
      },
      body: JSON.stringify({
        name: saveName,
        password: password(),
        items: selectedObjs.map((obj) => ({
          name: obj.name,
          path: pathJoin(pathname(), obj.name),
        })),
      }),
    })
    const result = await response.json()
    if (!response.ok || result.code !== 200) {
      throw new Error(result.message || response.statusText)
    }
    if (result.data?.applicable === false) {
      return false
    }
    if (!result.data?.ticket) {
      throw new Error(result.message || "Invalid package response")
    }
    setDownloadURL(
      `${api}/daxiang-package/${encodeURIComponent(result.data.ticket)}`,
    )
    setDownloadName(`${saveName}.zip`)
    setCur(`${t("home.package_download.ready")}`)
    setStatus(4)
    return true
  }
  const run = async () => {
    totalSize = 0
    let saveName = pathBase(pathname())
    if (selectedObjs.length === 1) {
      saveName = selectedObjs[0].name
    }
    if (!saveName) {
      saveName = t("manage.sidemenu.home")
    }
    setCur(t("home.package_download.fetching_struct"))
    setStatus(2)
    try {
      if (await tryDaxiangPackage(saveName)) {
        return
      }
    } catch (err) {
      setCur(`${t("home.package_download.failed")}: ${err}`)
      setStatus(1)
      return
    }
    const downFiles: File[] = []
    for (const obj of selectedObjs) {
      const res = await fetchFolderStructure("", obj)
      if (typeof res === "string") {
        setCur(`${t("home.package_download.fetching_struct_failed")}: ${res}`)
        setStatus(1)
        return res
      } else {
        downFiles.push(...res)
      }
    }
    setCur(t("home.package_download.downloading"))
    setStatus(3)
    let fileStream = streamSaver.createWriteStream(`${saveName}.zip`, {
      size: totalSize,
    })
    let fileArr = downFiles.values()
    let readableZipStream = new (window as any).ZIP({
      pull(ctrl: any) {
        const it = fileArr.next()
        if (it.done) {
          ctrl.close()
        } else {
          let name = trimSlash(it.value.path)
          if (selectedObjs.length === 1) {
            name = name.replace(`${saveName}/`, "")
          }
          const url = it.value.url
          return fetch(url).then((res) => {
            if (!res.ok) {
              throw new Error(
                `Failed to fetch ${name}: ${res.status} ${res.statusText}`,
              )
            }
            setFetchings((prev) => [...prev, name])
            ctrl.enqueue({
              name,
              stream: res.body,
            })
          })
        }
      },
    })
    if (window.WritableStream && readableZipStream.pipeTo) {
      return readableZipStream
        .pipeTo(fileStream)
        .then(() => {
          setCur(`${t("home.package_download.success")}`)
          setStatus(4)
        })
        .catch((err: any) => {
          setCur(`${t("home.package_download.failed")}: ${err}`)
          setStatus(1)
        })
    }
  }
  run()

  return (
    <>
      <ModalBody>
        <VStack w="$full" alignItems="start" spacing="$2">
          <Heading>
            {t(`home.package_download.current_status`)}: {cur()}
          </Heading>
          <For each={fetchings()}>
            {(name) => (
              <Text
                css={{
                  wordBreak: "break-all",
                }}
              >
                {t("home.package_download.fetching_file")}: {name}
              </Text>
            )}
          </For>
        </VStack>
      </ModalBody>
      <Show when={[1, 4].includes(status())}>
        <ModalFooter>
          <Show when={status() === 4 && downloadURL()}>
            <Button
              as="a"
              colorScheme="accent"
              href={downloadURL()}
              download={downloadName()}
              onClick={() => {
                setCur(`${t("home.package_download.downloading")}`)
              }}
            >
              {t("home.preview.download")}
            </Button>
          </Show>
          <Button colorScheme="info" onClick={props.onClose}>
            {t("global.close")}
          </Button>
        </ModalFooter>
      </Show>
    </>
  )
}

export default PackageDownload
