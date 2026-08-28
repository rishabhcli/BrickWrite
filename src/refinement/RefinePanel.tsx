import { useCallback, useSyncExternalStore } from 'react'
import { Ban, Check, CircleAlert, Info, MousePointer2, Play, RotateCcw, SlidersHorizontal, Stethoscope, X } from 'lucide-react'
import type { WorkbenchApi } from '../editor/workbench'
import { MAX_WEIGHT, objectiveList } from './objectives'
import {
  foundNothing,
  metricRows,
  rankedProposals,
  refusedProposals,
  REFINE_EFFORTS,
  selectedProposal,
  type RefineEffortId,
  type RefinementSession,
  type RefineState,
} from './session'
import type { RefinementProposalV1 } from './types'
import './panel.css'

/** The modal contribution id the panel opens for the objective reference. */
export const OBJECTIVES_MODAL_ID = 'refinement.objectives'

/** Subscribes a component to one session. */
export function useRefineState(session: RefinementSession): RefineState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState)
}

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return String(value)
  const abs = Math.abs(value)
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 10) return value.toFixed(1)
  if (abs >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

const formatDelta = (value: number): string =>
  value > 0 ? `+${formatNumber(value)}` : value === 0 ? '0' : formatNumber(value)

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * The design doctor.
 *
 * The panel is a request builder, a progress surface and a review surface, in
 * that order, and every one of its states is drawn: an empty selection explains
 * what a region is, a running search shows the wall clock it is spending, a
 * finished search that found nothing says so, and a proposal the operator
 * accepts either commits or reports exactly why the kernel refused it.
 */
export function RefinePanel({ api, session }: { api: WorkbenchApi; session: RefinementSession }) {
  const state = useRefineState(session)
  const document = api.snapshot.document
  const selection = api.selection
  const partIds = Object.keys(document.parts)
  const running = state.status === 'running'

  const start = useCallback(() => {
    void session.run(document, selection)
  }, [session, document, selection])

  if (!selection.length && !running && !state.proposals.length) {
    return (
      <section className="bw-refine" aria-label="Refine">
        <EmptyScope api={api} partIds={partIds} outcome={state.outcome} onDismiss={() => session.clearOutcome()} />
      </section>
    )
  }

  const ranked = rankedProposals(state)
  const refusals = refusedProposals(state)
  const selected = selectedProposal(state)
  const nothing = foundNothing(state)

  return (
    <section className="bw-refine" aria-label="Refine">
      <div className="bw-refine__scope">
        <div>
          <strong className="bw-refine__num">{selection.length}</strong>{' '}
          <span>{selection.length === 1 ? 'part in scope' : 'parts in scope'}</span>
        </div>
        <span className="bw-refine__num">r{document.revision}</span>
      </div>

      <div className="bw-refine__form">
        <label className="bw-refine__field">
          <span>What should change</span>
          <textarea
            rows={2}
            value={state.instruction}
            placeholder="Break the stacked seams in this wall without moving the outline."
            onChange={(event) => session.setInstruction(event.target.value)}
            disabled={running}
          />
        </label>
        <p className="bw-refine__hint">
          Left blank, the goal is derived from what the analysis finds wrong in the region.
        </p>

        <label className="bw-refine__field">
          <span>Effort</span>
          <select
            value={state.effort}
            onChange={(event) => session.setEffort(event.target.value as RefineEffortId)}
            disabled={running}
          >
            {REFINE_EFFORTS.map((effort) => (
              <option key={effort.id} value={effort.id}>
                {effort.label} — {effort.maxIterations} candidates, {formatSeconds(effort.wallClockMs)} budget
              </option>
            ))}
          </select>
        </label>

        <details className="bw-refine__objectives">
          <summary>
            <SlidersHorizontal size={11} aria-hidden="true" />
            Objective weights ({Object.keys(state.weightOverrides).length} set by hand)
          </summary>
          <div className="bw-refine__weights">
            <p className="bw-refine__hint">
              An unset objective follows the goal the instruction and the analysis imply. Moving one pins it.
            </p>
            {objectiveList.map((objective) => {
              const overridden = objective.id in state.weightOverrides
              return (
                <div className="bw-refine__weight" key={objective.id} data-overridden={overridden}>
                  <span id={`bw-refine-w-${objective.id}`}>{objective.label}</span>
                  <span className="bw-refine__weight-value">{session.weightOf(objective.id).toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={MAX_WEIGHT}
                    step={0.25}
                    value={session.weightOf(objective.id)}
                    aria-label={`${objective.label} weight`}
                    aria-labelledby={`bw-refine-w-${objective.id}`}
                    aria-describedby={`bw-refine-u-${objective.id}`}
                    onChange={(event) => session.setWeight(objective.id, Number(event.target.value))}
                    disabled={running}
                  />
                  <span className="bw-refine__weight-unit" id={`bw-refine-u-${objective.id}`}>
                    {objective.unit} · {objective.direction === 'higher-is-better' ? 'higher is better' : 'lower is better'}
                  </span>
                </div>
              )
            })}
            <div className="bw-refine__actions">
              <button className="bw-refine__btn" onClick={() => session.resetWeights()} disabled={running}>
                <RotateCcw size={11} aria-hidden="true" /> Reset weights
              </button>
              <button className="bw-refine__btn" onClick={() => api.openModal(OBJECTIVES_MODAL_ID)}>
                <Info size={11} aria-hidden="true" /> Reference
              </button>
            </div>
          </div>
        </details>

        <div className="bw-refine__actions">
          {running ? (
            <button className="bw-refine__btn bw-refine__btn--danger" onClick={() => session.cancel()}>
              <Ban size={11} aria-hidden="true" /> Cancel search
            </button>
          ) : (
            <button
              className="bw-refine__btn bw-refine__btn--primary"
              onClick={start}
              disabled={!selection.length}
            >
              <Play size={11} aria-hidden="true" /> Find refinements
            </button>
          )}
        </div>
      </div>

      {running && <Progress state={state} offMainThread={session.offMainThread} />}

      {state.outcome && (
        <Notice
          tone={state.outcome.kind}
          title={state.outcome.title}
          detail={state.outcome.detail}
          repair={state.outcome.repair}
          code={state.outcome.code}
          alert={state.outcome.kind === 'refused' || state.outcome.kind === 'stale'}
          action={
            state.outcome.kind === 'stale'
              ? { label: `Search again at r${document.revision}`, run: start }
              : null
          }
          onDismiss={() => session.clearOutcome()}
        />
      )}

      {state.status === 'error' && state.error && (
        <Notice
          tone="error"
          title="The search failed"
          detail={state.error}
          repair="The document was not touched. Adjust the scope or effort and try again."
          code={null}
          alert
          action={{ label: 'Try again', run: start }}
          onDismiss={null}
        />
      )}

      {state.status === 'cancelled' && (
        <Notice
          tone="cancelled"
          title="Search cancelled"
          detail={
            state.proposals.length
              ? `Stopped after ${formatSeconds(state.elapsedMs)}. The proposals below are what had been found and verified when you stopped it; nothing was written.`
              : `Stopped after ${formatSeconds(state.elapsedMs)} before anything was verified. The document is unchanged.`
          }
          repair={null}
          code={null}
          alert={false}
          action={{ label: 'Search again', run: start }}
          onDismiss={null}
        />
      )}

      {state.report?.budgetExhausted && state.status === 'ready' && (
        <Notice
          tone="budget"
          title="Budget expired"
          detail={`The ${formatSeconds(state.budgetMs)} budget ran out after ${state.report.evaluated} candidates were evaluated. These are the proposals verified before the clock stopped — not the whole search.`}
          repair="Raise Effort to search longer."
          code={null}
          alert={false}
          action={null}
          onDismiss={null}
        />
      )}

      {nothing && (
        <Notice
          tone="empty"
          title="No proposal improved this region"
          detail={`${state.report?.generated ?? 0} candidate${state.report?.generated === 1 ? '' : 's'} were generated and ${state.report?.evaluated ?? 0} were measured. None of them beat the region as it stands under the current weights.`}
          repair="Widen the selection, say what you want changed, or raise the weight on the axis you care about."
          code={null}
          alert={false}
          action={null}
          onDismiss={null}
        />
      )}

      {ranked.length > 0 && (
        <div className="bw-refine__results">
          <h3>
            {ranked.length} proposal{ranked.length === 1 ? '' : 's'}
            {state.status === 'cancelled' ? ' (partial)' : ''}
          </h3>
          <ul className="bw-refine__list">
            {ranked.map((proposal, index) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                rank={index + 1}
                selected={proposal.id === state.selectedId}
                onSelect={() => {
                  session.select(proposal.id)
                  api.select(proposal.changedPartIds)
                }}
                onAccept={() => {
                  const outcome = session.accept(proposal.id)
                  api.notify({
                    kind: outcome.kind === 'applied' ? 'success' : 'error',
                    title: outcome.title,
                    detail: outcome.detail,
                  })
                }}
                onReject={() => session.reject(proposal.id)}
              />
            ))}
          </ul>
        </div>
      )}

      {selected && selected.status === 'ranked' && <MetricTable proposal={selected} />}

      {refusals.length > 0 && (
        <div className="bw-refine__refusals">
          <h3>Refused by the guards ({refusals.length})</h3>
          {refusals.map((proposal) => (
            <div className="bw-refine__refusal" key={proposal.id}>
              <code>{proposal.rejection?.code ?? 'REJECTED'}</code>
              <p>{proposal.rejection?.reason ?? proposal.label}</p>
            </div>
          ))}
        </div>
      )}

      {state.report && (
        <div className="bw-refine__report">
          <span>
            Generated <b className="bw-refine__num">{state.report.generated}</b>
          </span>
          <span>
            Evaluated <b className="bw-refine__num">{state.report.evaluated}</b>
          </span>
          <span>
            Elapsed <b className="bw-refine__num">{formatSeconds(state.report.elapsedMs)}</b>
          </span>
          <span>
            Ran on <b>{state.ranOn === 'worker' ? 'worker thread' : 'main thread'}</b>
          </span>
          <span>
            Strategies <b className="bw-refine__num">{state.report.strategiesRun.length}</b>
          </span>
          <span>
            Skipped <b className="bw-refine__num">{state.report.strategiesSkipped.length}</b>
          </span>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function EmptyScope({
  api,
  partIds,
  outcome,
  onDismiss,
}: {
  api: WorkbenchApi
  partIds: string[]
  outcome: RefineState['outcome']
  onDismiss: () => void
}) {
  return (
    <>
      {outcome && (
        <Notice
          tone={outcome.kind}
          title={outcome.title}
          detail={outcome.detail}
          repair={outcome.repair}
          code={outcome.code}
          alert={outcome.kind === 'refused' || outcome.kind === 'stale'}
          action={null}
          onDismiss={onDismiss}
        />
      )}
      <div className="bw-refine__empty">
        <div className="bw-refine__empty-title">
          <Stethoscope size={14} aria-hidden="true" /> Pick a region to refine
        </div>
        <p>
          Refine reworks a region you name and reports what the rework cost. It measures {objectiveList.length}{' '}
          objectives before and after — seam bonding, tipping margin, rarity, bare studs and the rest — and every
          proposal shows all of them, including the ones it made worse.
        </p>
        <ul>
          <li>A wall whose joints line up through two courses.</li>
          <li>A roof that has to keep its outline but lose a third of its parts.</li>
          <li>One subassembly you want mirrored properly.</li>
        </ul>
        <p className="bw-refine__hint">
          Click parts in the viewport, shift-drag a marquee, or use Select → Connected. Nothing is written until you
          accept a proposal.
        </p>
        <div className="bw-refine__empty-actions">
          <button
            className="bw-refine__btn"
            onClick={() => api.select(partIds)}
            disabled={!partIds.length}
          >
            <MousePointer2 size={11} aria-hidden="true" /> Select all {partIds.length} parts
          </button>
          <button className="bw-refine__btn" onClick={() => api.openModal(OBJECTIVES_MODAL_ID)}>
            <Info size={11} aria-hidden="true" /> What is measured
          </button>
        </div>
        {!partIds.length && (
          <p className="bw-refine__hint">This document has no parts yet — place a brick before refining it.</p>
        )}
      </div>
    </>
  )
}

function Progress({ state, offMainThread }: { state: RefineState; offMainThread: boolean }) {
  const pct = Math.max(0, Math.min(100, (state.elapsedMs / Math.max(1, state.budgetMs)) * 100))
  return (
    <div className="bw-refine__progress">
      <div className="bw-refine__progress-head">
        <strong>
          <span className="bw-refine__spinner" aria-hidden="true" /> Searching
        </strong>
        <span className="bw-refine__num">
          {formatSeconds(state.elapsedMs)} / {formatSeconds(state.budgetMs)}
        </span>
      </div>
      <div
        className="bw-refine__bar"
        role="progressbar"
        aria-label="Refinement search budget used"
        aria-valuemin={0}
        aria-valuemax={state.budgetMs}
        aria-valuenow={Math.round(state.elapsedMs)}
        aria-valuetext={`${formatSeconds(state.elapsedMs)} of the ${formatSeconds(state.budgetMs)} budget used`}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <p className="bw-refine__hint" role="status">
        {offMainThread
          ? 'Running on a worker thread — the viewport stays interactive.'
          : 'Running on the main thread: this browser exposes no Worker, so the viewport will not respond until it finishes.'}{' '}
        {state.scopePartIds.length} parts, revision {state.baseRevision}.
      </p>
    </div>
  )
}

function Notice({
  tone,
  title,
  detail,
  repair,
  code,
  alert,
  action,
  onDismiss,
}: {
  tone: string
  title: string
  detail: string
  repair: string | null
  code: string | null
  alert: boolean
  action: { label: string; run: () => void } | null
  onDismiss: (() => void) | null
}) {
  return (
    <div className="bw-refine__notice" data-tone={tone} role={alert ? 'alert' : 'status'}>
      <strong>
        {alert && <CircleAlert size={11} aria-hidden="true" />} {title}
        {code ? ` · ${code}` : ''}
      </strong>
      <p>{detail}</p>
      {repair && <p className="bw-refine__notice-repair">{repair}</p>}
      {(action || onDismiss) && (
        <div className="bw-refine__actions">
          {action && (
            <button className="bw-refine__btn" onClick={action.run}>
              {action.label}
            </button>
          )}
          {onDismiss && (
            <button className="bw-refine__btn" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ProposalCard({
  proposal,
  rank,
  selected,
  onSelect,
  onAccept,
  onReject,
}: {
  proposal: RefinementProposalV1
  rank: number
  selected: boolean
  onSelect: () => void
  onAccept: () => void
  onReject: () => void
}) {
  const rows = metricRows(proposal)
  const improved = rows.filter((row) => row.direction === 'improved')
  const regressed = rows.filter((row) => row.direction === 'regressed')
  return (
    <li className="bw-refine__card" data-selected={selected}>
      <button
        className="bw-refine__pick"
        onClick={onSelect}
        aria-pressed={selected}
        // Several strategies legitimately produce proposals with the same
        // label, so the rank is part of the name. Six identical "Re-lay course"
        // buttons is a list a screen reader cannot navigate.
        aria-label={`Proposal ${rank}: ${proposal.label}, ${proposal.strategy}, score ${proposal.score.toFixed(2)}`}
      >
        <span className="bw-refine__rank" aria-hidden="true">
          {rank}
        </span>
        <strong>{proposal.label}</strong>
        <span className="bw-refine__score" title="Weighted improvement, higher is better">
          {proposal.score.toFixed(2)}
        </span>
        <span className="bw-refine__strategy">
          {proposal.strategy} · {proposal.changedPartIds.length} parts · {proposal.operations.length} operations
        </span>
        <span className="bw-refine__chips">
          {improved.map((row) => (
            <span className="bw-refine__chip" data-tone="improved" key={row.id}>
              {row.label} {formatDelta(row.delta)}
            </span>
          ))}
          {regressed.map((row) => (
            <span className="bw-refine__chip" data-tone="regressed" key={row.id}>
              Cost: {row.label} {formatDelta(row.delta)}
            </span>
          ))}
          {!improved.length && !regressed.length && (
            <span className="bw-refine__chip">No measured axis moved</span>
          )}
        </span>
      </button>
      {proposal.warnings.map((warning) => (
        <p className="bw-refine__strategy" key={warning} style={{ padding: '0 8px 4px' }}>
          {warning}
        </p>
      ))}
      <div className="bw-refine__card-actions">
        <button
          className="bw-refine__btn bw-refine__btn--primary"
          onClick={onAccept}
          aria-label={`Accept proposal ${rank}: ${proposal.label}`}
        >
          <Check size={11} aria-hidden="true" /> Accept
        </button>
        <button
          className="bw-refine__btn bw-refine__btn--danger"
          onClick={onReject}
          aria-label={`Reject proposal ${rank}: ${proposal.label}`}
        >
          <X size={11} aria-hidden="true" /> Reject
        </button>
      </div>
    </li>
  )
}

/**
 * The whole metric vector for the proposal under review.
 *
 * All thirteen rows, always, including the ones that did not move. A table that
 * only listed what changed would let a proposal look free.
 */
function MetricTable({ proposal }: { proposal: RefinementProposalV1 }) {
  const rows = metricRows(proposal)
  return (
    <table className="bw-refine__metrics">
      <caption>Full metric vector — {proposal.label}</caption>
      <thead>
        <tr>
          <th scope="col">Objective</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
          <th scope="col">Delta</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-direction={row.direction}>
            <th scope="row" title={`${row.unit} · ${row.direction}`}>
              {row.label}
            </th>
            <td className="bw-refine__num">{formatNumber(row.before)}</td>
            <td className="bw-refine__num">{formatNumber(row.after)}</td>
            <td className="bw-refine__num">
              {formatDelta(row.delta)}
              <span className="visually-hidden"> {row.direction}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
