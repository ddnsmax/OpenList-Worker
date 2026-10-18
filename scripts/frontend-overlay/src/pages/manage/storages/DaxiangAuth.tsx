import {
  Alert,
  AlertIcon,
  Button,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  Image,
  Select,
  Text,
  VStack,
} from "@hope-ui/solid"
import QRCode from "qrcode"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { SelectOptions } from "~/components"
import { useT } from "~/hooks"
import { notify, r } from "~/utils"
import type { Resp } from "~/types"

interface AuthState {
  session_id: string
  status: string
  message?: string
  qr_code_url?: string
  authenticated: boolean
  expires_at: number
}

interface Props {
  editing: boolean
  authenticated: boolean
  storageID?: number
  onAuthenticated: (sessionId: string) => void
  onLoggedOut: () => void
}

interface ExistingAccount {
  storage_id: number
  mount_path: string
}

const DaxiangAuth = (props: Props) => {
  const t = useT()
  const [sessionID, setSessionID] = createSignal("")
  const [state, setState] = createSignal<AuthState>()
  const [qrImage, setQRImage] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [accounts, setAccounts] = createSignal<ExistingAccount[]>([])
  const [loginSource, setLoginSource] = createSignal("new")
  let timer: number | undefined
  let polling = false
  let pollFailures = 0

  const stopPolling = () => {
    if (timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }

  onCleanup(() => {
    stopPolling()
    const id = sessionID()
    if (id && !state()?.authenticated) {
      void r.post(
        `/admin/daxiang/auth/cancel?session_id=${encodeURIComponent(id)}`,
      )
    }
  })

  createEffect(async () => {
    const value = state()?.qr_code_url
    if (value) {
      setQRImage(await QRCode.toDataURL(value, { width: 240, margin: 1 }))
    } else {
      setQRImage("")
    }
  })

  const applyState = (value: AuthState, successMessage?: string) => {
    setState(value)
    setSessionID(value.session_id)
    if (value.authenticated) {
      stopPolling()
      props.onAuthenticated(value.session_id)
      notify.success(successMessage || "大象扫码登录成功，可以保存挂载")
    }
  }

  const request = async (path: string, data: Record<string, any>) => {
    const resp = (await r.post(path, data)) as Resp<AuthState>
    if (resp.code !== 200) {
      const error: any = new Error(resp.message || "请求失败")
      error.status = resp.code
      throw error
    }
    applyState(resp.data)
    return resp.data
  }

  onMount(async () => {
    if (props.editing) return
    try {
      const resp = (await r.get("/admin/daxiang/auth/accounts")) as Resp<
        ExistingAccount[]
      >
      if (resp.code === 200) setAccounts(resp.data || [])
    } catch {}
  })

  const run = async (fn: () => Promise<void>) => {
    if (loading()) return
    setLoading(true)
    try {
      await fn()
    } catch (error: any) {
      notify.error(error?.message || "大象扫码登录请求失败")
    } finally {
      setLoading(false)
    }
  }

  const pollQR = async () => {
    if (polling || !sessionID()) return
    polling = true
    try {
      const value = await request("/admin/daxiang/auth/qr/status", {
        session_id: sessionID(),
      })
      pollFailures = 0
      if (value.status === "expired" || value.authenticated) stopPolling()
    } catch (error: any) {
      const status = Number(error?.response?.status || error?.status)
      const message = String(error?.response?.data?.message || error?.message || "")
      if (status === 401 || /session expired/i.test(message)) {
        stopPolling()
        notify.error(message || "扫码会话已过期，请重新生成二维码")
      } else {
        pollFailures += 1
        if (pollFailures === 3)
          notify.warning("扫码状态暂时无法读取，页面将继续重试")
      }
    } finally {
      polling = false
    }
  }

  const clearSession = async () => {
    const id = sessionID()
    stopPolling()
    if (id) {
      await r.post(
        `/admin/daxiang/auth/cancel?session_id=${encodeURIComponent(id)}`,
      )
    }
    setSessionID("")
    setState()
    setQRImage("")
  }

  const startQR = () =>
    run(async () => {
      setLoginSource("new")
      await clearSession()
      const value = await request("/admin/daxiang/auth/start", {})
      await request("/admin/daxiang/auth/qr/start", {
        session_id: value.session_id,
      })
      timer = window.setInterval(() => void pollQR(), 2000)
    })

  const changeLoginSource = (value: string) =>
    run(async () => {
      setLoginSource(value)
      await clearSession()
      props.onLoggedOut()
      if (value === "new") return
      const storageID = Number(value.replace("storage:", ""))
      const resp = (await r.post("/admin/daxiang/auth/reuse", {
        storage_id: storageID,
      })) as Resp<AuthState>
      if (resp.code !== 200) {
        throw new Error(resp.message || t("drivers.Daxiang.reuse_login_failed"))
      }
      applyState(resp.data, t("drivers.Daxiang.reuse_login_success"))
    })

  const logout = () =>
    run(async () => {
      if (props.storageID) {
        const resp = (await r.post("/admin/daxiang/auth/logout", {
          storage_id: props.storageID,
        })) as Resp<unknown>
        if (resp.code !== 200) {
          throw new Error(resp.message || "退出登录失败")
        }
      }
      await clearSession()
      props.onLoggedOut()
      notify.success("已退出大象登录")
    })

  return (
    <VStack
      w="$full"
      gridColumn="1 / -1"
      alignItems="stretch"
      spacing="$3"
      p="$4"
      border="1px solid $neutral6"
      borderRadius="$lg"
    >
      <Heading size="sm">大象扫码登录</Heading>
      <Show when={!props.editing && accounts().length > 0}>
        <FormControl w="$full">
          <FormLabel>{t("drivers.Daxiang.login_source")}</FormLabel>
          <Select value={loginSource()} onChange={changeLoginSource}>
            <SelectOptions
              options={[
                {
                  key: "new",
                  label: t("drivers.Daxiang.login_new_account"),
                },
                ...accounts().map((account) => ({
                  key: `storage:${account.storage_id}`,
                  label: `${t("drivers.Daxiang.use_logged_account")}：${account.mount_path}`,
                })),
              ]}
            />
          </Select>
        </FormControl>
      </Show>
      <Show
        when={props.editing && !props.authenticated && !state()?.authenticated}
      >
        <Alert status="info">
          <AlertIcon />
          当前大象账号未登录，请扫码登录。
        </Alert>
      </Show>
      <Show
        when={state()?.authenticated || (props.authenticated && !qrImage())}
      >
        <VStack alignItems="stretch" spacing="$2">
          <Alert status="success">
            <AlertIcon />
            登录验证完成，保存后OpenList会自动使用登录令牌。
          </Alert>
          <HStack spacing="$2" flexWrap="wrap">
            <Button
              variant="outline"
              minW="112px"
              loading={loading()}
              onClick={startQR}
            >
              重新扫码
            </Button>
            <Show when={state()?.authenticated || props.authenticated}>
              <Button
                colorScheme="danger"
                variant="outline"
                minW="112px"
                loading={loading()}
                onClick={logout}
              >
                退出登录
              </Button>
            </Show>
          </HStack>
        </VStack>
      </Show>
      <Show
        when={!state()?.authenticated && !props.authenticated && !qrImage()}
      >
        <Button
          colorScheme="accent"
          alignSelf="flex-start"
          loading={loading()}
          onClick={startQR}
        >
          生成登录二维码
        </Button>
      </Show>
      <Show when={state()?.message && !state()?.authenticated}>
        <Alert status={state()?.status === "error" ? "danger" : "warning"}>
          <AlertIcon />
          {state()?.message}
        </Alert>
      </Show>
      <Show when={qrImage() && !state()?.authenticated}>
        <VStack alignItems="flex-start" spacing="$2">
          <Image
            src={qrImage()}
            alt="大象扫码登录二维码"
            width="240px"
            height="240px"
          />
          <Text>请使用大象移动端扫描并确认登录，页面会自动更新状态。</Text>
          <Button variant="outline" loading={loading()} onClick={startQR}>
            重新生成二维码
          </Button>
        </VStack>
      </Show>
    </VStack>
  )
}

export { DaxiangAuth }
