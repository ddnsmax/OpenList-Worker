import {
  Box,
  Button,
  FormControl,
  FormLabel,
  HStack,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Spinner,
  Text,
  VStack,
} from "@hope-ui/solid"
import { BiSolidFolderOpen } from "solid-icons/bi"
import { createSignal, For, Show } from "solid-js"
import { useT } from "~/hooks"
import type { Resp } from "~/types"
import { notify, r } from "~/utils"

interface Folder {
  name: string
  path: string
}

interface FolderListing {
  root: string
  current: string
  folders: Folder[]
}

interface Props {
  value: string
  sessionID: string
  storageID?: number
  enabled: boolean
  onChange: (value: string) => void
}

const DaxiangFolderPicker = (props: Props) => {
  const t = useT()
  const [opened, setOpened] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [listing, setListing] = createSignal<FolderListing>()

  const load = async (path: string) => {
    if (loading()) return
    setLoading(true)
    try {
      const resp = (await r.post("/admin/daxiang/auth/folders", {
        session_id: props.sessionID,
        storage_id: props.storageID || 0,
        path,
      })) as Resp<FolderListing>
      if (resp.code !== 200) {
        throw new Error(resp.message || t("drivers.Daxiang.folder_load_failed"))
      }
      setListing(resp.data)
    } catch (error: any) {
      notify.error(error?.message || t("drivers.Daxiang.folder_load_failed"))
    } finally {
      setLoading(false)
    }
  }

  const open = async () => {
    if (!props.enabled) {
      notify.warning(t("drivers.Daxiang.login_before_browse"))
      return
    }
    setOpened(true)
    await load(props.value || "/")
  }

  const parentPath = () => {
    const value = listing()?.current || ""
    const root = listing()?.root || ""
    if (!value || value === root) return root
    const index = value.lastIndexOf("/")
    const parent = index > 0 ? value.slice(0, index) : root
    return parent.length < root.length ? root : parent
  }

  return (
    <FormControl
      w="$full"
      gridColumn="1 / -1"
      display="flex"
      flexDirection="column"
    >
      <FormLabel for="root_folder_path">
        {t("drivers.Daxiang.root_folder_path")}
      </FormLabel>
      <HStack w="$full" spacing="$2">
        <Input
          id="root_folder_path"
          value={props.value}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
        <Button
          disabled={!props.enabled}
          onClick={open}
          css={{ whiteSpace: "nowrap" }}
        >
          {t("drivers.Daxiang.browse_folder")}
        </Button>
      </HStack>
      <Modal
        size="xl"
        blockScrollOnMount={false}
        opened={opened()}
        onClose={() => setOpened(false)}
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{t("drivers.Daxiang.choose_root_folder")}</ModalHeader>
          <ModalBody>
            <VStack alignItems="stretch" spacing="$3">
              <Box p="$2" border="1px solid $neutral6" borderRadius="$md">
                <Text css={{ overflowWrap: "anywhere" }}>
                  {listing()?.current || t("global.loading")}
                </Text>
              </Box>
              <Show when={loading()}>
                <HStack justifyContent="center" py="$6">
                  <Spinner />
                </HStack>
              </Show>
              <Show when={!loading() && listing()?.current !== listing()?.root}>
                <Button
                  variant="outline"
                  justifyContent="flex-start"
                  onClick={() => void load(parentPath())}
                >
                  {t("drivers.Daxiang.parent_folder")}
                </Button>
              </Show>
              <Show
                when={!loading() && (listing()?.folders.length || 0) > 0}
                fallback={
                  <Show when={!loading()}>
                    <Text color="$neutral11">
                      {t("drivers.Daxiang.no_subfolders")}
                    </Text>
                  </Show>
                }
              >
                <For each={listing()?.folders || []}>
                  {(folder) => (
                    <Button
                      variant="outline"
                      justifyContent="flex-start"
                      leftIcon={<BiSolidFolderOpen />}
                      onClick={() => void load(folder.path)}
                    >
                      {folder.name}
                    </Button>
                  )}
                </For>
              </Show>
            </VStack>
          </ModalBody>
          <ModalFooter display="flex" gap="$2">
            <Button colorScheme="neutral" onClick={() => setOpened(false)}>
              {t("global.cancel")}
            </Button>
            <Button
              disabled={loading() || !listing()?.current}
              onClick={() => {
                const value = listing()?.current
                if (!value) return
                props.onChange(value)
                setOpened(false)
              }}
            >
              {t("drivers.Daxiang.choose_this_folder")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </FormControl>
  )
}

export { DaxiangFolderPicker }
