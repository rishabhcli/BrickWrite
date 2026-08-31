import { Menu as MenuIcon, Save } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { cadEngine } from '../../cad/engine'
import { PRIMARY_NAV, routeById } from '../../platform/routes'
import { GlassBar, GlassIsland } from '../../ui/liquid'
import { ProjectMenu } from '../ProjectMenu'
import { AutonomySwitch } from './AutonomySwitch'
import type { Workbench } from './useWorkbench'

/**
 * Identity, persistence and agent reach.
 *
 * Which document is open, whether work is actually being saved, and how much
 * the agent is currently allowed to do.
 */
export function TopBar({ workbench }: { workbench: Workbench }) {
  const { state, sessionStatus } = workbench
  const [navigationOpen, setNavigationOpen] = useState(false)
  const navigationRoot = useRef<HTMLElement>(null)
  const navigationTrigger = useRef<HTMLButtonElement>(null)
  const closeNavigation = useCallback((restoreFocus = false) => {
    setNavigationOpen(false)
    if (restoreFocus) navigationTrigger.current?.focus()
  }, [])

  useEffect(() => {
    if (!navigationOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!navigationRoot.current?.contains(event.target as Node)) closeNavigation()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeNavigation(true)
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', escape)
    }
  }, [closeNavigation, navigationOpen])

  return (
    <GlassBar as="header" className="topbar" aria-label="Project controls">
      <Link className="brand-lockup" to="/" aria-label="Brickwright home">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>
            BRICK<span>WRIGHT</span>
          </strong>
        </div>
      </Link>
      <nav className="topbar-nav" aria-label="Application" ref={navigationRoot}>
        <button
          ref={navigationTrigger}
          type="button"
          className="topbar-nav-trigger"
          aria-haspopup="menu"
          aria-label="Navigate"
          title="Navigate"
          aria-expanded={navigationOpen}
          aria-controls="workbench-navigation-menu"
          onClick={() => setNavigationOpen((open) => !open)}
        >
          <MenuIcon size={14} />
        </button>
        {navigationOpen && (
          <GlassIsland id="workbench-navigation-menu" className="topbar-nav-menu" role="menu">
            <span>Go to</span>
            {PRIMARY_NAV.filter((entry) => entry.id !== 'editor').map((entry) => (
              <Link key={entry.id} to={routeById(entry.id).path} role="menuitem" onClick={() => closeNavigation()}>
                {entry.label}
              </Link>
            ))}
          </GlassIsland>
        )}
      </nav>
      <ProjectMenu
        documentName={state.document.name}
        documentId={state.document.id}
        revision={state.document.revision}
        sessionStatus={sessionStatus}
        onNotice={workbench.notify}
      />
      <div className="topbar-status">
        {/* The indicator reports what persistence actually achieved: a durable
            store, a fallback, or an outright failure. */}
        <div
          className={`save-state ${sessionStatus.error ? 'failing' : sessionStatus.durable ? '' : 'volatile'}`}
          title={
            sessionStatus.error
              ? `Autosave failed: ${sessionStatus.error}`
              : sessionStatus.durable
                ? `Every transaction is appended to IndexedDB${sessionStatus.restore?.replayedTransactions ? ` · ${sessionStatus.restore.replayedTransactions} replayed on open` : ''}`
                : 'IndexedDB is unavailable in this context; work is kept in memory only'
          }
        >
          <Save size={13} />
          <span>{sessionStatus.error ? 'Not saved' : sessionStatus.durable ? 'Saved' : 'In memory'}</span>
          <em>r{state.document.revision}</em>
        </div>
        <AutonomySwitch
          value={state.autonomy}
          agentConnected={workbench.toolStatus.native}
          onChange={(mode) => cadEngine.setAutonomy(mode)}
        />
      </div>
    </GlassBar>
  )
}
