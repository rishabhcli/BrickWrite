import type { ComponentType, ReactNode } from 'react'
import type { RouteId } from './contracts'
import './platform.css'

/**
 * Every state the shell can be in, rendered honestly.
 *
 * Brickwright's rule is that a missing capability reports itself rather than
 * being papered over, and that rule only holds if the reports are real UI:
 * labelled, announced to assistive technology, and carrying an action when one
 * exists. So there is one panel primitive here and a named state per situation,
 * rather than a spinner and a `console.warn`.
 */

export type StateTone = 'working' | 'notice' | 'warning' | 'error'

const TONE_ROLE: Record<StateTone, 'status' | 'alert'> = {
  working: 'status',
  notice: 'status',
  warning: 'status',
  error: 'alert',
}

export interface StatePanelProps {
  tone: StateTone
  /** Small caps line above the heading. Also the accessible group label. */
  eyebrow: string
  heading: string
  children?: ReactNode
  /** Verbatim diagnostic text, shown in a monospace block when present. */
  detail?: string
  actions?: ReactNode
}

/**
 * The one shape every platform state takes.
 *
 * `role="alert"` only for genuine errors: a loading screen that interrupts a
 * screen reader on every navigation is worse than one that does not.
 */
export function StatePanel({ tone, eyebrow, heading, children, detail, actions }: StatePanelProps) {
  const headingId = `pf-state-${eyebrow.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section
      className={`pf-state pf-state--${tone}`}
      role={TONE_ROLE[tone]}
      aria-labelledby={headingId}
      aria-busy={tone === 'working' ? true : undefined}
    >
      <div className="pf-state__inner">
        <span className="eyebrow">{eyebrow}</span>
        <h1 id={headingId}>{heading}</h1>
        {children === undefined ? null : <div className="pf-state__body">{children}</div>}
        {detail === undefined ? null : <pre className="pf-state__detail">{detail}</pre>}
        {actions === undefined ? null : <div className="pf-state__actions">{actions}</div>}
      </div>
    </section>
  )
}

/** The animated mark reused from the original boot screen, for continuity. */
export function PlatformMark() {
  return (
    <div className="pf-mark" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  )
}

export interface LoadingStateProps {
  headline: string
  detail?: string
}

export function LoadingState({ headline, detail }: LoadingStateProps) {
  return (
    <section className="pf-state pf-state--working" role="status" aria-busy="true" aria-live="polite">
      <div className="pf-state__inner">
        <PlatformMark />
        <span className="eyebrow">BRICKWRIGHT</span>
        <h1>{headline}</h1>
        {detail === undefined ? null : <p className="pf-state__lede">{detail}</p>}
      </div>
    </section>
  )
}

export interface BootFailureStateProps {
  level: 'catalog' | 'editor'
  message: string
  onRetry: () => void
}

/**
 * A boot that could not complete.
 *
 * Kept in the register of the original catalog-unavailable screen, because the
 * reason has not changed: the editor deliberately has no stand-in parts, so a
 * missing catalog is a hard stop rather than a degraded start.
 */
export function BootFailureState({ level, message, onRetry }: BootFailureStateProps) {
  return (
    <StatePanel
      tone="error"
      eyebrow={level === 'catalog' ? 'CATALOG UNAVAILABLE' : 'CAD KERNEL UNAVAILABLE'}
      heading="This surface cannot start without its compiled catalog"
      detail={message}
      actions={
        <button type="button" className="pf-button pf-button--primary" onClick={onRetry}>
          Try again
        </button>
      }
    >
      <p>
        Brickwright deliberately has no stand-in parts. Every placeable element must come from
        compiled LDraw geometry with LDCad connection metadata, so a missing catalog is a hard stop
        rather than a silent substitution.
      </p>
    </StatePanel>
  )
}

export interface ShellErrorStateProps {
  message: string
  onRecover: () => void
  onReload: () => void
}

/** The error boundary's rendering. Both actions do something real. */
export function ShellErrorState({ message, onRecover, onReload }: ShellErrorStateProps) {
  return (
    <StatePanel
      tone="error"
      eyebrow="SURFACE FAILED"
      heading="Something in this surface stopped working"
      detail={message}
      actions={
        <>
          <button type="button" className="pf-button pf-button--primary" onClick={onRecover}>
            Reset this surface
          </button>
          <button type="button" className="pf-button" onClick={onReload}>
            Reload Brickwright
          </button>
        </>
      }
    >
      <p>
        Resetting discards the failed surface and its cached boot stage, then mounts it again. Your
        saved document is untouched — it lives in the session store, not in this screen.
      </p>
    </StatePanel>
  )
}

/**
 * A route id nothing has registered a surface for.
 *
 * This is the single deliberate placeholder in the platform layer. It is honest
 * about what it is: the route exists in the shell's table, and the build simply
 * does not contain the surface. It is not a mock of the missing feature.
 */
export function NotInstalledSurface({ route }: { route: RouteId }) {
  return (
    <StatePanel
      tone="notice"
      eyebrow="SURFACE NOT INSTALLED"
      heading={`The "${route}" surface is not installed in this build`}
      actions={
        <a className="pf-button pf-button--primary" href="/">
          Back to the start
        </a>
      }
    >
      <p>
        The application shell knows this route, but no module has registered a surface for it. That
        is a build composition fact, not an error: Brickwright ships its surfaces independently, and
        this one is absent here.
      </p>
      <p className="pf-state__hint">
        To install it, call <code>registerRoute('{route}', () =&gt; import(…))</code> before the
        shell mounts.
      </p>
    </StatePanel>
  )
}

/** Wrap the placeholder as a zero-prop surface the route table can load. */
export function createNotInstalledSurface(route: RouteId): ComponentType {
  function NotInstalledRoute() {
    return <NotInstalledSurface route={route} />
  }
  NotInstalledRoute.displayName = `NotInstalledSurface(${route})`
  return NotInstalledRoute
}

export interface MisconfiguredStateProps {
  reason: string
  checked: readonly string[]
}

/**
 * The account layer has no project ID.
 *
 * Deliberately a notice, not an error: local CAD work is entirely unaffected,
 * and treating an unconfigured account layer as a failure would be a lie about
 * what the operator can still do.
 */
export function MisconfiguredState({ reason, checked }: MisconfiguredStateProps) {
  return (
    <StatePanel tone="warning" eyebrow="ACCOUNTS UNAVAILABLE" heading="Brickwright has no Hexclave project configured">
      <p>{reason}</p>
      <p className="pf-state__hint">
        Checked, in order: <code>{checked.join('</code>, <code>')}</code>
      </p>
    </StatePanel>
  )
}

/**
 * The browser reports it is offline.
 *
 * A banner rather than a takeover: an offline browser can still edit a document
 * that has already booted, and blocking the editor would be a worse lie than
 * saying nothing.
 */
export function OfflineNotice() {
  return (
    <div className="pf-offline" role="status" aria-live="polite">
      <span className="pf-offline__dot" aria-hidden="true" />
      <span>
        <strong>Offline.</strong> Local editing continues. Cloud saving, publishing and sign-in
        resume when the connection returns.
      </span>
    </div>
  )
}
