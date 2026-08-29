import { AccountSettings } from '@hexclave/react'
import { MisconfiguredState } from '../states'
import { useAccountAvailability } from './account'
import { useAccountSession } from './accountSession'
import { AuthRequiredState, RestrictedState, SessionExpiredState, useReturnTo } from './guards'

/**
 * Account settings.
 *
 * Hexclave's `AccountSettings` owns the contents — profile, contact channels,
 * password, passkeys, connected Google and GitHub accounts, active sessions —
 * because those are the surfaces that must change when the platform's security
 * model changes, and a copy maintained here would rot into a liability.
 *
 * A restricted user is deliberately let through. This is the one page that can
 * fix the restriction: sending someone who has not verified their email to a
 * screen telling them to verify their email, with no way to resend it, is a
 * dead end.
 */

function AccountSurface() {
  const session = useAccountSession()
  const returnTo = useReturnTo()

  if (session.status === 'signed-out') return <AuthRequiredState route="account" returnTo={returnTo} />
  if (session.status === 'expired') return <SessionExpiredState route="account" returnTo={returnTo} />

  return (
    <section className="pf-account-page" aria-labelledby="pf-account-heading">
      <header className="pf-account-page__header">
        <span className="eyebrow">ACCOUNT</span>
        <h1 id="pf-account-heading">Your Brickwright account</h1>
        <p>
          Sign-in methods, connected accounts and active sessions. Your documents are not stored
          here — they live in your cloud projects.
        </p>
      </header>
      {session.status === 'restricted' ? (
        <RestrictedState
          restriction={session.restriction}
          detail={session.user.restrictedByAdminReason}
        />
      ) : null}
      <div className="pf-account-page__settings stack-scope">
        <AccountSettings fullPage={false} />
      </div>
    </section>
  )
}

export function AccountPage() {
  const availability = useAccountAvailability()
  if (availability.status === 'unavailable') {
    return <MisconfiguredState reason={availability.reason} checked={availability.checked} />
  }
  return <AccountSurface />
}

export default AccountPage
