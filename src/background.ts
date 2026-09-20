import {
  buildShabdizPayload,
  findHeader,
  isShabdizEnabled,
  sendToShabdiz,
  SHABDIZ_ENABLED_KEY,
  SHABDIZ_HOST,
  SHABDIZ_PING_MESSAGE,
  type CachedRequestInfo,
  type RequestHeader,
  type ShabdizContextInfo,
  type ShabdizDownloadPayload,
  type ShabdizResponseInfo
} from "./lib/shabdiz"

/** Flip to true for verbose diagnostics. Real failures always log. */
const DEBUG = false

function log(...args: unknown[]): void {
  if (DEBUG) console.log("[shabdiz]", ...args)
}

const CONTEXT_MENU_ID = "shabdiz-download"

/**
 * Context-menu downloads are matched by the id returned from
 * chrome.downloads.download(). That is the only reliable key — matching by URL
 * broke whenever the browser normalized or redirected it.
 */
const CONTEXT_DOWNLOAD_TIMEOUT_MS = 15_000

/** The page probe is best-effort and must never hold up a download for long. */
const PROBE_TIMEOUT_MS = 4000
const PROBE_RESPONSE_WAIT_MS = 700
const PROBE_SETTLE_MS = 150

const CACHE_TTL_MS = 120_000
const MAX_PER_URL = 20
const MAX_TOTAL_CACHE_ITEMS = 3000

/** Schemes a desktop download manager cannot fetch on its own. */
const UNFORWARDABLE_SCHEMES = new Set([
  "about:",
  "blob:",
  "chrome:",
  "chrome-extension:",
  "data:",
  "edge:",
  "file:",
  "javascript:",
  "moz-extension:"
])

type CachedRequest = CachedRequestInfo & { normalizedUrl: string }

const requestsByRequestId = new Map<string, CachedRequest>()
const requestsByUrl = new Map<string, string[]>()
const responseByRequestId = new Map<
  string,
  { info: ShabdizResponseInfo; time: number }
>()

let cacheWriteCount = 0

type PendingContextDownload = {
  url: string
  normalizedUrl: string
  info: ShabdizContextInfo
  downloadId?: number
  timer?: ReturnType<typeof setTimeout>
  /** Set once onCreated (or the failure path) has claimed this entry. */
  consumed: boolean
}

const pendingByDownloadId = new Map<string, PendingContextDownload>()
const pendingByUrl = new Map<string, PendingContextDownload>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(url?: string): string {
  if (!url) return ""

  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return url.split("#")[0]
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter(Boolean) as string[]))
}

function normalizeHeaders(raw: unknown): RequestHeader[] {
  if (!Array.isArray(raw)) return []

  return raw.map((header: any) => ({
    name: String(header?.name ?? ""),
    value: typeof header?.value === "string" ? header.value : undefined
  }))
}

function isForwardableUrl(url: string): boolean {
  try {
    return !UNFORWARDABLE_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * chrome.downloads.* is promise-based on Chrome and callback-based on older
 * Firefox builds, and Firefox rejects an unknown `extraInfoSpec` value. Calling
 * with a callback and also handling a returned promise keeps both happy.
 */
type DownloadsResult<T> = { ok: boolean; value?: T }

/**
 * `pause`, `resume`, `cancel` and `erase` report nothing but an error, so
 * "did it work" has to come from the absence of an error rather than from the
 * return value. Hence the explicit `ok`.
 */
function invokeDownloads<T = number>(
  method: "download" | "pause" | "resume" | "cancel" | "erase",
  ...args: unknown[]
): Promise<DownloadsResult<T>> {
  const api = (chrome as any)?.downloads
  const fn = api?.[method]

  if (typeof fn !== "function") return Promise.resolve({ ok: false })

  return new Promise((resolve) => {
    let settled = false

    const settle = (result: DownloadsResult<T>) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const maybePromise = fn.call(api, ...args, (result: T) => {
        const error = chrome.runtime.lastError

        if (error) {
          log(`chrome.downloads.${method} failed: ${error.message}`)
          settle({ ok: false })
          return
        }

        settle({ ok: true, value: result })
      })

      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          (value: T) => settle({ ok: true, value }),
          (error: unknown) => {
            console.warn(
              `[shabdiz] chrome.downloads.${method} rejected:`,
              error
            )
            settle({ ok: false })
          }
        )
      }
    } catch (error) {
      console.warn(`[shabdiz] chrome.downloads.${method} threw:`, error)
      settle({ ok: false })
    }
  })
}

