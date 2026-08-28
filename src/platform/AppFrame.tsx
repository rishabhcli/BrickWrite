import { Suspense, type ReactNode } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { PRIMARY_NAV, isRouteRegistered, routeById } from './routes'
import { useOnlineStatus } from './connectivity'
import { OfflineNotice } from './states'
import { AccountMenu } from './auth/AccountMenu'
import './platform.css'

/**
 * The persistent application frame.
 *
 * Thin on purpose. Brickwright's centre of gravity is the editor, and the
 * editor does not get this frame at all — it is a full-bleed cockpit with its
 * own chrome, and a second bar above it would steal vertical space and repeat
 * the project identity it already shows. Everywhere else, this is how an
 * operator knows where they are and gets back to work.
 */

function BrandMark() {
  return (
    <span className="pf-brand__mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

/**
 * The account control suspends while Hexclave resolves the session.
 *
 * Given its own boundary so that resolution never blanks the navigation: the
 * frame is how someone leaves a slow screen, and it must not be the slow screen.
 */
function AccountSlot() {
  return (
    <Suspense
      fallback={
        <span className="pf-account pf-account--pending" role="status" aria-label="Checking your account">
          <span className="pf-account__dot pf-account__dot--pending" aria-hidden="true" />
          <span className="pf-account__lines">
            <strong>Checking…</strong>
          </span>
        </span>
      }
    >
      <AccountMenu />
    </Suspense>
  )
}

export function AppFrame({ children }: { children: ReactNode }) {
  const online = useOnlineStatus()
  return (
    <div className="pf-frame">
      <a className="pf-skip" href="#pf-main">
        Skip to content
      </a>
      <header className="pf-topbar">
        <Link className="pf-brand" to="/">
          <BrandMark />
          <span className="pf-brand__words">
            <strong>
              BRICK<span>WRIGHT</span>
            </strong>
            <small>LDRAW CAD</small>
          </span>
        </Link>

        <nav className="pf-nav" aria-label="Primary">
          <ul>
            {PRIMARY_NAV.map((entry) => (
              <li key={entry.id}>
                <NavLink
                  to={routeById(entry.id).path}
                  className={({ isActive }) => (isActive ? 'pf-nav__link pf-nav__link--active' : 'pf-nav__link')}
                >
                  {entry.label}
                  {isRouteRegistered(entry.id) ? null : (
                    <span className="pf-nav__absent" title="Not installed in this build">
                      {' '}
                      ·
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <AccountSlot />
      </header>

      {online ? null : <OfflineNotice />}

      <main className="pf-frame__body" id="pf-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}

/** Layout route: everything except the editor renders inside the frame. */
export function FramedLayout() {
  return (
    <AppFrame>
      <Outlet />
    </AppFrame>
  )
}
