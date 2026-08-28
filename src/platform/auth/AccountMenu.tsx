import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { UserAvatar, type CurrentUser } from '@hexclave/react'
import { PLATFORM_PATHS } from '../config'
import { CAD_CONTENT_MASK_CLASS, usePlatformAnalytics } from '../analytics'
import { useFocusTrap } from '../a11y'
import { accountLabel, useAccountAvailability, useAccountSession } from './account'
import { signInHref, signUpHref, useSignOut } from './guards'

/**
 * The account control in the application frame.
 *
 * Its most important state is the signed-out one. Brickwright is usable — fully
 * usable — without an account, so the control must not read as a locked door.
 * It says what is true instead: the work is local, and signing in is what moves
 * it off this machine.
 */

function LocalOnlyBadge({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="pf-account pf-account--local" role="note" aria-label={`${label}. ${hint}`}>
      <span className="pf-account__dot" aria-hidden="true" />
      <span className="pf-account__lines">
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </span>
  )
}

function SignedOutAccount({ expired }: { expired: boolean }) {
  const location = useLocation()
  const returnTo = `${location.pathname}${location.search}`
  return (
    <div className="pf-account pf-account--signed-out">
      <LocalOnlyBadge
        label={expired ? 'Signed out' : 'Local only'}
        hint={expired ? 'Your session expired — sign in to resume cloud saving' : 'Sign in to save to the cloud'}
      />
      <Link className="pf-button pf-button--primary pf-button--compact" to={signInHref(returnTo)}>
        Sign in
      </Link>
      <Link className="pf-button pf-button--compact" to={signUpHref(returnTo)}>
        Create account
      </Link>
    </div>
  )
}

function SignedInAccount({ user, restricted }: { user: CurrentUser; restricted: boolean }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const dialogId = useId()
  const signOut = useSignOut()
  const { track } = usePlatformAnalytics()
  const close = useCallback(() => setOpen(false), [])
  const dialogRef = useFocusTrap(open, { onEscape: close, restoreTo: triggerRef })

  useEffect(() => {
    if (!open) return
    // A click anywhere else dismisses the menu, the way every other menu in the
    // editor behaves. Registered on pointerdown so it fires before focus moves.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (dialogRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [dialogRef, open])

  const label = accountLabel(user)

  return (
    <div className="pf-account pf-account--signed-in">
      {restricted ? (
        <Link className="pf-chip pf-chip--warning" to={PLATFORM_PATHS.account}>
          Action needed
        </Link>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        className="pf-account__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <UserAvatar user={user} size={26} />
        <span className={`pf-account__name ${CAD_CONTENT_MASK_CLASS}`}>{label}</span>
      </button>

      {open ? (
        <div
          id={dialogId}
          ref={dialogRef as React.RefObject<HTMLDivElement>}
          className="pf-account__menu"
          role="dialog"
          aria-modal="true"
          aria-label="Account"
          tabIndex={-1}
        >
          <div className={`pf-account__identity ${CAD_CONTENT_MASK_CLASS}`}>
            <strong>{label}</strong>
            {user.primaryEmail ? <small>{user.primaryEmail}</small> : null}
          </div>
          <Link
            className="pf-account__item"
            to={PLATFORM_PATHS.account}
            onClick={() => {
              track({ name: 'account.settings_opened' })
              close()
            }}
          >
            Account settings
          </Link>
          <Link className="pf-account__item" to={PLATFORM_PATHS.projects} onClick={close}>
            Your cloud projects
          </Link>
          <button
            type="button"
            className="pf-account__item pf-account__item--danger"
            onClick={() => {
              close()
              void signOut()
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}

function AccountControl() {
  const session = useAccountSession()
  switch (session.status) {
    case 'signed-out':
      return <SignedOutAccount expired={false} />
    case 'expired':
      return <SignedOutAccount expired />
    case 'restricted':
      return <SignedInAccount user={session.user} restricted />
    case 'signed-in':
      return <SignedInAccount user={session.user} restricted={false} />
  }
}

/**
 * The account control, safe to mount anywhere in the frame.
 *
 * When there is no Hexclave project it renders the same local-only affordance
 * rather than disappearing: an operator should be able to tell "this build has
 * no accounts" apart from "I am signed out", and a control that vanishes tells
 * them neither.
 */
export function AccountMenu() {
  const availability = useAccountAvailability()
  if (availability.status === 'unavailable') {
    return <LocalOnlyBadge label="Local only" hint="This build has no account layer configured" />
  }
  return <AccountControl />
}
