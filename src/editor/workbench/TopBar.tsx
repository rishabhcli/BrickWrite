import { Save } from 'lucide-react'
import { Link } from 'react-router-dom'
import { cadEngine } from '../../cad/engine'
import { PRIMARY_NAV, routeById } from '../../platform/routes'
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
  return (
    <header className="topbar">
      <Link className="brand-lockup" to="/" aria-label="Brickwright home">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div><strong>BRICK<span>WRIGHT</span></strong><small>PHYSICAL CAD / 01</small></div>
      </Link>
      <nav className="topbar-nav" aria-label="Application">
        {PRIMARY_NAV.filter((entry) => entry.id !== 'editor').map((entry) => (
          <Link key={entry.id} to={routeById(entry.id).path}>
            {entry.label}
          </Link>
        ))}
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
    </header>
  )
}
