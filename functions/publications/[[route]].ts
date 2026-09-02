import { isPubliclyListable } from '../../src/features/share/access'
import { galleryEntryFrom } from '../../src/features/share/gallery-projection'
import {
  deepFreeze,
  normaliseAuthor,
  revokePublication,
  updatePublicationAccess,
  verifyPublicationIntegrity,
} from '../../src/features/share/publish'
import {
  guardPayloadSize,
  LIMITS,
  sanitizeComment,
  sanitizeDescription,
  sanitizeLabel,
  sanitizeTags,
  sanitizeText,
  sanitizeTitle,
} from '../../src/features/share/sanitize'
import { mintShareToken, revokeToken } from '../../src/features/share/tokens'
import { ShareError, type Publication, type PublicationCard, type ShareCapabilities } from '../../src/features/share/types'
import { authorizePrincipal, originFor, storeFor, type SharePrincipal, type ShareEnv } from '../_lib/env'
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
 * Every write resolves a principal first — a verified Hexclave session, or the
 * deployment-wide operator secret for tooling — and every write against an
 * existing publication then checks that principal against the publication's
 * recorded owner. Possession of a credential is not authority over somebody
 * else's model. The *reads* need no secret and are governed by the same access
 * gate as the page.
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
      const principal = await authorizePrincipal(env, request)
      if (!principal) throw new ShareError('FORBIDDEN', 'Not permitted.', 403)
      const publication = await mustOwn(store, route[0], principal)
      const tokens = await store.listTokens(publication.id)
      // The record carries `secretHash`; the listing must not. Nothing outside
      // verification ever needs it, and a management UI that received it would
      // put it in a DOM.
      return json({
        tokens: tokens.map(({ secretHash: _secretHash, ...rest }) => ({ ...rest, secretHash: undefined })),
      })
    }

    if (request.method !== 'POST') {
      throw new ShareError('INVALID_INPUT', `${request.method} is not supported here.`, 405)
    }
    const principal = await authorizePrincipal(env, request)
    if (!principal) {
      throw new ShareError('FORBIDDEN', 'Publishing requires an authorised session.', 403)
    }

    const body = await readJsonBody(request)

    if (route.length === 0) return await publish(store, body, principal)
    const slug = route[0]

    if (route.length === 2 && route[1] === 'revoke') {
      const publication = await mustOwn(store, slug, principal)
      await store.updateMetadata(revokePublication(publication))
      return json({ slug, revoked: true })
    }

    if (route.length === 2 && route[1] === 'access') {
      const publication = await mustOwn(store, slug, principal)
      const updated = updatePublicationAccess(publication, {
        visibility: parseVisibility(body.visibility),
        capabilities: parseCapabilities(body.capabilities),
      })
      await store.updateMetadata(updated)
      return json({ slug, visibility: updated.visibility, capabilities: updated.capabilities })
    }

    if (route.length === 2 && route[1] === 'tokens') {
      const publication = await mustOwn(store, slug, principal)
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
      const publication = await mustOwn(store, slug, principal)
      const token = await store.getToken(route[2])
      if (!token || token.publicationId !== publication.id) {
        throw new ShareError('NOT_FOUND', 'No such link for this publication.', 404)
      }
      await store.putToken(revokeToken(token))
      return json({ slug, tokenId: token.id, revoked: true })
    }

    if (route.length === 2 && route[1] === 'report') {
      const publication = await mustFind(store, slug)
      const { reportIdFor, reporterPseudonym, submitReport } = await import(
        '../../src/features/gallery/moderation'
      )
      // The principal is already verified, so the reporter reference is derived
      // rather than accepted. Taking it from the body let one account file
      // unlimited reports by sending a different reference each time — which is
      // the rate limit this endpoint was documented as having.
      const reporterRef = await reporterPseudonym(publication.id, principal.subject)
      const report = submitReport({
        publicationId: publication.id,
        slug: publication.slug,
        reason: body.reason,
        detail: sanitizeComment(body.detail),
        reporterRef,
        id: reportIdFor(reporterRef),
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

/**
 * Resolves a publication the caller is entitled to change.
 *
 * A caller who is not the owner is told `NOT_FOUND`, the same answer a missing
 * slug gets. `FORBIDDEN` would confirm that a particular slug is published,
 * which for a `private` or `unlisted` publication is exactly the fact its
 * publisher chose not to disclose — the same reasoning `convex/model/auth.ts`
 * applies to private projects.
 *
 * Two principals pass: the recorded owner, and the operator. The operator is
 * also the only way to administer a publication written before ownership
 * existed, because there is nothing else to compare such a record against.
 */
async function mustOwn(
  store: ReturnType<typeof storeFor>,
  slug: string,
  principal: SharePrincipal,
): Promise<Publication> {
  const publication = await mustFind(store, slug)
  if (principal.kind === 'operator') return publication
  if (publication.ownerSubject && publication.ownerSubject === principal.subject) return publication
  throw new ShareError('NOT_FOUND', 'No published model was found at this address.', 404)
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
 * only code that may capture a snapshot — the compiled catalogue a summary needs
 * is deliberately not shipped into a Worker. That makes the *record* untrusted
 * input, and this route re-derives every field of it that it can:
 *
 *   - **`contentHash` is recomputed** over the submitted document and compared.
 *     Without this the hash attests to nothing, because the only code that ever
 *     produced it ran in the browser that also chose the document.
 *   - **Every text field is sanitised again.** `sanitize.ts` says the defence is
 *     "at ingest, and again at output"; ingest ran in the client, so this is the
 *     ingest layer actually existing.
 *   - **`revokedAt` and `moderation` are forced to null.** Otherwise publishing
 *     is a way to clear a moderation decision, or to ship a record that reads as
 *     already-withdrawn.
 *   - **Capabilities are derived from visibility**, not accepted, so a `private`
 *     publication cannot arrive carrying `embed: true`.
 *   - **The summary's three countable fields are cross-checked** against the
 *     document. The rest of the summary needs the catalogue and is carried
 *     through as submitted; it is display-only and reaches the page through the
 *     same escaping sink as everything else.
 *   - **The owner is the caller**, never a field in the body.
 *
 * Card bytes are verified against the SHA-256 the record claims, so a tampered
 * upload is rejected rather than served.
 */
async function publish(
  store: ReturnType<typeof storeFor>,
  body: Record<string, unknown>,
  principal: SharePrincipal,
): Promise<Response> {
  const submitted = body.publication as Publication | undefined
  if (!submitted || typeof submitted !== 'object' || typeof submitted.slug !== 'string') {
    throw new ShareError('INVALID_INPUT', 'A publication record is required.')
  }
  if (!Array.isArray(submitted.document?.parts)) {
    throw new ShareError('INVALID_INPUT', 'The publication carries no captured snapshot.')
  }
  if (submitted.document.parts.length > LIMITS.parts) {
    throw new ShareError('PAYLOAD_TOO_LARGE', 'This model is larger than the publication limit.', 413)
  }
  // A slug becomes a URL path segment and a KV key. Anything outside the shape
  // `mintSlug` produces is a namespace grab or a traversal attempt.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(submitted.slug) || submitted.slug.length > 96) {
    throw new ShareError('INVALID_INPUT', 'That publication address is not a valid slug.')
  }
  /*
   * A re-presented publish is the original one, not a conflict.
   *
   * The client mints the slug and posts the record, so a retry after a lost
   * response resends exactly what it sent before — and this refused it, telling
   * the publisher their address was taken by their own publication. A large
   * model over a slow link is precisely when a response goes missing, and the
   * only ways out were to reload and guess, or to publish a second copy at a
   * second address.
   *
   * Answering a repeat with its original outcome is what `projects.create`,
   * `transactions.append` and `invitations.accept` already do. Identity is
   * checked strictly — same id, same content hash, same revision, same owner —
   * so a different snapshot or a different account at that slug is still a
   * genuine collision and still refuses.
   */
  const existing = await store.getBySlug(submitted.slug)
  if (existing) {
    const sameRecord =
      existing.id === submitted.id &&
      existing.contentHash === submitted.contentHash &&
      existing.revision === submitted.revision
    const sameOwner =
      principal.kind === 'operator' || (existing.ownerSubject !== undefined && existing.ownerSubject === principal.subject)
    if (!sameRecord || !sameOwner) {
      throw new ShareError('IMMUTABLE', 'A publication already exists at that address.', 409)
    }
  }
  if (!(await verifyPublicationIntegrity(submitted))) {
    throw new ShareError('INVALID_INPUT', 'The publication does not hash to the content it declares.')
  }
  if (submitted.revision !== submitted.document.revision) {
    throw new ShareError('INVALID_INPUT', 'The publication and its snapshot disagree about the revision.')
  }
  const summary = submitted.summary
  if (
    !summary ||
    summary.partCount !== submitted.document.parts.length ||
    summary.stepCount !== (submitted.document.steps?.length ?? 0) ||
    summary.uniquePartCount !== new Set(submitted.document.parts.map((part) => part.definitionId)).size
  ) {
    throw new ShareError('INVALID_INPUT', 'The publication summary does not describe its own snapshot.')
  }

  const publication = rederive(submitted, principal)

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
  // 200 rather than 201 on a repeat: nothing was created this time, and a
  // client that distinguishes them should be told the truth.
  return json(
    { slug: publication.slug, id: publication.id, contentHash: publication.contentHash },
    existing ? 200 : 201,
  )
}

/**
 * Rebuilds the record from the parts of it this deployment is willing to vouch
 * for. Everything not re-derived here is carried through deliberately, because
 * re-deriving it needs the compiled catalogue.
 */
function rederive(submitted: Publication, principal: SharePrincipal): Publication {
  const visibility =
    submitted.visibility === 'public' || submitted.visibility === 'unlisted' || submitted.visibility === 'private'
      ? submitted.visibility
      : 'private'
  const sanitised: Publication = {
    ...submitted,
    visibility,
    title: sanitizeTitle(submitted.title) || 'Untitled build',
    description: sanitizeDescription(submitted.description ?? ''),
    tags: sanitizeTags(submitted.tags ?? []),
    author: normaliseAuthor(submitted.author),
    license: sanitizeText(submitted.license || '', 64),
    // A publisher may not ship a record that is already withdrawn, and may not
    // clear a moderation decision by republishing the same model.
    revokedAt: null,
    moderation: null,
    ownerSubject: principal.subject,
  }
  // Re-derives `capabilities` from `visibility` rather than trusting the body.
  return updatePublicationAccess(sanitised, { visibility, capabilities: submitted.capabilities })
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
