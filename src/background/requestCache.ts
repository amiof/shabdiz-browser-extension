import {
  findHeader,
  type CachedRequestInfo,
  type RequestHeader,
  type ShabdizResponseInfo
} from "~lib/shabdiz"

import { log } from "./logger"
import { candidateUrlsFor, normalizeUrl } from "./urls"

const CACHE_TTL_MS = 120_000
const MAX_PER_URL = 20
const MAX_TOTAL_CACHE_ITEMS = 3000

export type CachedRequest = CachedRequestInfo & { normalizedUrl: string }

const requestsByRequestId = new Map<string, CachedRequest>()
const requestsByUrl = new Map<string, string[]>()
const responseByRequestId = new Map<
  string,
  { info: ShabdizResponseInfo; time: number }
>()

let cacheWriteCount = 0

function normalizeHeaders(raw: unknown): RequestHeader[] {
  if (!Array.isArray(raw)) return []

  return raw.map((header: any) => ({
    name: String(header?.name ?? ""),
    value: typeof header?.value === "string" ? header.value : undefined
  }))
}

export function getCachedRequest(requestId?: string): CachedRequest | null {
  if (!requestId) return null

  const item = requestsByRequestId.get(requestId)

  if (!item) return null

  if (Date.now() - item.time > CACHE_TTL_MS) {
    requestsByRequestId.delete(requestId)
    return null
  }

  return item
}

export function getCachedResponse(
  requestId?: string
): ShabdizResponseInfo | undefined {
  if (!requestId) return undefined

  const entry = responseByRequestId.get(requestId)

  if (!entry) return undefined

  if (Date.now() - entry.time > CACHE_TTL_MS) {
    responseByRequestId.delete(requestId)
    return undefined
  }

  return entry.info
}

function pruneCache(): void {
  const now = Date.now()

  for (const [requestId, item] of requestsByRequestId) {
    if (now - item.time > CACHE_TTL_MS) {
      requestsByRequestId.delete(requestId)
      responseByRequestId.delete(requestId)
    }
  }

  for (const [requestId, entry] of responseByRequestId) {
    if (now - entry.time > CACHE_TTL_MS) {
      responseByRequestId.delete(requestId)
    }
  }

  for (const [normalizedUrl, ids] of requestsByUrl) {
    const fresh = ids.filter((id) => requestsByRequestId.has(id))

    if (fresh.length === 0) {
      requestsByUrl.delete(normalizedUrl)
    } else {
      requestsByUrl.set(normalizedUrl, fresh)
    }
  }

  if (requestsByRequestId.size > MAX_TOTAL_CACHE_ITEMS) {
    const targetSize = Math.floor(MAX_TOTAL_CACHE_ITEMS * 0.8)
    const oldest = [...requestsByRequestId.entries()].sort(
      (a, b) => a[1].time - b[1].time
    )

    for (
      let i = 0;
      i < oldest.length && requestsByRequestId.size > targetSize;
      i++
    ) {
      const requestId = oldest[i][0]
      requestsByRequestId.delete(requestId)
      responseByRequestId.delete(requestId)
    }
  }
}

function cacheRequest(details: any): void {
  const url: string | undefined = details?.url
  const requestId: string | undefined = details?.requestId

  if (!url || !requestId) return

  const normalizedUrl = normalizeUrl(url)

  const item: CachedRequest = {
    requestId,
    url,
    normalizedUrl,
    method: details.method,
    type: details.type,
    tabId: details.tabId,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    initiator: details.initiator,
    requestHeaders: normalizeHeaders(details.requestHeaders),
    time: Date.now()
  }

  requestsByRequestId.set(requestId, item)

  const ids = requestsByUrl.get(normalizedUrl) ?? []
  ids.push(requestId)

  if (ids.length > MAX_PER_URL) {
    ids.splice(0, ids.length - MAX_PER_URL)
  }

  requestsByUrl.set(normalizedUrl, ids)

  cacheWriteCount++

  if (cacheWriteCount % 100 === 0) {
    pruneCache()
  }
}

