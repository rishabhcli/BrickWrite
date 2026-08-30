import type { PaginationOptions, PaginationResult } from 'convex/server'
import { v } from 'convex/values'
import { cloudFailure, DEFAULT_DISCOVERY_PAGE_SIZE, MAX_DISCOVERY_PAGE_SIZE,
  type CloudPage, type CloudPageRequest, type CloudResult } from './protocol'

export const pageArguments = {
  cursor: v.optional(v.union(v.string(), v.null())),
  limit: v.optional(v.number()),
}
const MAX_CURSOR_LENGTH = 16_384
const PAGE_READ_BYTES = 2 * 1024 * 1024

/** Auth must run before this helper; a cursor is a position, not a capability. */
export async function indexedPage<Row, Record>(
  query: { paginate(options: PaginationOptions): Promise<PaginationResult<Row>> },
  request: CloudPageRequest,
  scope: string,
  map: (row: Row) => Record | null | Promise<Record | null>,
  maximumItems = MAX_DISCOVERY_PAGE_SIZE,
): Promise<CloudResult<CloudPage<Record>>> {
  const limit = request.limit ?? DEFAULT_DISCOVERY_PAGE_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_PAGE_SIZE)
    return cloudFailure('INVALID_ARGUMENT', `Page size must be an integer from 1 to ${MAX_DISCOVERY_PAGE_SIZE}.`,
      'Use a supported page size and retry.')
  let cursor: string | null = null
  if (request.cursor !== undefined && request.cursor !== null) {
    try {
      if (typeof request.cursor !== 'string' || request.cursor.length > MAX_CURSOR_LENGTH) throw new Error()
      const decoded = JSON.parse(request.cursor)
      if (decoded?.v !== 1 || decoded.scope !== scope || typeof decoded.cursor !== 'string' || !decoded.cursor)
        throw new Error()
      cursor = decoded.cursor
    } catch {
      return cloudFailure('INVALID_ARGUMENT', 'That cursor does not belong to this caller and list query.',
        'Restart the list without a cursor; keep its filters unchanged between pages.')
    }
  }
  const numItems = Math.min(limit, maximumItems)
  let page: PaginationResult<Row>
  try {
    page = await query.paginate({ numItems, cursor, maximumRowsRead: numItems + 1, maximumBytesRead: PAGE_READ_BYTES })
  } catch (cause) {
    if (cause instanceof Error && /cursor|pagination|JSON|Unexpected token/i.test(cause.message))
      return cloudFailure('INVALID_ARGUMENT', 'The list cursor is invalid or no longer usable.',
        'Restart the list without a cursor.')
    throw cause
  }
  if (page.pageStatus === 'SplitRequired')
    return cloudFailure('PAYLOAD_TOO_LARGE', 'This page needs a smaller read window.',
      'Retry the same cursor with a smaller page size.', { retryLimit: Math.max(1, Math.floor(numItems / 2)) })
  const items = (await Promise.all(page.page.map(map))).filter((item): item is Awaited<Record> => item !== null)
  return { ok: true, value: { items, done: page.isDone,
    cursor: page.isDone ? null : JSON.stringify({ v: 1, scope, cursor: page.continueCursor }) } }
}

/** Old array-only APIs must refuse overflow, not claim a truncated list is complete. */
export function listOverflow(count: number, limit: number, endpoint: string) {
  return count > limit ? cloudFailure('INCOMPLETE_LIST', 'This collection exceeds the legacy list window.',
    `Use ${endpoint} with cursor pagination, or update the client.`, { limit, endpoint }) : null
}
