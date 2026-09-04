import { getHexclaveClientApp } from './client'

/**
 * Authorization header for Brickwright's own authenticated HTTP endpoints.
 *
 * Hexclave's cookie token store is useful for calls to Hexclave itself, but our
 * model and publication APIs need the same session in an explicit header. The
 * SDK owns the wire format (`Bearer stackauth_…`); callers must never assemble
 * it from cookies or access tokens themselves.
 */
export async function hexclaveAuthorizationHeader(): Promise<string | null> {
  const app = getHexclaveClientApp()
  if (app.status !== 'ok') return null
  try {
    return await app.data.getAuthorizationHeader()
  } catch {
    // A failed refresh is equivalent to a signed-out request here. The API will
    // return a typed 401 and the account guard can take the operator to sign in.
    return null
  }
}

export type AuthorizationHeaderSource = () => Promise<string | null>

/**
 * Authorization header for a build that has no account behind it.
 *
 * `{ or: 'anonymous' }` returns the signed-in user unchanged, or silently
 * mints a Hexclave guest session — no prompt, no redirect — the first time
 * anything asks for one. This is what lets the auto-publish trigger in
 * `cad/autopublish.ts` give a build *some* subject to own it, whether or not
 * the person building it ever created an account. `functions/_lib/env.ts`
 * verifies the guest session against Hexclave's separate anonymous-users
 * issuer, so this can never be mistaken for a real one server-side.
 */
export async function hexclaveAuthorizationHeaderOrAnonymous(): Promise<string | null> {
  const app = getHexclaveClientApp()
  if (app.status !== 'ok') return null
  try {
    await app.data.getUser({ or: 'anonymous' })
    return await app.data.getAuthorizationHeader()
  } catch {
    return null
  }
}

