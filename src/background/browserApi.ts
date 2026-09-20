import { log } from "./logger"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * chrome.downloads.* is promise-based on Chrome and callback-based on older
 * Firefox builds. Calling with a callback and also handling a returned promise
 * keeps both happy.
 */
export type DownloadsResult<T> = { ok: boolean; value?: T }

/**
 * `pause`, `resume`, `cancel` and `erase` report nothing but an error, so
 * "did it work" has to come from the absence of an error rather than from the
 * return value. Hence the explicit `ok`.
 */
export function invokeDownloads<T = number>(
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
