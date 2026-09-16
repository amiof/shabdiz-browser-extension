import {
  SHABDIZ_ENABLED_KEY,
  isShabdizEnabled,
  sendToShabdiz,
  type ShabdizDownloadPayload
} from "./lib/shabdiz"

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "shabdiz-download",
    title: "Download with Shabdiz",
    contexts: ["all"]
  })
})

// Context menu: explicit user action, always sends to Shabdiz
// regardless of the popup switch.
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "shabdiz-download") {
    return
  }

  const url = info.linkUrl ?? info.srcUrl ?? info.pageUrl

  if (!url) {
    console.log("No URL found")
    return
  }

  console.log("Download link:", url)

  const payload: ShabdizDownloadPayload = {
    url,
    pageUrl: info.pageUrl,
    linkUrl: info.linkUrl,
    srcUrl: info.srcUrl,
    selectionText: info.selectionText
  }

  try {
    const resData = await sendToShabdiz(payload)
    console.log("Shabdiz response:", resData)
  } catch (error) {
    console.error("Failed to connect to Shabdiz:", error)
  }
})

// Helper: erase download from history if the browser supports it.
// chrome.downloads.erase() is Chrome-only. Firefox and Safari
// don\'t have it, so we silently skip.
async function eraseDownloadIfExists(downloadId: number): Promise<void> {
  if (typeof chrome.downloads.erase === "function") {
    await chrome.downloads.erase({ id: downloadId })
    console.log("Erased download from history:", downloadId)
  }
}

// Automatic interception: only while the popup switch is ON.
// Works on Chrome, Edge (Chromium), and Firefox.
// Safari has limited chrome.downloads support and may not fire
// this event at all.
chrome.downloads.onCreated.addListener(async (download) => {
  console.log("Download detected:", download)

  const enabled = await isShabdizEnabled()
  if (!enabled) {
    console.log(
      "Shabdiz disabled \u2014 download stays in the browser:",
      download.url
    )
    return
  }

  if (!download.url) {
    return
  }

  // Skip downloads that are already complete or interrupted.
  // This catches Chrome restoring downloads from a previous session.
  if (download.state === "complete" || download.state === "interrupted") {
    console.log(
      `Download already ${download.state}, skipping:`,
      download.url
    )
    return
  }

  console.log("URL:", download.url)

  // Cancel the browser\'s download; Shabdiz takes over instead.
  // chrome.downloads.cancel() exists on Chrome, Edge, and Firefox.
  await chrome.downloads.cancel(download.id)
  console.log("Send to Shabdiz:", download.url)

  const payload: ShabdizDownloadPayload = {
    url: download.url,
    finalUrl: download.finalUrl,
    referrer: download.referrer,
    filename: download.filename
  }

  try {
    const resData = await sendToShabdiz(payload)
    console.log("Shabdiz response:", resData)

    // Erase from Chrome\'s history so it won\'t restore on restart.
    // No-op on Firefox/Safari where erase() doesn\'t exist.
    await eraseDownloadIfExists(download.id)
  } catch (error) {
    console.error("Failed to connect to Shabdiz:", error)
  }

  // await navigator.clipboard.writeText(download.finalUrl)
})

// The popup flips the switch by writing to storage; react to
// enable/disable status changes here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(SHABDIZ_ENABLED_KEY in changes)) {
    return
  }

  if (changes[SHABDIZ_ENABLED_KEY].newValue === false) {
    console.log("Shabdiz disabled \u2014 downloads stay in the browser.")
  } else {
    console.log("Shabdiz enabled \u2014 downloads are sent to the app.")
  }
})
