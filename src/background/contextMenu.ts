import {
  buildShabdizPayload,
  sendToShabdiz,
  type ShabdizContextInfo
} from "~lib/shabdiz"

import { invokeDownloads } from "./browserApi"
import { probeHeadersFromPage } from "./headerProbe"
import { log } from "./logger"
import {
  findCachedByCandidates,
  getCachedResponse,
  resolveRedirect
} from "./requestCache"
import { candidateUrlsFor, isForwardableUrl, normalizeUrl } from "./urls"

export const CONTEXT_MENU_ID = "shabdiz-download"

/**
 * Context-menu downloads are matched by the id returned from
 * chrome.downloads.download(). That is the only reliable key — matching by URL
 * broke whenever the browser normalized or redirected it.
 */
const CONTEXT_DOWNLOAD_TIMEOUT_MS = 15_000

export type PendingContextDownload = {
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

/** Claim the pending entry for a download, by id first and URL as fallback. */
export function takePendingForDownload(
  download: any
): PendingContextDownload | null {
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

function refererHeader(info: any): { name: string; value: string } | null {
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

/** Last resort when no browser download appeared to attach headers to. */
async function sendContextFallback(
  pending: PendingContextDownload
): Promise<void> {
  const initialCached = findCachedByCandidates([pending.normalizedUrl])
  const initialResponse = initialCached
    ? getCachedResponse(initialCached.requestId)
    : undefined

  const resolved = resolveRedirect(
    pending.url,
    initialCached,
    initialResponse
  )

  const payload = buildShabdizPayload(
    { url: pending.url, state: "in_progress" },
    {
      source: "context-menu",
      explicit: true,
      cachedRequest: resolved.cachedRequest,
      responseInfo: resolved.responseInfo,
      contextInfo: pending.info,
      overrideUrl:
        resolved.url !== pending.url ? resolved.url : undefined
    }
  )

  try {
    await sendToShabdiz(payload)
    log("Sent context-menu fallback payload.")
  } catch (error) {
    console.error("[shabdiz] Could not reach the Shabdiz app:", error)
  }
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

export async function handleContextMenuClick(info: any): Promise<void> {
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

/** (Re)create the context-menu entry. Runs on install/update. */
export function createContextMenu(): void {
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
}
