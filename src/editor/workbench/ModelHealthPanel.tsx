import {
  AlertTriangle,
  Check,
  CircleAlert,
  Crosshair,
  Eye,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { inspectModelHealth, type ModelHealthIssue, type ModelHealthSeverity } from '../../cad/modelHealth'
import type { EngineSnapshot } from '../../cad/types'

type HealthFilter = 'all' | ModelHealthSeverity
type HealthFocusMode = 'select' | 'frame' | 'isolate'

export interface ModelHealthPanelProps {
  state: EngineSnapshot
  activeIssueId?: string | null
  onActiveIssue?: (issueId: string) => void
  onFocusIssue: (issue: ModelHealthIssue, mode: HealthFocusMode) => void
}

const severityLabel = (severity: ModelHealthSeverity) =>
  severity === 'blocker' ? 'BLOCKER' : severity === 'warning' ? 'WATCH' : 'NOTICE'

function HealthIssueCard({
  issue,
  active,
  onOpen,
  onFocus,
}: {
  issue: ModelHealthIssue
  active: boolean
  onOpen: () => void
  onFocus: (mode: HealthFocusMode) => void
}) {
  const navigable = issue.partIds.length > 0
  return (
    <article
      className={`health-issue ${issue.severity} ${active ? 'active' : ''}`}
      data-health-issue={issue.id}
    >
      <button type="button" className="health-issue-main" aria-expanded={active} onClick={onOpen}>
        <span className="health-severity-mark">
          {issue.severity === 'blocker' ? <CircleAlert size={13} /> : issue.severity === 'warning' ? <AlertTriangle size={13} /> : <ScanSearch size={13} />}
        </span>
        <span>
          <small>{severityLabel(issue.severity)} · {issue.kind.replace('-', ' ')}</small>
          <strong>{issue.title}</strong>
          <em>{issue.evidence}</em>
        </span>
        <i>{issue.partIds.length || '—'}</i>
      </button>
      {active && (
        <div className="health-issue-detail">
          <p>{issue.detail}</p>
          <div className="health-repair">
            <span>REPAIR PATH</span>
            <strong>{issue.repair}</strong>
          </div>
          <footer>
            <span>{navigable ? `${issue.partIds.length} exact part${issue.partIds.length === 1 ? '' : 's'}` : 'whole-model evidence'}</span>
            <div>
              <button type="button" disabled={!navigable} onClick={() => onFocus('select')}>
                <Eye size={10} /> SELECT
              </button>
              <button type="button" disabled={!navigable} onClick={() => onFocus('frame')}>
                <Crosshair size={10} /> FRAME
              </button>
              <button type="button" disabled={!navigable} onClick={() => onFocus('isolate')}>
                ISOLATE
              </button>
            </div>
          </footer>
        </div>
      )}
    </article>
  )
}

/**
 * One deterministic health navigator shared by the inspector and WebMCP.
 * Clicking an issue changes selection/visibility only; every repair still goes
 * through the normal command bus and is revalidated by CadEngine.
 */
export function ModelHealthPanel({
  state,
  activeIssueId,
  onActiveIssue,
  onFocusIssue,
}: ModelHealthPanelProps) {
  const [filter, setFilter] = useState<HealthFilter>('all')
  const health = useMemo(
    () => inspectModelHealth(state.document, state.validation),
    [state.document, state.validation],
  )
  const visible = health.issues.filter((issue) => filter === 'all' || issue.severity === filter)
  const active = health.issues.find((issue) => issue.id === activeIssueId) ?? visible[0] ?? health.issues[0] ?? null

  return (
    <aside className="model-health" aria-label="Model health navigator">
      <header className={`health-hero ${health.ready ? 'ready' : 'blocked'}`}>
        <div className="health-radar" aria-hidden="true">
          <span /><span /><span />
          {health.ready ? <ShieldCheck size={23} /> : <CircleAlert size={23} />}
        </div>
        <div>
          <span className="eyebrow">KERNEL + STATIC ANALYSIS · R{health.revision}</span>
          <h3>{health.ready ? 'Build clears blockers' : `${health.blockers} blocker${health.blockers === 1 ? '' : 's'} found`}</h3>
          <p>{health.issues.length ? `${health.warnings} watch · ${health.notices} notice` : 'No issues in the measured checks.'}</p>
        </div>
      </header>

      <div className="health-metrics" aria-label="Model health totals">
        <div><span>BLOCK</span><strong>{String(health.blockers).padStart(2, '0')}</strong></div>
        <div><span>WATCH</span><strong>{String(health.warnings).padStart(2, '0')}</strong></div>
        <div><span>PARTS</span><strong>{health.metrics.parts.toLocaleString()}</strong></div>
        <div><span>MASS</span><strong>{health.metrics.massGrams >= 1000 ? `${(health.metrics.massGrams / 1000).toFixed(1)}k` : Math.round(health.metrics.massGrams)}</strong><em>g</em></div>
      </div>

      <div className="health-filters" role="tablist" aria-label="Health issue severity">
        {([
          ['all', 'ALL', health.issues.length],
          ['blocker', 'BLOCK', health.blockers],
          ['warning', 'WATCH', health.warnings],
          ['notice', 'NOTICE', health.notices],
        ] as const).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? 'active' : ''}
            onClick={() => setFilter(id)}
          >
            {label} <em>{count}</em>
          </button>
        ))}
      </div>

      <section className="health-issues" aria-label="Navigable model issues">
        {visible.length === 0 && (
          <div className="health-clear">
            <Check size={18} />
            <strong>{filter === 'all' ? 'No model issues found' : `No ${filter} issues`}</strong>
            <span>The current revision clears this evidence lane.</span>
          </div>
        )}
        {visible.map((issue) => (
          <HealthIssueCard
            key={issue.id}
            issue={issue}
            active={active?.id === issue.id}
            onOpen={() => onActiveIssue?.(issue.id)}
            onFocus={(mode) => {
              onActiveIssue?.(issue.id)
              onFocusIssue(issue, mode)
            }}
          />
        ))}
      </section>

      <section className="health-checks" aria-label="Health check ledger">
        <header><span>CHECK LEDGER</span><em>{health.checks.length} deterministic</em></header>
        {health.checks.map((check) => (
          <div key={check.id} className={check.status}>
            <span>{check.status === 'pass' ? <Check size={10} /> : <CircleAlert size={10} />}</span>
            <strong>{check.label}</strong>
            <em>{check.value}</em>
          </div>
        ))}
      </section>
    </aside>
  )
}
