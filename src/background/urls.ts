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

export function normalizeUrl(url?: string): string {
  if (!url) return ""

  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return url.split("#")[0]
  }
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter(Boolean) as string[]))
}

export function isForwardableUrl(url: string): boolean {
  try {
    return !UNFORWARDABLE_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Every URL a download may carry, normalized: finalUrl, url and any urlChain
 * entries. Both the request cache and the context-menu pending tracker match
 * downloads through these candidates.
 */
export function candidateUrlsFor(download: any): string[] {
  return uniqueStrings(
    [
      download?.finalUrl,
      download?.url,
      ...(Array.isArray(download?.urlChain) ? download.urlChain : [])
    ].map(normalizeUrl)
  )
}
