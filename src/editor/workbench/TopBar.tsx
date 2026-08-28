import { Save } from 'lucide-react'
import { catalog } from '../../cad/catalog'
import { cadEngine } from '../../cad/engine'
import { ProjectMenu } from '../ProjectMenu'
import { AutonomySwitch } from './AutonomySwitch'
import type { Workbench } from './useWorkbench'

/**
 * Identity, persistence and agent reach.
 *
 * The three facts an operator needs before touching anything: which document is
 * open, whether their work is actually being saved, and how much the agent is
 * currently allowed to do.
 */
export function TopBar({ workbench }: { workbench: Workbench }) {
  const { state, sessionStatus, toolStatus } = workbench
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <div><strong>BRICK<span>WRIGHT</span></strong><small>PHYSICAL CAD / 01</small></div>
      </div>
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
        <div className={`codex-state ${toolStatus.native ? 'connected' : 'ready'}`}>
          <span className="pulse-ring"><i /></span>
          <div>
            <strong>{toolStatus.native ? 'Codex connected' : 'Site tools ready'}</strong>
            <small>{toolStatus.toolCount} tools · {state.autonomy} access · catalog {catalog.version}</small>
          </div>
        </div>
        <AutonomySwitch value={state.autonomy} onChange={(mode) => cadEngine.setAutonomy(mode)} />
      </div>
    </header>
  )
}
