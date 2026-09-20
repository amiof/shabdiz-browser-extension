import { sleep } from "./browserApi"
import { log } from "./logger"
import { responseForUrl } from "./requestCache"
import { normalizeUrl } from "./urls"

const PROBE_TIMEOUT_MS = 4000
const PROBE_RESPONSE_WAIT_MS = 700
const PROBE_SETTLE_MS = 150

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

/**
 * chrome.webRequest never reports requests the extension makes itself, which
 * includes chrome.downloads.download, so a right-clicked link used to arrive
 * with no headers at all. Having the page issue the request puts it back in
 * front of webRequest and yields the same headers the automatic path gets.
 */
export async function probeHeadersFromPage(
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
    if (responseForUrl(wanted)) break
    await sleep(50)
  }

  await sleep(PROBE_SETTLE_MS)
}
