import { isPubliclyListable } from '../../src/features/share/access'
import { galleryEntryFrom } from '../../src/features/share/gallery-projection'
import { deepFreeze, revokePublication, updatePublicationAccess } from '../../src/features/share/publish'
import { guardPayloadSize, LIMITS, sanitizeComment, sanitizeLabel } from '../../src/features/share/sanitize'
import { mintShareToken, revokeToken } from '../../src/features/share/tokens'
import { ShareError, type Publication, type PublicationCard, type ShareCapabilities } from '../../src/features/share/types'
import { authorizeWrite, originFor, storeFor, type ShareEnv } from '../_lib/env'
import { handleError, json, wantsHtml } from '../_lib/respond'

/**
 * `/publications/*` — the write and listing API.
 *
 * The routes:
 *
 *   `POST /publications`                     publish a captured snapshot
 *   `POST /publications/:slug/revoke`        withdraw it
 *   `POST /publications/:slug/access`        change visibility or capabilities
 *   `POST /publications/:slug/tokens`        mint an unlisted link
 *   `POST /publications/:slug/tokens/:id/revoke`
 *   `GET  /publications/:slug/tokens`        list a publication's links
 *   `GET  /publications`                     the public gallery feed
 *
 * Every write is gated on `SHARE_PUBLISH_TOKEN`, which is a stopgap and is
 * documented as one — this workstream has no session layer of its own. The
 * *reads* need no secret and are governed by the same access gate as the page.
 *
 * Cards arrive base64-encoded alongside the publication. They are rendered in
 * the client, where the compiled geometry is already resident, from the exact
 * snapshot being published; re-rendering them here would mean shipping the
 * catalog into a Worker and would produce a card for a revision nobody asked
 * for. Each one is verified against the SHA-256 the record claims before it is
 * stored, so a tampered upload is rejected rather than served.
 */
export const onRequest = async (context: {
  request: Request
  env: ShareEnv
  params: { route?: string | string[] }
}): Promise<Response> => {
  const { request, env, params } = context
  const url = new URL(request.url)
  const origin = originFor(env, request)
  const route = Array.isArray(params.route) ? params.route : params.route ? [params.route] : []

  try {
    const store = storeFor(env)

    if (request.method === 'GET' && route.length === 0) {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '24', 10)
      const page = await store.listPublic({
        limit: Number.isFinite(limit) ? limit : 24,
        cursor: url.searchParams.get('cursor'),
      })
      return json({
        entries: page.entries.filter(isPubliclyListable).map(galleryEntryFrom),
        cursor: page.cursor,
      })
    }

    if (request.method === 'GET' && route.length === 2 && route[1] === 'tokens') {
      if (!(await authorizeWrite(env, request))) throw new ShareError('FORBIDDEN', 'Not permitted.', 403)
      const publication = await mustFind(store, route[0])
      const tokens = await store.listTokens(publication.id)
      // The record carries `secretHash`; the listing must not. Nothing outside
      // verification ever needs it, and a management UI that received it would
      // put it in a DOM.
      return json({
        tokens: tokens.map(({ secretHash, ...rest }) => ({ ...rest, secretHash: undefined })),
      })
    }

    if (request.method !== 'POST') {
      throw new ShareError('INVALID_INPUT', `${request.method} is not supported here.`, 405)
    }
    if (!(await authorizeWrite(env, request))) {
      throw new ShareError('FORBIDDEN', 'Publishing requires an authorised session.', 403)
    }

    const body = await readJsonBody(request)

    if (route.length === 0) return await publish(store, body)
    const slug = route[0]

    if (route.length === 2 && route[1] === 'revoke') {
      const publication = await mustFind(store, slug)
      await store.updateMetadata(revokePublication(publication))
      return json({ slug, revoked: true })
    }

    if (route.length === 2 && route[1] === 'access') {
      const publication = await mustFind(store, slug)
      const updated = updatePublicationAccess(publication, {
        visibility: parseVisibility(body.visibility),
        capabilities: parseCapabilities(body.capabilities),
      })
      await store.updateMetadata(updated)
      return json({ slug, visibility: updated.visibility, capabilities: updated.capabilities })
    }

    if (route.length === 2 && route[1] === 'tokens') {
      const publication = await mustFind(store, slug)
      const minted = await mintShareToken({
        publicationId: publication.id,
        slug: publication.slug,
        scope: parseCapabilities(body.scope) ?? publication.capabilities,
        label: sanitizeLabel(typeof body.label === 'string' ? body.label : 'Unlisted link'),
        expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      })
      await store.putToken(minted.record)
      // The secret is returned exactly once, here, and never stored. The record
      // that goes to storage carries only its SHA-256.
      return json(
        { token: minted.token, record: { ...minted.record, secretHash: undefined } },
        201,
      )
    }

    if (route.length === 4 && route[1] === 'tokens' && route[3] === 'revoke') {
      const publication = await mustFind(store, slug)
      const token = await store.getToken(route[2])
      if (!token || token.publicationId !== publication.id) {
        throw new ShareError('NOT_FOUND', 'No such link for this publication.', 404)
      }
      await store.putToken(revokeToken(token))
      return json({ slug, tokenId: token.id, revoked: true })
    }

    if (route.length === 2 && route[1] === 'report') {
      const publication = await mustFind(store, slug)
      const { submitReport } = await import('../../src/features/gallery/moderation')
      const report = submitReport({
        publicationId: publication.id,
        slug: publication.slug,
        reason: body.reason,
        detail: sanitizeComment(body.detail),
        reporterRef: typeof body.reporterRef === 'string' ? body.reporterRef : null,
      })
      await store.putReport(report)
      return json({ reportId: report.id, status: report.status }, 201)
    }

    throw new ShareError('NOT_FOUND', 'No such endpoint.', 404)
  } catch (cause) {
    return handleError(cause, { origin, wantsHtml: wantsHtml(request), path: url.pathname })
  }
}

