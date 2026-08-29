import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useHexclaveApp } from '@hexclave/react'
import type { RouteId } from '../contracts'
import { PLATFORM_PATHS } from '../config'
import { usePlatformAnalytics } from '../analytics'
import { LoadingState, MisconfiguredState, StatePanel } from '../states'
import { accountLabel, markDeliberateSignOut, useAccountAvailability } from './account'
import { useAccountSession } from './accountSession'

/**
 * `requiresAuth`, made into UI.
 *
 * Three things can be true when a signed-in-only surface is asked for, and each
 * one is a different sentence: there is no account layer at all, there is one
 * but nobody is signed in, or there is a user who is not allowed through yet.
 * Collapsing them into a single redirect would strand an operator on a sign-in
 * page that cannot help them.
 *
 * Note what is *not* here: the editor. Signed-out CAD editing is fully
 * functional, and no guard stands in front of it. Authentication in Brickwright
 * adds cloud storage and publication to local work; it never holds the work
 * hostage.
 */

/** The path to come back to after signing in, including the query string. */
export function useReturnTo(): string {
  const location = useLocation()
  return `${location.pathname}${location.search}`
}

export function signInHref(returnTo: string): string {
  return `${PLATFORM_PATHS.signIn}?return_to=${encodeURIComponent(returnTo)}`
}

export function signUpHref(returnTo: string): string {
  return `${PLATFORM_PATHS.signUp}?return_to=${encodeURIComponent(returnTo)}`
}

/** Nobody is signed in, and this surface needs somebody. */
export function AuthRequiredState({ route, returnTo }: { route: RouteId; returnTo: string }) {
  const app = useHexclaveApp()
  const { track } = usePlatformAnalytics()

  useEffect(() => {
    track({ name: 'auth.required', route })
    // Hexclave's own redirect carries runtime redirect-back state that a plain
    // link cannot, so it is the preferred path. The panel below is not a
    // fallback for a slow redirect — it is what a keyboard or screen-reader
    // user lands on if the redirect is blocked, and it does the same job.
    void app.redirectToSignIn()
  }, [app, route, track])

  return (
    <StatePanel
      tone="notice"
      eyebrow="SIGN IN REQUIRED"
      heading="This surface needs an account"
      actions={
        <>
          <Link className="pf-button pf-button--primary" to={signInHref(returnTo)}>
            Sign in
          </Link>
          <Link className="pf-button" to={signUpHref(returnTo)}>
            Create an account
          </Link>
        </>
      }
    >
      <p>
        Taking you to sign in. Afterwards you will come back to <code>{returnTo}</code>.
      </p>
      <p className="pf-state__hint">
        The editor does not need this. You can keep building locally without an account — signing in
        is what lets a build leave this browser.
      </p>
    </StatePanel>
  )
}

/** There was a user a moment ago, and there is not now. */
export function SessionExpiredState({ route, returnTo }: { route: RouteId; returnTo: string }) {
  const app = useHexclaveApp()
  const { track } = usePlatformAnalytics()

  useEffect(() => {
    track({ name: 'auth.session_expired', route })
  }, [route, track])

  return (
    <StatePanel
      tone="warning"
      eyebrow="SESSION EXPIRED"
      heading="Your sign-in has expired"
      actions={
        <>
          <button
            type="button"
            className="pf-button pf-button--primary"
            onClick={() => {
              void app.redirectToSignIn()
            }}
          >
            Sign in again
          </button>
          <Link className="pf-button" to={PLATFORM_PATHS.editor}>
            Keep working locally
          </Link>
        </>
      }
    >
      <p>
        Signing in again brings you back to <code>{returnTo}</code>. Nothing was lost: work in the
        editor lives in this browser until you save it to the cloud.
      </p>
    </StatePanel>
  )
}