// ---------------------------------------------------------------------------
// Request header + response header cache
// ---------------------------------------------------------------------------

function getCachedRequest(requestId?: string): CachedRequest | null {
  if (!requestId) return null

  const item = requestsByRequestId.get(requestId)

  if (!item) return null

  if (Date.now() - item.time > CACHE_TTL_MS) {
    requestsByRequestId.delete(requestId)
    return null
  }

  return item
}

function getCachedResponse(
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

function findCachedByCandidates(
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

function candidateUrlsFor(download: any): string[] {
  return uniqueStrings(
    [
      download?.finalUrl,
      download?.url,
      ...(Array.isArray(download?.urlChain) ? download.urlChain : [])
    ].map(normalizeUrl)
  )
}

function findCachedRequest(download: any): CachedRequest | null {
  return findCachedByCandidates(candidateUrlsFor(download), download?.tabId)
}

// ---------------------------------------------------------------------------
// webRequest registration
// ---------------------------------------------------------------------------

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

function registerWebRequestSafely(): void {
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

registerWebRequestSafely()

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function removePending(pending: PendingContextDownload): void {
  pending.consumed = true

  if (pending.timer !== undefined) {
    clearTimeout(pending.timer)
    pending.timer = undefined
  }

  if (pendingByUrl.get(pending.normalizedUrl) === pending) {
    pendingByUrl.delete(pending.normalizedUrl)
  }

  if (pending.downloadId !== undefined) {
    const key = String(pending.downloadId)
    if (pendingByDownloadId.get(key) === pending) {
      pendingByDownloadId.delete(key)
    }
  }
}

function takePendingForDownload(download: any): PendingContextDownload | null {
  const byId = pendingByDownloadId.get(String(download?.id))
  let pending: PendingContextDownload | undefined = byId

  if (!pending) {
    for (const candidate of candidateUrlsFor(download)) {
      const candidatePending = pendingByUrl.get(candidate)

      if (candidatePending) {
        pending = candidatePending
        break
      }
    }
  }

  if (!pending) return null

  removePending(pending)
  return pending
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Runs in the page's own context, so the request it makes is a page request.
 * Kept free of outer references because chrome.scripting serialises it. Resolves
 * once the response headers are in, then drops the body so the file itself is
 * never downloaded.
 */
function pageHeaderProbe(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  return fetch(url, {
    credentials: "include",
    redirect: "follow",
    signal: controller.signal
  })
    .then(
      (response) => {
        if (response.body) void response.body.cancel().catch(() => {})
        return { status: response.status, finalUrl: response.url || url }
      },
      () => ({ status: 0, finalUrl: url })
    )
    .finally(() => clearTimeout(timer))
}

async function resolveClickTarget(
  info: any
): Promise<{ tabId?: number; frameId?: number }> {
  const frameId = typeof info?.frameId === "number" ? info.frameId : undefined
  const tabIdFromInfo = info?.tab?.id

  if (typeof tabIdFromInfo === "number") {
    return { tabId: tabIdFromInfo, frameId }
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tabs?.[0]?.id

    return { tabId: typeof tabId === "number" ? tabId : undefined, frameId }
  } catch {
    return { frameId }
  }
}

function getResponseForUrl(
  normalizedUrl: string
): ShabdizResponseInfo | undefined {
  const item = newestForUrl(normalizedUrl)

  return item ? getCachedResponse(item.requestId) : undefined
}

/**
 * chrome.webRequest never reports requests the extension makes itself, which
 * includes chrome.downloads.download, so a right-clicked link used to arrive
 * with no headers at all. Having the page issue the request puts it back in
 * front of webRequest and yields the same headers the automatic path gets.
 */
async function probeHeadersFromPage(
  tabId: number | undefined,
  frameId: number | undefined,
  url: string
): Promise<void> {
  const scripting = (chrome as any)?.scripting

  if (typeof scripting?.executeScript !== "function") return
  if (typeof tabId !== "number" || tabId < 0) return

  let finalUrl = url

  try {
    const target: any = { tabId }
    if (typeof frameId === "number" && frameId >= 0) target.frameIds = [frameId]

    const results = await scripting.executeScript({
      target,
      args: [url, PROBE_TIMEOUT_MS],
      func: pageHeaderProbe
    })

    const first = Array.isArray(results) ? results[0]?.result : undefined

    if (typeof first?.finalUrl === "string" && first.finalUrl) {
      finalUrl = first.finalUrl
    }
  } catch (error) {
    log("Page header probe failed:", error)
  }

  // onHeadersReceived can land a beat after the page fetch resolves, and a
  // redirect adds one more request to wait for.
  const deadline = Date.now() + PROBE_RESPONSE_WAIT_MS
  const wanted = normalizeUrl(finalUrl)

  while (Date.now() < deadline) {
    if (getResponseForUrl(wanted)) break
    await sleep(50)
  }

  await sleep(PROBE_SETTLE_MS)
}

function refererHeader(info: any): RequestHeader | null {
  const pageUrl: string | undefined = info?.pageUrl

  if (!pageUrl || !/^https?:/i.test(pageUrl)) return null

  return { name: "Referer", value: pageUrl }
}

async function startBrowserDownload(
  url: string,
  info: any
): Promise<number | undefined> {
  const options: any = { url, saveAs: false }
  const referer = refererHeader(info)

  if (referer) {
    // Ask the browser to send the page's Referer, so the download we are about
    // to inspect resembles the one the site expected.
    const withReferer = await invokeDownloads<number>("download", {
      ...options,
      headers: [referer]
    })

    if (typeof withReferer.value === "number") return withReferer.value
  }

  const result = await invokeDownloads<number>("download", options)

  return typeof result.value === "number" ? result.value : undefined
}

async function sendContextFallback(
  pending: PendingContextDownload
): Promise<void> {
  const cachedRequest = findCachedByCandidates([pending.normalizedUrl])
  const responseInfo = cachedRequest
    ? getCachedResponse(cachedRequest.requestId)
    : undefined

  const payload = buildShabdizPayload(
    { url: pending.url, state: "in_progress" },
    {
      source: "context-menu",
      explicit: true,
      cachedRequest,
      responseInfo,
      contextInfo: pending.info
    }
  )

  try {
    await sendToShabdiz(payload)
    log("Sent context-menu fallback payload.")
  } catch (error) {
    console.error("[shabdiz] Could not reach the Shabdiz app:", error)
  }
}

async function handleContextMenuClick(info: any): Promise<void> {
  if (info?.menuItemId !== CONTEXT_MENU_ID) return

  const url: string | undefined = info.linkUrl ?? info.srcUrl ?? info.pageUrl

  if (!url) {
    console.warn("[shabdiz] Context menu click had no URL.")
    return
  }

  if (!isForwardableUrl(url)) {
    console.warn("[shabdiz] Cannot send this URL scheme to Shabdiz:", url)
    return
  }

  const normalizedUrl = normalizeUrl(url)
  const previous = pendingByUrl.get(normalizedUrl)

  if (previous) removePending(previous)

  const pending: PendingContextDownload = {
    url,
    normalizedUrl,
    info: {
      pageUrl: info.pageUrl,
      linkUrl: info.linkUrl,
      srcUrl: info.srcUrl,
      selectionText: info.selectionText
    },
    consumed: false
  }

  pendingByUrl.set(normalizedUrl, pending)
  pending.timer = setTimeout(() => {
    removePending(pending)
    console.warn(
      "[shabdiz] No browser download appeared in time — forwarding without a live download."
    )
    void sendContextFallback(pending)
  }, CONTEXT_DOWNLOAD_TIMEOUT_MS)

  log("Explicit Shabdiz download requested:", url)

  // Fill the header cache before the download exists, so onCreated finds a
  // fully described request waiting for it.
  const clickTarget = await resolveClickTarget(info)
  await probeHeadersFromPage(clickTarget.tabId, clickTarget.frameId, url)

  const downloadId = await startBrowserDownload(url, info)

  if (typeof downloadId !== "number") {
    const wasConsumed = pending.consumed
    removePending(pending)

    if (!wasConsumed) {
      await sendContextFallback(pending)
    }

    return
  }

  pending.downloadId = downloadId

  // onCreated may already have claimed this entry by URL before the id came
  // back, in which case there is nothing left to register.
  if (!pending.consumed) {
    pendingByDownloadId.set(String(downloadId), pending)
  }
}

chrome.contextMenus.onClicked.addListener((info: any) => {
  void handleContextMenuClick(info)
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: "Download with Shabdiz",
        contexts: ["all"]
      },
      () => {
        // Reading lastError keeps Chrome from logging an unchecked-error warning.
        const error = chrome.runtime.lastError
        if (error)
          console.warn("[shabdiz] context menu create failed:", error.message)
      }
    )
  })
})

