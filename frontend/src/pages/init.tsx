import { Button, FormControl, FormLabel, Input, VStack } from "@hope-ui/solid"
import { createSignal } from "solid-js"
import { notify, r } from "~/utils"

export default function Init() {
  const [username, setUsername] = createSignal("admin")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const response: any = await r.post("/public/init/setup", {
        username: username(),
        password: password(),
      })
      if (response.code !== 200) throw new Error(response.message || "初始化失败")
      location.reload()
    } catch (error: any) {
      notify.error(error?.message || "初始化失败")
    } finally {
      setBusy(false)
    }
  }
  return (
    <VStack maxW="420px" m="auto" p="$8" spacing="$4" alignItems="stretch">
      <FormControl>
        <FormLabel>管理员用户名</FormLabel>
        <Input value={username()} onInput={(e) => setUsername(e.currentTarget.value)} />
      </FormControl>
      <FormControl>
        <FormLabel>管理员密码</FormLabel>
        <Input type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
      </FormControl>
      <Button loading={busy()} onClick={submit}>完成初始化</Button>
    </VStack>
  )
}
