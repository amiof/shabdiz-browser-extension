import type { RequestHeader } from "./types"

/** Collapse a header list into an object. Later duplicates win. */
export function headersToObject(
  headers: RequestHeader[]
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const header of headers) {
    if (typeof header?.name === "string" && typeof header.value === "string") {
      result[header.name] = header.value
    }
  }

  return result
}

/** Case-insensitive header lookup. */
export function findHeader(
  headers: RequestHeader[],
  name: string
): RequestHeader | undefined {
  const wanted = name.toLowerCase()

  return headers.find((header) => header?.name?.toLowerCase() === wanted)
}

/** Pull a filename out of a Content-Disposition header, RFC 5987 aware. */
export function filenameFromContentDisposition(
  value?: string
): string | undefined {
  if (!value) return undefined

  const extended = /filename\*\s*=\s*([^;]+)/i.exec(value)

  if (extended) {
    const raw = extended[1].trim().replace(/^["']|["']$/g, "")
    const encoded = raw.includes("''") ? raw.slice(raw.indexOf("''") + 2) : raw

    try {
      return decodeURIComponent(encoded)
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }

  const plain = /filename\s*=\s*([^;]+)/i.exec(value)

  if (plain) {
    return plain[1].trim().replace(/^["']|["']$/g, "")
  }

  return undefined
}

/** Last path segment of a URL-ish path, without query or hash. */
export function basename(path?: string): string | undefined {
  if (!path) return undefined

  const withoutQuery = path.split(/[?#]/)[0]
  const segments = withoutQuery.split(/[\\/]/)
  const last = segments[segments.length - 1]

  return last ? last : undefined
}
