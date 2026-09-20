import {
  SHABDIZ_ENABLED_KEY,
  SHABDIZ_HOST,
  SHABDIZ_SEND_TIMEOUT_MS,
  type ShabdizDownloadPayload
} from "./types"

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
