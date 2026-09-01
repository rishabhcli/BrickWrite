import { KvPublicationStore } from '../../src/features/share/backend/kv-store'
import type { KvNamespace, PublicationStore } from '../../src/features/share/backend/adapter'
import { createSessionVerifier, type SessionVerifier } from './session'

/**
 * The Pages Function environment.
 *
 * Everything the share surface needs from the platform, named once. Cloudflare
 * injects `env` per request; nothing here is read from a module-level global,
 * because a Worker isolate is shared between requests and module state that
 * outlives one is how a token from one visitor ends up in another's response.
 */
export interface ShareEnv {
  /** KV namespace holding publications, cards, tokens, reports, collections. */
  SHARE_KV?: KvNamespace
  /**
   * Bearer secret for server-to-server tooling.
   *
   * No longer the only way to write. It identifies *an operator*, not an
   * account — one deployment-wide principal that `tools/e2e/share.mjs`,
   * `functions/_dev/*` and any migration script authenticate as. A normal
   * publisher presents a Hexclave session instead and owns what they publish.
   *
   * Kept because legacy publications carry no owner and something has to be
   * able to administer them; see `ownerOf` in `functions/publications`.
   */
  SHARE_PUBLISH_TOKEN?: string
  /**
   * The Hexclave project whose sessions this deployment trusts.
   *
   * Absent means no session can be verified and only the operator secret works
   * — the pre-ownership behaviour, which is the safe direction to degrade in.
   */
  HEXCLAVE_PROJECT_ID?: string
  /** Override for the Hexclave API origin. Defaults to the hosted one. */
  HEXCLAVE_API_URL?: string
  /** Canonical origin, e.g. `https://brickwrite.tech`. */
  SHARE_ORIGIN?: string
  /** Space-separated origins allowed to frame an embed. Empty means any https. */
  SHARE_EMBED_ANCESTORS?: string
  /** Static asset binding, present on Pages. */
  ASSETS?: { fetch(request: Request): Promise<Response> }
}

export class MissingBindingError extends Error {
  constructor(binding: string) {
    super(
      `The ${binding} binding is not configured for this deployment, so the share surface cannot serve. ` +
        'See docs/integration/share-studio.md for the required bindings.',
    )
    this.name = 'MissingBindingError'
  }
}

export function storeFor(env: ShareEnv): PublicationStore {
  if (!env.SHARE_KV) throw new MissingBindingError('SHARE_KV')
  return new KvPublicationStore(env.SHARE_KV)
}

/**
 * The origin to build absolute URLs from.
 *
 * `SHARE_ORIGIN` wins when it is set, because a canonical URL must not follow
 * whatever `Host` header a request arrived with — that is how a canonical tag
 * ends up pointing at an attacker's domain. The request origin is the fallback
 * for preview deployments, where the hostname is generated per branch.
 */
export function originFor(env: ShareEnv, request: Request): string {
  const configured = env.SHARE_ORIGIN?.trim()
  if (configured && /^https?:\/\/[^\s/]+$/.test(configured)) return configured.replace(/\/+$/, '')
  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

export function embedAncestors(env: ShareEnv): string[] | null {
  const raw = env.SHARE_EMBED_ANCESTORS?.trim()
  if (!raw) return null
  const entries = raw.split(/\s+/).filter(Boolean)
  return entries.length ? entries : null
}

/**
 * Who is asking.
 *
 * `operator` is the deployment-wide secret: one principal, shared, for tooling.
 * `session` is a real account, verified against the project's published key set.
 * A publication records the subject that created it and refuses writes from any
 * other session, which is the ownership model this surface did not have.
 */
export type SharePrincipal =
  | { readonly kind: 'operator'; readonly subject: OPERATOR_SUBJECT }
  | { readonly kind: 'session'; readonly subject: string }

/**
 * The owner value written for anything the operator secret publishes.
 *
 * A reserved string rather than `undefined`, so "published by tooling" and
 * "published before ownership existed" stay distinguishable — the second is
 * grandfathered and the first is not. The `@` prefix cannot collide with a
 * Hexclave subject.
 */
export type OPERATOR_SUBJECT = '@operator'
export const OPERATOR_SUBJECT: OPERATOR_SUBJECT = '@operator'

const HEXCLAVE_DEFAULT_ORIGIN = 'https://api.hexclave.com'

let verifierFor: { key: string; verifier: SessionVerifier } | null = null

/**
 * The session verifier for this deployment, built once per isolate.
 *
 * Keyed on the configuration it was built from: a Worker isolate outlives a
 * request, and a verifier still pointing at a previous project's key set would
 * accept the wrong issuer's tokens.
 */
function sessionVerifier(env: ShareEnv): SessionVerifier | null {
  const projectId = env.HEXCLAVE_PROJECT_ID?.trim()
  if (!projectId) return null
  const origin = (env.HEXCLAVE_API_URL?.trim() || HEXCLAVE_DEFAULT_ORIGIN).replace(/\/+$/, '')
  const key = `${origin}|${projectId}`
  if (verifierFor?.key === key) return verifierFor.verifier
  // Only the normal issuer. The anonymous-users issuer signs with the same key
  // set, so admitting it would make an anonymous token a publisher.
  const issuer = `${origin}/api/v1/projects/${projectId}`
  const verifier = createSessionVerifier({ issuer, jwksUrl: `${issuer}/.well-known/jwks.json` })
  verifierFor = { key, verifier }
  return verifier
}

/** Test seam: configuration changes must be able to rebuild the verifier. */
export function resetShareSessionVerifier(): void {
  verifierFor = null
}

/**
 * Resolves the caller, or null when they may not write.
 *
 * A JWT and the operator secret both arrive as `Authorization: Bearer`, and are
 * told apart by shape: a JWT is three non-empty dot-separated segments and
 * nothing else is. An opaque credential is never run through the verifier and a
 * JWT is never compared against the operator secret, so neither path can be used
 * to probe the other.
 */
export async function authorizePrincipal(env: ShareEnv, request: Request): Promise<SharePrincipal | null> {
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!presented) return null

  const looksLikeJwt = presented.split('.').length === 3 && !presented.split('.').some((part) => part.length === 0)
  if (looksLikeJwt) {
    const verifier = sessionVerifier(env)
    if (!verifier) return null
    const claims = await verifier.verify(presented)
    return claims ? { kind: 'session', subject: claims.subject } : null
  }

  const expected = env.SHARE_PUBLISH_TOKEN
  // No secret configured means writes are closed, not open. A deployment that
  // forgot to set it is read-only, which is the safe direction to fail.
  if (!expected) return null
  const { constantTimeEqualHex, sha256Hex } = await import('../../src/features/share/canonical')
  const matches = constantTimeEqualHex(await sha256Hex(presented), await sha256Hex(expected))
  return matches ? { kind: 'operator', subject: OPERATOR_SUBJECT } : null
}

/** Whether the caller may write at all. Retained for read-only route guards. */
export async function authorizeWrite(env: ShareEnv, request: Request): Promise<boolean> {
  return (await authorizePrincipal(env, request)) !== null
}