const RESTRICTION_COPY: Record<string, { heading: string; body: string }> = {
  anonymous: {
    heading: 'This is a guest session',
    body:
      'You are signed in anonymously, which is enough to build but not to own cloud projects. ' +
      'Create an account to keep this work against your name.',
  },
  email_not_verified: {
    heading: 'Verify your email address to continue',
    body:
      'Brickwright sent a verification link when the account was created. Cloud projects and ' +
      'publication unlock as soon as the address is confirmed.',
  },
  restricted_by_administrator: {
    heading: 'An administrator has restricted this account',
    body: 'Account settings remain available so you can see the reason and contact support.',
  },
  unknown: {
    heading: 'This account cannot use cloud features yet',
    body: 'Hexclave reports the account as restricted without giving a reason Brickwright recognises.',
  },
}

/** A user exists but has not completed what the project requires of them. */
export function RestrictedState({
  restriction,
  detail,
}: {
  restriction: 'anonymous' | 'email_not_verified' | 'restricted_by_administrator' | 'unknown'
  detail?: string | null
}) {
  const { track } = usePlatformAnalytics()
  useEffect(() => {
    track({ name: 'auth.restricted', restriction })
  }, [restriction, track])
  const copy = RESTRICTION_COPY[restriction] ?? RESTRICTION_COPY.unknown!

  return (
    <StatePanel
      tone="warning"
      eyebrow="ACCOUNT RESTRICTED"
      heading={copy.heading}
      detail={detail ?? undefined}
      actions={
        <>
          <Link className="pf-button pf-button--primary" to={PLATFORM_PATHS.account}>
            Open account settings
          </Link>
          <Link className="pf-button" to={PLATFORM_PATHS.editor}>
            Keep working locally
          </Link>
        </>
      }
    >
      <p>{copy.body}</p>
    </StatePanel>
  )
}

/**
 * Routes a restricted user is still allowed to reach.
 *
 * Exactly one, and it is not an oversight: account settings is where a
 * restriction gets fixed. Sending someone who has not verified their email to a
 * page telling them to verify their email, with no way to resend the message,
 * is a dead end. The surface itself shows the restriction banner above the
 * settings — see `AccountPage`.
 */
const RESTRICTION_EXEMPT_ROUTES: readonly RouteId[] = ['account']

/**
 * The gate itself, split so `useAccountSession` is only ever called under a
 * real Hexclave provider.
 */
function SessionGate({ route, children }: { route: RouteId; children: ReactNode }) {
  const session = useAccountSession()
  const returnTo = useReturnTo()

  switch (session.status) {
    case 'signed-out':
      return <AuthRequiredState route={route} returnTo={returnTo} />
    case 'expired':
      return <SessionExpiredState route={route} returnTo={returnTo} />
    case 'restricted':
      if (RESTRICTION_EXEMPT_ROUTES.includes(route)) return <>{children}</>
      return (
        <RestrictedState
          restriction={session.restriction}
          detail={session.user.restrictedByAdminReason ?? undefined}
        />
      )
    case 'signed-in':
      return <>{children}</>
  }
}

/** Wrap a surface whose route declares `requiresAuth`. */
export function RouteAuthGuard({ route, children }: { route: RouteId; children: ReactNode }) {
  const availability = useAccountAvailability()
  if (availability.status === 'pending') {
    return <LoadingState headline="Checking your account" />
  }
  if (availability.status === 'unavailable') {
    return <MisconfiguredState reason={availability.reason} checked={availability.checked} />
  }
  return <SessionGate route={route}>{children}</SessionGate>
}

/**
 * Sign out, and remember that it was on purpose.
 *
 * Without the marker the next render sees `useUser() === null` and cannot tell
 * a deliberate sign-out from an expiry, so it would accuse the operator's
 * network of dropping a session they closed themselves.
 */
export function useSignOut(): () => Promise<void> {
  const app = useHexclaveApp()
  const { track } = usePlatformAnalytics()
  return async () => {
    markDeliberateSignOut()
    track({ name: 'auth.signed_out' })
    await app.signOut()
  }
}

export { accountLabel }
