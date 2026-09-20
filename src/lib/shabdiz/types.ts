export const SHABDIZ_HOST = "http://127.0.0.1:3325"
export const SHABDIZ_ENABLED_KEY = "shabdizEnabled"
export const SHABDIZ_PING_MESSAGE = "shabdiz:ping"

/** Give up on a send after this long so a hung app cannot stall a download forever. */
export const SHABDIZ_SEND_TIMEOUT_MS = 8000

export type RequestHeader = {
  name: string
  value?: string
}

/** A network request we observed, used to recover the download's own headers. */
export type CachedRequestInfo = {
  requestId: string
  url: string
  method?: string
  type?: string
  tabId?: number
  frameId?: number
  parentFrameId?: number
  initiator?: string
  requestHeaders: RequestHeader[]
  time: number
}

/** Response headers for a request we observed. */
export type ShabdizResponseInfo = {
  statusCode?: number
  statusLine?: string
  headers: RequestHeader[]
  contentDisposition?: string
  fileSize?: number
}

/**
 * How the download reached us:
 * - "auto"         — a page/script started it and we intercepted it
 * - "context-menu" — the user explicitly picked "Download with Shabdiz"
 */
export type ShabdizSource = "auto" | "context-menu"

export type ShabdizContextInfo = {
  pageUrl?: string
  linkUrl?: string
  srcUrl?: string
  selectionText?: string
}

export type ShabdizDownloadPayload = {
  url: string
  finalUrl?: string
  filename?: string
  mimeType?: string
  /** From the response's Content-Length, when the server sent one. */
  fileSize?: number
  referrer?: string
  tabId?: number
  frameId?: number
  state?: string

  source: ShabdizSource
  explicit: boolean
  /** True when the captured request actually carried a Cookie header. */
  hasCookies: boolean

  headers: RequestHeader[]
  headersObject: Record<string, string>
  responseHeaders: RequestHeader[]
  responseHeadersObject: Record<string, string>

  contentDisposition?: string
  status?: number

  request?: CachedRequestInfo
  download?: unknown

  // Only present for source === "context-menu"
  pageUrl?: string
  linkUrl?: string
  srcUrl?: string
  selectionText?: string
}

export type BuildPayloadOptions = {
  source: ShabdizSource
  explicit?: boolean
  cachedRequest?: CachedRequestInfo | null
  responseInfo?: ShabdizResponseInfo | null
  contextInfo?: ShabdizContextInfo
}
