import { HexclaveServerApp } from '@hexclave/js'

export interface AuthRequest {
  headers: Record<string, string | string[] | undefined> | Headers
}

export interface PaidRouteIdentity {
  userId: string
  displayName: string | null
}

export type PaidRouteAuthorization =
  | { ok: true; identity: PaidRouteIdentity }
  | { ok: false; status: 401 | 403 | 503; code: 'unauthorized' | 'restricted' | 'auth_unavailable'; detail: string }

interface HexclaveUserLike {
  id: string
  displayName: string | null
  isAnonymous: boolean
  isRestricted: boolean
}

export interface HexclaveRequestVerifier {
  getUser(request: AuthRequest): Promise<HexclaveUserLike | null>
}

let verifier: HexclaveRequestVerifier | null = null

function tokenRequest(request: AuthRequest): { headers: Headers } {
  if (request.headers instanceof Headers) return { headers: request.headers }
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return { headers }
}

function configuredVerifier(): HexclaveRequestVerifier | null {
  if (verifier) return verifier
  const projectId = process.env.HEXCLAVE_PROJECT_ID?.trim()
  const secretServerKey = process.env.HEXCLAVE_SECRET_SERVER_KEY?.trim()
  if (!projectId || !secretServerKey) return null

  const app = new HexclaveServerApp({
    projectId,
    secretServerKey,
    tokenStore: null,
    urls: { default: { type: 'hosted' } },
  })
  verifier = {
    getUser: (request) =>
      app.getUser({
        tokenStore: tokenRequest(request),
        or: 'throw',
        includeRestricted: true,
      }),
  }
  return verifier
}

/**
 * Verify a non-anonymous, unrestricted Hexclave session for a paid route.
 *
 * Missing server configuration is a 503, never an open door. Invalid, expired
 * or absent credentials are deliberately indistinguishable at 401. Restricted
 * accounts receive 403 so the UI can send them through their required account
 * step without retrying a model call.
 */
export async function authorizePaidRoute(
  request: AuthRequest,
  override?: HexclaveRequestVerifier,
): Promise<PaidRouteAuthorization> {
  const active = override ?? configuredVerifier()
  if (!active) {
    return {
      ok: false,
      status: 503,
      code: 'auth_unavailable',
      detail: 'Authentication is not configured for this API deployment.',
    }
  }

  let user: HexclaveUserLike | null
  try {
    user = await active.getUser(request)
  } catch {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      detail: 'Sign in to use model-backed tools.',
    }
  }

  if (!user || user.isAnonymous) {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      detail: 'Sign in to use model-backed tools.',
    }
  }
  if (user.isRestricted) {
    return {
      ok: false,
      status: 403,
      code: 'restricted',
      detail: 'Complete the required account checks before using model-backed tools.',
    }
  }
  return { ok: true, identity: { userId: user.id, displayName: user.displayName } }
}

/** Test seam: environment changes must be able to rebuild the SDK instance. */
export function resetPaidRouteVerifier(): void {
  verifier = null
}
