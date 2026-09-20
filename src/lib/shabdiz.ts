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

/** Collapse a header list into an object. Later duplicates win. */
export function headersToObject(
  headers: RequestHeader[]
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const header of headers) {
    if (typeof header?.name === "string" && typeof header.value === "string") {
      result[header.name] = header.value
    }
  }

  return result
}

/** Case-insensitive header lookup. */
export function findHeader(
  headers: RequestHeader[],
  name: string
): RequestHeader | undefined {
  const wanted = name.toLowerCase()

  return headers.find((header) => header?.name?.toLowerCase() === wanted)
}

/** Pull a filename out of a Content-Disposition header, RFC 5987 aware. */
export function filenameFromContentDisposition(
  value?: string
): string | undefined {
  if (!value) return undefined

  const extended = /filename\*\s*=\s*([^;]+)/i.exec(value)

  if (extended) {
    const raw = extended[1].trim().replace(/^["']|["']$/g, "")
    const encoded = raw.includes("''") ? raw.slice(raw.indexOf("''") + 2) : raw

    try {
      return decodeURIComponent(encoded)
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }

  const plain = /filename\s*=\s*([^;]+)/i.exec(value)

  if (plain) {
    return plain[1].trim().replace(/^["']|["']$/g, "")
  }

  return undefined
}

/** Last path segment of a URL-ish path, without query or hash. */
export function basename(path?: string): string | undefined {
  if (!path) return undefined

  const withoutQuery = path.split(/[?#]/)[0]
  const segments = withoutQuery.split(/[\\/]/)
  const last = segments[segments.length - 1]

  return last ? last : undefined
}

/** First value that is a non-empty string. */
function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }

  return undefined
}

/** First value that is a positive, finite number. */
function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value
    }
  }

  return undefined
}

/** Read the popup switch from storage. Defaults to true (enabled). */
export async function isShabdizEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(SHABDIZ_ENABLED_KEY)
  return result[SHABDIZ_ENABLED_KEY] !== false
}

/**
 * POST a download to the Shabdiz app.
 * Throws on network failure or timeout so the caller can restore the download.
 */
export async function sendToShabdiz(
  payload: ShabdizDownloadPayload,
  timeoutMs: number = SHABDIZ_SEND_TIMEOUT_MS
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${SHABDIZ_HOST}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    // The app may reply with a non-JSON or empty body.
    try {
      return await response.json()
    } catch {
      return { status: response.status, ok: response.ok }
    }
  } finally {
    clearTimeout(timer)
  }
}

export type BuildPayloadOptions = {
  source: ShabdizSource
  explicit?: boolean
  cachedRequest?: CachedRequestInfo | null
  responseInfo?: ShabdizResponseInfo | null
  contextInfo?: ShabdizContextInfo
}

/**
 * Build the payload for BOTH code paths.
 *
 * Having a single builder is deliberate: when the automatic path and the
 * context-menu path assembled their own objects they drifted apart, and the app
 * started receiving two different shapes.
 */
export function buildShabdizPayload(
  download: any,
  options: BuildPayloadOptions
): ShabdizDownloadPayload {
  const url: string = typeof download?.url === "string" ? download.url : ""

  const cachedRequest = options.cachedRequest ?? null
  const responseInfo = options.responseInfo ?? null
  const contextInfo = options.contextInfo ?? {}

  const headers = cachedRequest?.requestHeaders ?? []
  const responseHeaders = responseInfo?.headers ?? []

  // Derive these from the response headers rather than trusting the caller to
  // have extracted them, so the payload cannot come out half-filled.
  const contentDisposition =
    responseInfo?.contentDisposition ??
    findHeader(responseHeaders, "content-disposition")?.value

  const rawLength = findHeader(responseHeaders, "content-length")?.value
  const parsedLength = rawLength ? Number(rawLength) : NaN

  // A context-menu download often carries the size on the DownloadItem itself,
  // and its filename only in the URL.
  const fileSize = firstPositiveNumber(
    responseInfo?.fileSize,
    Number.isFinite(parsedLength) ? parsedLength : undefined,
    download?.fileSize,
    download?.totalBytes
  )

  const filename = firstNonEmpty(
    filenameFromContentDisposition(contentDisposition),
    basename(download?.filename),
    basename(download?.finalUrl),
    basename(download?.url)
  )

  const payload: ShabdizDownloadPayload = {
    url,
    finalUrl: download?.finalUrl,
    filename,
    mimeType: firstNonEmpty(
      download?.mime,
      findHeader(responseHeaders, "content-type")?.value
    ),
    fileSize,
    // download.referrer is an empty string (not nullish) for context-menu
    // downloads, so a plain ?? swallowed the page URL.
    referrer: firstNonEmpty(download?.referrer, contextInfo.pageUrl),
    tabId: download?.tabId,
    frameId: download?.frameId,
    state: download?.state,

    source: options.source,
    explicit: options.explicit ?? options.source === "context-menu",
    hasCookies: Boolean(findHeader(headers, "cookie")),

    headers,
    headersObject: headersToObject(headers),
    responseHeaders,
    responseHeadersObject: headersToObject(responseHeaders),

    contentDisposition,
    status: responseInfo?.statusCode,

    request: cachedRequest ?? undefined,
    download: download ?? undefined
  }

  if (options.source === "context-menu") {
    payload.pageUrl = contextInfo.pageUrl
    payload.linkUrl = contextInfo.linkUrl
    payload.srcUrl = contextInfo.srcUrl
    payload.selectionText = contextInfo.selectionText
  }

  return payload
}
