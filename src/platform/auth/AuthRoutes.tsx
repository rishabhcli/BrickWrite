import { useEffect } from 'react'
import { Link, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthPage } from '@hexclave/react'
import { PLATFORM_PATHS, PLATFORM_URL_DESTINATIONS } from '../config'
import { usePlatformAnalytics } from '../analytics'
import { MisconfiguredState, StatePanel } from '../states'
import { useAccountAvailability, useAccountSession } from './account'
import { RestrictedState } from './guards'

/**
 * Sign-in and sign-up, on Brickwright's own routes.
 *
 * These use Hexclave's `AuthPage`, which renders exactly the methods the
 * project has enabled — password, one-time code, passkey, Google and GitHub per
 * `hexclave.config.ts` — so the page cannot drift out of step with the project
 * configuration the way a hand-rolled form would. Hosting it here rather than on
 * Hexclave's domain keeps the operator inside Brickwright's chrome, its fonts
 * and its offline banner; every other auth page (verification, password reset,
 * the OAuth and magic-link callbacks, MFA) stays on Hexclave's hosted pages,
 * where changes to security-sensitive flows arrive without a Brickwright
 * release.
 */

/** Only same-origin, absolute-path returns. An open redirect here is an account takeover. */
export function safeReturnTo(raw: string | null, fallback: string): string {
  if (!raw) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
  return raw
}

function AuthPanel({ type }: { type: 'sign-in' | 'sign-up' }) {
  const session = useAccountSession()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { track } = usePlatformAnalytics()
  const fallback = type === 'sign-in' ? PLATFORM_URL_DESTINATIONS.afterSignIn : PLATFORM_URL_DESTINATIONS.afterSignUp
  const returnTo = safeReturnTo(params.get('return_to'), fallback)
  const signedIn = session.status === 'signed-in'

  useEffect(() => {
    track({ name: type === 'sign-in' ? 'auth.sign_in_opened' : 'auth.sign_up_opened', route: 'account' })
  }, [track, type])

  useEffect(() => {
    if (!signedIn) return
    track({ name: 'auth.signed_in' })
    // Hexclave's own redirect-back usually gets here first; this covers the
    // path where the operator arrived through a plain link carrying return_to.
    navigate(returnTo, { replace: true })
  }, [navigate, returnTo, signedIn, track])

  if (session.status === 'restricted') {
    return <RestrictedState restriction={session.restriction} detail={session.user.restrictedByAdminReason} />
  }

  if (signedIn) {
    return <Navigate to={returnTo} replace />
  }

  const heading = type === 'sign-in' ? 'Sign in to Brickwright' : 'Create a Brickwright account'

  return (
    <section className="pf-auth" aria-labelledby="pf-auth-heading">
      <div className="pf-auth__intro">
        <span className="eyebrow">{type === 'sign-in' ? 'ACCOUNT' : 'NEW ACCOUNT'}</span>
        <h1 id="pf-auth-heading">{heading}</h1>
        <p>
          An account is what lets a build leave this browser: cloud projects, share links and
          publication. The editor itself never requires one.
        </p>
        <p className="pf-auth__switch">
          {type === 'sign-in' ? (
            <>
              No account yet? <Link to={`${PLATFORM_PATHS.signUp}?return_to=${encodeURIComponent(returnTo)}`}>Create one</Link>.
            </>
          ) : (
            <>
              Already have one? <Link to={`${PLATFORM_PATHS.signIn}?return_to=${encodeURIComponent(returnTo)}`}>Sign in</Link>.
            </>
          )}
        </p>
        <Link className="pf-button" to={PLATFORM_PATHS.editor}>
          Continue without an account
        </Link>
      </div>
      <div className="pf-auth__form stack-scope">
        <AuthPage type={type} fullPage={false} automaticRedirect={false} />
      </div>
    </section>
  )
}

function AuthSurface({ type }: { type: 'sign-in' | 'sign-up' }) {
  const availability = useAccountAvailability()
  if (availability.status === 'unavailable') {
    return <MisconfiguredState reason={availability.reason} checked={availability.checked} />
  }
  return <AuthPanel type={type} />
}

export function SignInSurface() {
  return <AuthSurface type="sign-in" />
}

export function SignUpSurface() {
  return <AuthSurface type="sign-up" />
}

/** Mounted by the shell at `/auth/*`. */
export function AuthRoutes() {
  return (
    <Routes>
      <Route path="sign-in" element={<SignInSurface />} />
      <Route path="sign-up" element={<SignUpSurface />} />
      <Route
        path="*"
        element={
          <StatePanel
            tone="notice"
            eyebrow="UNKNOWN AUTH PAGE"
            heading="Brickwright does not host that authentication page"
            actions={
              <Link className="pf-button pf-button--primary" to={PLATFORM_PATHS.signIn}>
                Go to sign in
              </Link>
            }
          >
            <p>
              Only sign-in and sign-up live on this domain. Email verification, password reset and
              the OAuth callbacks are hosted by Hexclave and reached from the emails and buttons
              that start them.
            </p>
          </StatePanel>
        }
      />
    </Routes>
  )
}
