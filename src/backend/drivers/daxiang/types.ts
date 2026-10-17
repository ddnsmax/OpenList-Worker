export interface DaxiangAddition {
  root_folder_path?: string
  cookie?: string
  app_id?: string
  ck?: string
  al?: string
  uid?: string
  uuid?: string
  dx_sign?: string
  dx_sso?: string
  auth_session_id?: string
  credential_updated_at?: number
  user_agent?: string
  api_host?: string
  keep_alive_minutes?: number
  credential_ciphertext?: string
}

export interface DaxiangFolder {
  name: string
  path: string
}

export interface DaxiangFolderListing {
  root: string
  current: string
  folders: DaxiangFolder[]
}

export interface DaxiangAuthResult {
  cookie: string
  app_id: string
  ck: string
  al: string
  uid: string
  uuid: string
  dx_sign: string
  dx_sso: string
}

export interface DaxiangAuthState {
  session_id: string
  status: string
  message?: string
  factors?: string[]
  masked_mobile?: string
  inter_code?: string
  captcha_image?: string
  qr_code_url?: string
  authenticated: boolean
  expires_at: number
}

export interface DaxiangApiEnvelope<T = unknown> {
  rescode?: number
  code?: number
  message?: string
  error?: unknown
  data?: T
}

export interface DaxiangListData {
  childs?: Record<string, unknown>[]
  hasNext?: unknown
}
