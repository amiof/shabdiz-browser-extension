export const SHABDIZ_HOST = "http://127.0.0.1:3325"
export const SHABDIZ_ENABLED_KEY = "shabdizEnabled"

export type ShabdizDownloadPayload = {
  url?: string
  finalUrl?: string
  pageUrl?: string
  linkUrl?: string
  srcUrl?: string
  selectionText?: string
  referrer?: string
  filename?: string
}

/** Read the switch state from storage. Defaults to true (enabled). */
export async function isShabdizEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(SHABDIZ_ENABLED_KEY)
  return result[SHABDIZ_ENABLED_KEY] !== false
}

/** POST a download payload to the Shabdiz app. */
export async function sendToShabdiz(
  payload: ShabdizDownloadPayload
): Promise<unknown> {
  const response = await fetch(`${SHABDIZ_HOST}/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  })

  try {
    return await response.json()
  } catch {
    // App may reply without a JSON body
    return null
  }
}