// ---------------------------------------------------------------------------
// Download interception
// ---------------------------------------------------------------------------

async function eraseDownload(downloadId?: number): Promise<void> {
  if (typeof downloadId !== "number") return

  const api = (chrome as any)?.downloads

  if (typeof api?.erase !== "function") return

  await invokeDownloads("erase", { id: downloadId })
}

async function handleDownloadCreated(download: any): Promise<void> {
  const pending = takePendingForDownload(download)
  const explicit = pending !== null

  const enabled = explicit || (await isShabdizEnabled())

  if (!enabled) {
    log("Shabdiz is off — the browser keeps this download:", download?.url)
    return
  }

  if (!download?.url) return

  if (!isForwardableUrl(download.url)) {
    log("Skipping a URL scheme Shabdiz cannot fetch:", download.url)
    return
  }

  if (download.state === "complete" || download.state === "interrupted") {
    log(`Download already ${download.state}, skipping:`, download.url)
    return
  }

  const cachedRequest = findCachedRequest(download)
  const responseInfo = cachedRequest
    ? getCachedResponse(cachedRequest.requestId)
    : undefined

  const payload: ShabdizDownloadPayload = buildShabdizPayload(download, {
    source: explicit ? "context-menu" : "auto",
    explicit,
    cachedRequest,
    responseInfo,
    contextInfo: pending?.info
  })

  log("Forwarding download:", {
    url: payload.url,
    source: payload.source,
    headers: payload.headers.length,
    hasCookies: payload.hasCookies,
    filename: payload.filename
  })

  // Pausing means a failed send can be resumed instead of losing the download.
  const { ok: paused } = await invokeDownloads("pause", download.id)

  let sent = false

  try {
    await sendToShabdiz(payload)
    sent = true
  } catch (error) {
    console.error("[shabdiz] Could not reach the Shabdiz app:", error)
  }

  if (sent) {
    await invokeDownloads("cancel", download.id)
    // Erasing stops Chrome from restoring this download on the next start, which
    // is what caused a burst of re-sends every time the browser reopened.
    await eraseDownload(download.id)
  } else if (paused) {
    await invokeDownloads("resume", download.id)
  } else {
    console.warn(
      "[shabdiz] Send failed and the download could not be paused; leaving it to the browser:",
      download.url
    )
  }
}

chrome.downloads.onCreated.addListener((download: any) => {
  void handleDownloadCreated(download)
})

// ---------------------------------------------------------------------------
// Status + popup helpers
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(SHABDIZ_ENABLED_KEY in changes)) return

  const enabled = changes[SHABDIZ_ENABLED_KEY].newValue !== false
  log(enabled ? "Shabdiz enabled." : "Shabdiz disabled.")
})

async function pingShabdiz(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)

  try {
    // Any HTTP answer means something is listening; the app may not serve "/".
    await fetch(`${SHABDIZ_HOST}/`, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal
    })

    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.type !== SHABDIZ_PING_MESSAGE) return false

  void pingShabdiz().then((reachable) => sendResponse({ reachable }))
  return true
})
