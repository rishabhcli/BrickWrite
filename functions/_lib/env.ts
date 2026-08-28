import { KvPublicationStore } from '../../src/features/share/backend/kv-store'
import type { KvNamespace, PublicationStore } from '../../src/features/share/backend/adapter'

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
   * Bearer secret required to publish, revoke or mint a token.
   *
   * A stopgap, and recorded as one: workstream 8 owns sessions, so until the
   * Convex/Hexclave session check lands there is no way for this function to
   * know *which* account is asking. A shared secret at least means the public
   * internet cannot write. `docs/integration/share-studio.md` carries the
   * replacement instructions.
   */
  SHARE_PUBLISH_TOKEN?: string
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

/** Constant-time-ish bearer check for the write endpoints. */
export async function authorizeWrite(env: ShareEnv, request: Request): Promise<boolean> {
  const expected = env.SHARE_PUBLISH_TOKEN
  // No secret configured means writes are closed, not open. A deployment that
  // forgot to set it is read-only, which is the safe direction to fail.
  if (!expected) return false
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  const { constantTimeEqualHex } = await import('../../src/features/share/canonical')
  const { sha256Hex } = await import('../../src/features/share/canonical')
  return constantTimeEqualHex(await sha256Hex(presented), await sha256Hex(expected))
}
