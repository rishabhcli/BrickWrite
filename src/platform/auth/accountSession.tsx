import { useEffect } from 'react'
import { useUser } from '@hexclave/react'
import {
  noteSignedIn,
  restrictionKind,
  sessionWhenSignedOut,
  type AccountSession,
} from './account'

/**
 * The current session.
 *
 * Only call this below an {@link AccountAvailabilityProvider} reporting
 * `ready`; `useUser` requires the Hexclave provider and suspends while it
 * resolves, so the caller also needs a Suspense boundary above it.
 *
 * Kept out of `account.tsx` so the shell can import availability without
 * pulling the account SDK onto the landing critical path.
 */
export function useAccountSession(): AccountSession {
  const user = useUser({ includeRestricted: true })

  useEffect(() => {
    if (!user) return
    noteSignedIn(user.id)
  }, [user])

  if (!user) return { status: sessionWhenSignedOut() }
  if (user.isRestricted) return { status: 'restricted', restriction: restrictionKind(user), user }
  return { status: 'signed-in', user }
}
