import {
  basename,
  filenameFromContentDisposition,
  findHeader,
  headersToObject
} from "./headers"
import type {
  BuildPayloadOptions,
  RequestHeader,
  ShabdizDownloadPayload
} from "./types"

/** First value that is a non-empty string. */
function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }

  return undefined
}

/**
 * Request headers worth forwarding to the app. Everything else (Host,
 * Sec-Fetch-*, Accept-Encoding, Connection, ...) is noise for a download
 * manager: the download engine derives those from the URL itself.
 */
const FORWARD_HEADERS = new Set([
  "user-agent",
  "referer",
  "cookie",
  "authorization",
  "accept",
  "origin"
])

/** Keep only the headers the app should forward to the download engine. */
function forwardableHeaders(headers: RequestHeader[]): RequestHeader[] {
  return headers.filter(
    (header) =>
      typeof header?.name === "string" &&
      FORWARD_HEADERS.has(header.name.toLowerCase())
  )
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
  const url: string =
    options.overrideUrl ??
    (typeof download?.url === "string" ? download.url : "")

  const cachedRequest = options.cachedRequest ?? null
  const responseInfo = options.responseInfo ?? null
  const contextInfo = options.contextInfo ?? {}

  const headers = forwardableHeaders(cachedRequest?.requestHeaders ?? [])
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

    request:
      cachedRequest
        ? { ...cachedRequest, requestHeaders: headers }
        : undefined,
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
