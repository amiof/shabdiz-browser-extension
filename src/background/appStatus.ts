import {
  SHABDIZ_ENABLED_KEY,
  SHABDIZ_HOST,
  SHABDIZ_PING_MESSAGE
} from "~lib/shabdiz"

import { log } from "./logger"

/** Popup polls this so "app not running" is visible instead of a mystery. */
export function onMessagePing(
  message: any,
  _sender: unknown,
  sendResponse: (response: { reachable: boolean }) => void
): boolean {
  if (message?.type !== SHABDIZ_PING_MESSAGE) return false

  void pingShabdiz().then((reachable) => sendResponse({ reachable }))
  return true
}

/** Log the switch flipping so service-worker restarts stay explainable. */
export function watchEnabledChanges(changes: any, area: string): void {
  if (area !== "local" || !(SHABDIZ_ENABLED_KEY in changes)) return

  const enabled = changes[SHABDIZ_ENABLED_KEY].newValue !== false
  log(enabled ? "Shabdiz enabled." : "Shabdiz disabled.")
}

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
