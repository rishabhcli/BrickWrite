import { createContext, useContext, type ReactNode } from 'react'
import type { CurrentUser } from '@hexclave/react'

/**
 * The account layer's two facts: whether it exists, and who is signed in.
 *
 * Both have to be answerable without taking the CAD editor down. Hexclave is
 * constructed from an injected project ID that is legitimately absent in
 * several supported ways of running Brickwright, so "is there an account layer
 * at all?" is a rendered state rather than an assumption — and every component
 * that wants a user reads availability first, then calls `useUser` in a child
 * that only mounts when the provider is really there.
 *
 * This file is Hexclave-value-import free on purpose: the landing entry reads
 * availability, and a value import of `@hexclave/react` here would put the
 * account SDK on `/` again.
 */

export type AccountAvailability =
  | { status: 'ready' }
  | { status: 'pending' }
  | { status: 'unavailable'; reason: string; checked: readonly string[] }

const AvailabilityContext = createContext<AccountAvailability>({
  status: 'unavailable',
  reason: 'The Hexclave provider is not mounted above this component.',
  checked: [],
})

export function AccountAvailabilityProvider({
  availability,
  children,
}: {
  availability: AccountAvailability
  children: ReactNode
}) {
  return <AvailabilityContext.Provider value={availability}>{children}</AvailabilityContext.Provider>
}

export function useAccountAvailability(): AccountAvailability {
  return useContext(AvailabilityContext)
}

export type RestrictionKind =
  | 'anonymous'
  | 'email_not_verified'
  | 'restricted_by_administrator'
  | 'unknown'

export type AccountSession =
  | { status: 'signed-out' }
  | { status: 'expired' }
  | { status: 'restricted'; restriction: RestrictionKind; user: CurrentUser }
  | { status: 'signed-in'; user: CurrentUser }

/**
 * Remembered across unmounts so an expired session can be told apart from a
 * fresh one.
 *
 * Both look identical to `useUser()` — it returns `null` either way — but they
 * are completely different messages to show someone. Deliberately module state
 * rather than component state: the distinction has to survive the navigation
 * that the expiry itself usually causes.
 */
let lastKnownUserId: string | null = null
let signedOutDeliberately = false

/** Called by the sign-out control, so the next `null` reads as intentional. */
export function markDeliberateSignOut(): void {
  signedOutDeliberately = true
  lastKnownUserId = null
}

/** Clear the remembered session. Tests use this; runtime code does not. */
export function resetSessionMemory(): void {
  lastKnownUserId = null
  signedOutDeliberately = false
}

/** Called when a real user is observed, so a later `null` can mean expiry. */
export function noteSignedIn(userId: string): void {
  lastKnownUserId = userId
  signedOutDeliberately = false
}

export function sessionWhenSignedOut(): 'expired' | 'signed-out' {
  if (lastKnownUserId !== null && !signedOutDeliberately) return 'expired'
  return 'signed-out'
}

export function restrictionKind(user: CurrentUser): RestrictionKind {
  const reason: unknown = user.restrictedReason
  const type =
    reason !== null && typeof reason === 'object' && 'type' in reason
      ? (reason as { type?: unknown }).type
      : undefined
  if (type === 'anonymous' || type === 'email_not_verified' || type === 'restricted_by_administrator') {
    return type
  }
  return 'unknown'
}

/** How the operator's account is labelled, without inventing a display name. */
export function accountLabel(user: CurrentUser): string {
  const name = user.displayName?.trim()
  if (name) return name
  const email = user.primaryEmail?.trim()
  if (email) return email
  return 'Your account'
}