function cacheResponse(details: any): void {
  const requestId: string | undefined = details?.requestId

  if (!requestId) return

  // Only keep responses for requests we already recorded — otherwise this map
  // grows with every request the browser makes.
  if (!requestsByRequestId.has(requestId)) return

  const headers = normalizeHeaders(details.responseHeaders)
  const contentDisposition = findHeader(headers, "content-disposition")?.value
  const rawLength = findHeader(headers, "content-length")?.value
  const parsedLength = rawLength ? Number(rawLength) : NaN

  responseByRequestId.set(requestId, {
    info: {
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      headers,
      contentDisposition,
      fileSize: Number.isFinite(parsedLength) ? parsedLength : undefined
    },
    time: Date.now()
  })
}

function newestForUrl(
  normalizedUrl: string,
  tabId?: number
): CachedRequest | null {
  const ids = requestsByUrl.get(normalizedUrl)

  if (!ids?.length) return null

  for (let i = ids.length - 1; i >= 0; i--) {
    const item = getCachedRequest(ids[i])

    if (!item) continue
    if (tabId === undefined || item.tabId === tabId) return item
  }

  return null
}

export function findCachedByCandidates(
  candidates: string[],
  tabId?: number
): CachedRequest | null {
  // Prefer a request made by the same tab the download came from…
  if (typeof tabId === "number" && tabId >= 0) {
    for (const normalizedUrl of candidates) {
      const item = newestForUrl(normalizedUrl, tabId)
      if (item) return item
    }
  }

  // …then fall back to the newest request for the URL from any tab. This is the
  // path a context-menu download takes, since it has no tab of its own.
  for (const normalizedUrl of candidates) {
    const item = newestForUrl(normalizedUrl)
    if (item) return item
  }

  return null
}

export function findCachedRequest(download: any): CachedRequest | null {
  return findCachedByCandidates(candidateUrlsFor(download), download?.tabId)
}

export function responseForUrl(
  normalizedUrl: string
): ShabdizResponseInfo | undefined {
  const item = newestForUrl(normalizedUrl)

  return item ? getCachedResponse(item.requestId) : undefined
}

function addListenerSafely(
  event: any,
  handler: (details: any) => void,
  filter: { urls: string[] },
  specs: string[]
): boolean {
  try {
    event.addListener(handler, filter, specs)
    return true
  } catch (error) {
    // Firefox rejects "extraHeaders" outright, so we retry without it.
    console.warn(
      `[shabdiz] extraInfoSpec rejected ${JSON.stringify(specs)}:`,
      error
    )
    return false
  }
}

/**
 * Registers the webRequest listeners that feed this cache. Call once at
 * service-worker startup, before any download can be intercepted.
 */
export function startHeaderCapture(): void {
  const webRequest = (chrome as any)?.webRequest

  if (!webRequest?.onBeforeSendHeaders?.addListener) {
    console.warn("[shabdiz] chrome.webRequest is not available.")
    return
  }

  const filter = { urls: ["<all_urls>"] }

  // "extraHeaders" is what makes Chrome hand over Cookie / Referer / Origin /
  // Authorization. Without it the payload is missing the headers that a
  // download manager actually needs.
  const requestSpecs = ["requestHeaders", "extraHeaders"]
  if (
    !addListenerSafely(
      webRequest.onBeforeSendHeaders,
      cacheRequest,
      filter,
      requestSpecs
    )
  ) {
    addListenerSafely(webRequest.onBeforeSendHeaders, cacheRequest, filter, [
      "requestHeaders"
    ])
  }

  const onHeadersReceived = webRequest?.onHeadersReceived

  if (onHeadersReceived?.addListener) {
    const responseSpecs = ["responseHeaders", "extraHeaders"]
    if (
      !addListenerSafely(
        onHeadersReceived,
        cacheResponse,
        filter,
        responseSpecs
      )
    ) {
      addListenerSafely(onHeadersReceived, cacheResponse, filter, [
        "responseHeaders"
      ])
    }
  }

  log("webRequest header collector registered.")
}
