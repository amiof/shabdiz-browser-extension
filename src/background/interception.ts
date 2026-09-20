import {
  buildShabdizPayload,
  isShabdizEnabled,
  sendToShabdiz,
  type ShabdizDownloadPayload
} from "~lib/shabdiz"

import { invokeDownloads } from "./browserApi"
import {
  takePendingForDownload,
  type PendingContextDownload
} from "./contextMenu"
import { log } from "./logger"
import { findCachedRequest, getCachedResponse } from "./requestCache"
import { isForwardableUrl } from "./urls"

/** Chrome-only: removes the entry so a restart cannot restore and re-send it. */
async function eraseDownload(downloadId?: number): Promise<void> {
  if (typeof downloadId !== "number") return

  const api = (chrome as any)?.downloads

  if (typeof api?.erase !== "function") return

  await invokeDownloads("erase", { id: downloadId })
}

export async function handleDownloadCreated(download: any): Promise<void> {
  const pending: PendingContextDownload | null =
    takePendingForDownload(download)
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