async function mustFind(store: ReturnType<typeof storeFor>, slug: string): Promise<Publication> {
  const publication = await store.getBySlug(slug)
  if (!publication) throw new ShareError('NOT_FOUND', 'No published model was found at this address.', 404)
  return publication
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  // Checked before reading, so an oversized body is refused rather than
  // buffered. The post-read check catches a chunked upload that lied.
  if (Number.isFinite(declared) && declared > 0) guardPayloadSize(declared)
  const text = await request.text()
  guardPayloadSize(new TextEncoder().encode(text).byteLength)
  try {
    const parsed: unknown = JSON.parse(text || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ShareError('INVALID_INPUT', 'The request body must be a JSON object.')
    }
    return parsed as Record<string, unknown>
  } catch (cause) {
    if (cause instanceof ShareError) throw cause
    throw new ShareError('INVALID_INPUT', 'The request body is not valid JSON.')
  }
}

/**
 * Stores a publication and its cards.
 *
 * The publication is built client-side by `createPublication`, which is the
 * only code that may capture a snapshot. This route's job is to verify what
 * arrived and refuse anything that does not add up: a card whose bytes do not
 * hash to the recorded SHA-256, a slug that already exists, a payload over the
 * limit.
 */
async function publish(store: ReturnType<typeof storeFor>, body: Record<string, unknown>): Promise<Response> {
  const publication = body.publication as Publication | undefined
  if (!publication || typeof publication !== 'object' || typeof publication.slug !== 'string') {
    throw new ShareError('INVALID_INPUT', 'A publication record is required.')
  }
  if (!Array.isArray(publication.document?.parts)) {
    throw new ShareError('INVALID_INPUT', 'The publication carries no captured snapshot.')
  }
  if (publication.document.parts.length > LIMITS.parts) {
    throw new ShareError('PAYLOAD_TOO_LARGE', 'This model is larger than the publication limit.', 413)
  }

  const uploads = (body.cards ?? {}) as Record<string, string>
  for (const card of publication.cards as PublicationCard[]) {
    const encoded = uploads[card.preset]
    if (typeof encoded !== 'string') {
      throw new ShareError('INVALID_INPUT', `The "${card.preset}" card was declared but not uploaded.`)
    }
    const bytes = decodeBase64(encoded)
    const digest = await sha256HexOf(bytes)
    if (digest !== card.sha256) {
      // The record says these bytes hash to X; they do not. Either the upload
      // was corrupted or it was tampered with, and both mean the card is not
      // the render of the revision being published.
      throw new ShareError('INVALID_INPUT', `The "${card.preset}" card does not match its recorded hash.`)
    }
    if (bytes.byteLength !== card.byteLength) {
      throw new ShareError('INVALID_INPUT', `The "${card.preset}" card is not the length its record declares.`)
    }
    await store.putCard({ sha256: card.sha256, contentType: 'image/png', bytes })
  }

  await store.put(deepFreeze(publication))
  return json({ slug: publication.slug, id: publication.id, contentHash: publication.contentHash }, 201)
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const { sha256Hex } = await import('../../src/features/share/canonical')
  return sha256Hex(bytes)
}

function decodeBase64(value: string): Uint8Array {
  // `atob` exists in Workers, in Node 24 and in every browser this ships to.
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function parseVisibility(value: unknown): 'private' | 'unlisted' | 'public' | undefined {
  return value === 'private' || value === 'unlisted' || value === 'public' ? value : undefined
}

function parseCapabilities(value: unknown): ShareCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  return {
    view: raw.view === true,
    comment: raw.comment === true,
    fork: raw.fork === true,
    download: raw.download === true,
    embed: raw.embed === true,
  }
}
