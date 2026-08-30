import { cloudFailure, DEFAULT_DISCOVERY_PAGE_SIZE, type CloudPage, type CloudPageRequest, type CloudResult } from './protocol'
import { utf8Bytes } from './serialize'

export const MAX_COLLECTION_ITEMS = 10_000
export const MAX_COLLECTION_BYTES = 8 * 1024 * 1024
export const MAX_COLLECTION_PAGES = 1_024
export const COLLECTION_TIMEOUT_MS = 30_000

/** Array-based UI callers get all pages or an explicit failure, never a prefix.
 * Large agents can consume the individual page endpoints instead. */
export async function collectCloudPages<T>(
  read: (request: CloudPageRequest) => Promise<CloudResult<CloudPage<T>>>,
  identify: (item: T) => string,
  options: { maxItems?: number; maxBytes?: number; maxPages?: number; timeoutMs?: number } = {},
): Promise<CloudResult<T[]>> {
  const items: T[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  let bytes = 2
  let limit = DEFAULT_DISCOVERY_PAGE_SIZE
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<CloudResult<CloudPage<T>>>(resolve => {
    timer = setTimeout(() => resolve(cloudFailure('INCOMPLETE_LIST', 'The complete list could not be read before its deadline.',
      'Retry, or use the paginated discovery API for incremental access.')), options.timeoutMs ?? COLLECTION_TIMEOUT_MS)
  })
  const incomplete = (message: string) => cloudFailure('INCOMPLETE_LIST', message,
    'Reload the list. No partial list has been substituted for the complete result.')
  try {
    for (let pageNumber = 0; pageNumber < (options.maxPages ?? MAX_COLLECTION_PAGES); pageNumber++) {
      // Annotated because the race's inferred type feeds back into this
      // function's own inferred return type, which TypeScript refuses to
      // resolve. The two arms already agree on this shape.
      const result: CloudResult<CloudPage<T>> = await Promise.race([read({ cursor, limit }), deadline])
      if (!result.ok) {
        const retryLimit = (result.error.details as { retryLimit?: number } | undefined)?.retryLimit
        if (result.error.code === 'PAYLOAD_TOO_LARGE' && Number.isSafeInteger(retryLimit) && retryLimit! >= 1 && retryLimit! < limit) {
          limit = retryLimit!
          continue // same cursor; never consume an incomplete provider page
        }
        return result
      }
      const page: CloudPage<T> = result.value
      if (!page || !Array.isArray(page.items) || typeof page.done !== 'boolean' ||
        (page.done ? page.cursor !== null : typeof page.cursor !== 'string' || !page.cursor))
        return incomplete('The cloud returned a malformed list page.')
      if (page.cursor !== null && cursors.has(page.cursor)) return incomplete('The cloud list cursor stopped advancing.')
      for (const item of page.items) {
        const id = identify(item)
        if (!id || typeof id !== 'string' || ids.has(id)) return incomplete('The cloud list contains a missing or repeated record identity.')
        ids.add(id)
        bytes += utf8Bytes(JSON.stringify(item)) + 1
        if (ids.size > (options.maxItems ?? MAX_COLLECTION_ITEMS) || bytes > (options.maxBytes ?? MAX_COLLECTION_BYTES))
          return cloudFailure('PAYLOAD_TOO_LARGE', 'This collection is too large to load as one complete array.',
            'Use the paginated discovery API to read it incrementally.',
            { maxItems: options.maxItems ?? MAX_COLLECTION_ITEMS, maxBytes: options.maxBytes ?? MAX_COLLECTION_BYTES })
        items.push(item)
      }
      if (page.done) return { ok: true, value: items }
      cursor = page.cursor
      cursors.add(cursor!)
    }
    return incomplete('The cloud list exceeded the bounded page traversal limit.')
  } catch {
    // Do not publish transport exceptions or return the successfully read prefix.
    return incomplete('The complete cloud list could not be read.')
  } finally {
    clearTimeout(timer)
  }
}
