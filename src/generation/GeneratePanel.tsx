import { useCallback, useSyncExternalStore } from 'react'
import { Ban, Check, CircleAlert, Columns3, Eye, Play, Wand2, X } from 'lucide-react'
import type { WorkbenchApi } from '../editor/workbench'
import { maskedContentProps } from '../platform/analytics'
import { BriefEditor } from './BriefEditor'
import { PHASES, type Candidate } from './phases'
import {
  CANDIDATE_METRICS,
  currentTick,
  HEADLINE_METRIC_KEYS,
  phaseProgress,
  producedNothing,
  selectedCandidate,
  unresolvedConflicts,
  type GenerateState,
  type GenerationSession,
} from './session'
import './panel.css'

/** The modal contribution id the panel opens for the side-by-side comparison. */
export const COMPARE_MODAL_ID = 'generation.compare'

export function useGenerateState(session: GenerationSession): GenerateState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState)
}

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * Prompt to assembly, with every step reviewable.
 *
 * The panel refuses to move forward on anything it had to guess: an unresolved
 * contradiction in the brief blocks generation and says which one, an
 * unreachable route is reported with the server's own words rather than retried
 * behind a spinner, and no candidate reaches the document until it has been
 * previewed as a kernel-verified ghost.
 */
export function GeneratePanel({ api, session }: { api: WorkbenchApi; session: GenerationSession }) {
  const state = useGenerateState(session)
  const document = api.snapshot.document
  const unresolved = unresolvedConflicts(state)
  const candidates = state.run?.candidates ?? []
  const selected = selectedCandidate(state)

  const generate = useCallback(
    (useModel: boolean) => {
      void session.generate(document, { useModel })
    },
    [session, document],
  )

  return (
    <section className="bw-gen" aria-label="Generate">
      <label className="bw-gen__field">
        <span>What should be built</span>
        <textarea
          rows={3}
          value={state.prompt}
          placeholder="A 16 × 10 stud lighthouse in white and red, under 200 parts, with a lamp room that lifts off."
          disabled={state.briefPhase === 'compiling' || state.runPhase === 'running'}
          onChange={(event) => session.setPrompt(event.target.value)}
          {...maskedContentProps('design-prompt')}
        />
      </label>
      <div className="bw-gen__actions">
        <button
          className="bw-gen__btn bw-gen__btn--primary"
          onClick={() => void session.compile()}
          disabled={!state.prompt.trim() || state.briefPhase === 'compiling' || state.runPhase === 'running'}
        >
          <Wand2 size={11} aria-hidden="true" />
          {state.brief ? 'Recompile brief' : 'Compile brief'}
        </button>
      </div>

      {state.briefPhase === 'idle' && !state.brief && (
        <p className="bw-gen__hint">Describe it, then check the brief. Nothing is written until you accept a ghost.</p>
      )}

      {state.briefPhase === 'compiling' && (
        <p className="bw-gen__hint" role="status">
          <span className="bw-gen__spinner" aria-hidden="true" /> Compiling the brief at /api/brief…
        </p>
      )}

      {state.briefIssue && (
        <Notice
          tone={state.briefIssue.kind}
          title={state.briefIssue.title}
          detail={state.briefIssue.detail}
          repair={
            state.briefIssue.kind === 'unavailable'
              ? 'Set the model API key on the generation service, or compile the brief here from rules instead — that path is real but reads only what the words literally say.'
              : 'Nothing was written. Adjust the request and try again.'
          }
          alert={state.briefIssue.kind === 'error'}
          action={
            state.briefIssue.kind === 'unavailable'
              ? { label: 'Compile here from rules', run: () => session.compileLocally() }
              : null
          }
          onDismiss={null}
        />
      )}

      {state.brief && state.briefMethod && (
        <>
          <BriefEditor
            brief={state.brief}
            method={state.briefMethod}
            modelId={state.briefProvenance?.model ?? null}
            notes={state.briefNotes}
            choices={state.conflictChoices}
            disabled={state.runPhase === 'running'}
            onEdit={(patch, reason) => session.editBrief(patch, reason)}
            onResolve={(field, choice) => session.resolveConflict(field, choice)}
          />

          <label className="bw-gen__field">
            <span>Candidates</span>
            <input
              type="number"
              min={1}
              max={6}
              value={state.candidateCount}
              aria-label="How many candidates to generate"
              disabled={state.runPhase === 'running'}
              onChange={(event) => session.setCandidateCount(Number(event.target.value))}
            />
          </label>

          {unresolved.length > 0 && (
            <Notice
              tone="unavailable"
              title={`${unresolved.length} contradiction${unresolved.length === 1 ? '' : 's'} to settle`}
              detail={`Generation waits on ${unresolved.map((conflict) => conflict.field).join(', ')}. The compiler recorded what it did and will not decide for you.`}
              repair="Choose an option in each highlighted block above, or edit the field."
              alert={false}
              action={null}
              onDismiss={null}
            />
          )}

          <div className="bw-gen__actions">
            {state.runPhase === 'running' ? (
              <button className="bw-gen__btn bw-gen__btn--danger" onClick={() => session.cancel()}>
                <Ban size={11} aria-hidden="true" /> Cancel generation
              </button>
            ) : (
              <button
                className="bw-gen__btn bw-gen__btn--primary"
                onClick={() => generate(true)}
                disabled={unresolved.length > 0}
              >
                <Play size={11} aria-hidden="true" /> Generate {state.candidateCount}
              </button>
            )}
          </div>
        </>
      )}

      {state.runPhase === 'running' && <Progress state={state} />}

      {state.runPhase === 'cancelled' && (
        <Notice
          tone="cancelled"
          title="Generation cancelled"
          detail={`Stopped after ${formatSeconds(state.elapsedMs)}. Candidates are built in memory, so the document is exactly as it was — no transaction was created and no ghost is left over.`}
          repair={null}
          alert={false}
          action={{ label: 'Generate again', run: () => generate(state.usedModel ?? true) }}
          onDismiss={null}
        />
      )}

      {state.runIssue && (
        <Notice
          tone={state.runIssue.kind}
          title={state.runIssue.title}
          detail={state.runIssue.detail}
          repair={
            state.runIssue.kind === 'unavailable'
              ? 'No candidate was invented in its place. Set the model API key on the generation service, or run the deterministic pipeline, which builds from the rule sets and labels itself as such.'
              : 'The document was not touched.'
          }
          alert={state.runIssue.kind === 'error'}
          action={
            state.runIssue.kind === 'unavailable'
              ? { label: 'Generate without the model', run: () => generate(false) }
              : { label: 'Try again', run: () => generate(true) }
          }
          onDismiss={null}
        />
      )}

      {producedNothing(state) && (
        <Notice
          tone="empty"
          title="No candidate passed the hard gates"
          detail={`${state.run?.rejected.length ?? 0} candidate${state.run?.rejected.length === 1 ? '' : 's'} were built and every one of them failed a gate. Nothing was invented to fill the gap.`}
          repair="Loosen the envelope or the budget, or generate more candidates."
          alert={false}
          action={null}
          onDismiss={null}
        />
      )}

      {state.outcome && (
        <Notice
          tone={state.outcome.kind}
          title={state.outcome.title}
          detail={state.outcome.detail}
          repair={state.outcome.repair}
          code={state.outcome.code}
          alert={state.outcome.kind === 'refused' || state.outcome.kind === 'stale'}
          action={null}
          onDismiss={() => session.clearOutcome()}
        />
      )}

      {candidates.length > 0 && (
        <>
          <div className="bw-gen__actions">
            <h3 style={{ flex: 1 }}>
              {candidates.length} candidate{candidates.length === 1 ? '' : 's'} ·{' '}
              {state.run?.distinctHashes ?? 0} distinct structure{state.run?.distinctHashes === 1 ? '' : 's'}
            </h3>
            <button className="bw-gen__btn" onClick={() => api.openModal(COMPARE_MODAL_ID)}>
              <Columns3 size={11} aria-hidden="true" /> Compare
            </button>
          </div>
          <ul className="bw-gen__candidates">
            {candidates.map((candidate, index) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                rank={index + 1}
                selected={candidate.id === state.selectedCandidateId}
                onReview={() => session.selectCandidate(candidate.id)}
              />
            ))}
          </ul>
        </>
      )}

      {selected && (
        <div className="bw-gen__ghost">
          <strong>
            <Eye size={11} aria-hidden="true" /> Ghost review · {selected.strategy}
          </strong>
          {state.ghost ? (
            <>
              <p>
                The preview is drawn over the model at revision {state.ghost.baseRevision}. The kernel validated it and
                found {state.ghost.collisions} collision{state.ghost.collisions === 1 ? '' : 's'}. The document has not
                changed.
              </p>
              <div className="bw-gen__actions">
                <button
                  className="bw-gen__btn bw-gen__btn--primary"
                  disabled={state.ghost.collisions > 0}
                  onClick={() => {
                    const outcome = session.accept()
                    api.notify({
                      kind: outcome.kind === 'applied' ? 'success' : 'error',
                      title: outcome.title,
                      detail: outcome.detail,
                    })
                  }}
                >
                  <Check size={11} aria-hidden="true" /> Add to model
                </button>
                <button className="bw-gen__btn bw-gen__btn--danger" onClick={() => session.selectCandidate(null)}>
                  <X size={11} aria-hidden="true" /> Discard ghost
                </button>
              </div>
            </>
          ) : (
            <p>The kernel would not preview this candidate. The reason is above; nothing was written.</p>
          )}
        </div>
      )}

      {state.run && state.run.rejected.length > 0 && (
        <div className="bw-gen__rejected">
          <h3>Refused by the hard gates ({state.run.rejected.length})</h3>
          {state.run.rejected.map(({ candidate, failures }) => (
            <div className="bw-gen__rejection" key={candidate.id}>
              <strong>{candidate.strategy}</strong>
              <ul>
                {failures.map((failure) => (
                  <li key={failure}>{failure}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {state.run && (
        <div className="bw-gen__report">
          <span>
            Provider <b>{state.run.provenance.provider}</b>
          </span>
          <span>
            Model <b>{state.run.provenance.model ?? 'none'}</b>
          </span>
          <span>
            Prompt hash <b>{state.run.promptHash}</b>
          </span>
          <span>
            Elapsed <b className="bw-gen__num">{formatSeconds(state.run.elapsedMs)}</b>
          </span>
          {state.run.notes.map((note) => (
            <span key={note} style={{ gridColumn: '1 / -1' }}>
              {note}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function Progress({ state }: { state: GenerateState }) {
  const tick = currentTick(state)
  const index = tick?.candidateIndex ?? 0
  const donePhases = new Set(state.ticks.filter((entry) => entry.candidateIndex === index).map((entry) => entry.phase))
  const active = PHASES.find((phase) => !donePhases.has(phase)) ?? null
  const fraction = phaseProgress(state)
  return (
    <div className="bw-gen__progress">
      <div className="bw-gen__progress-head">
        <strong>
          <span className="bw-gen__spinner" aria-hidden="true" /> Candidate {index + 1} of {state.candidateCount}
        </strong>
        <span className="bw-gen__num">{Math.round(fraction * 100)}%</span>
      </div>
      <div
        className="bw-gen__bar"
        role="progressbar"
        aria-label="Generation phase progress"
        aria-valuemin={0}
        aria-valuemax={state.candidateCount * PHASES.length}
        aria-valuenow={state.ticks.length}
        aria-valuetext={`${state.ticks.length} of ${state.candidateCount * PHASES.length} phases complete`}
      >
        <i style={{ width: `${fraction * 100}%` }} />
      </div>
      <ul className="bw-gen__phases">
        {PHASES.map((phase) => (
          <li
            className="bw-gen__phase"
            key={phase}
            data-state={donePhases.has(phase) ? 'done' : phase === active ? 'active' : 'pending'}
          >
            {phase}
          </li>
        ))}
      </ul>
      <p className="bw-gen__hint" role="status">
        {tick
          ? `${tick.strategy} · ${tick.phase} done · ${tick.partsAdded} parts added, ${tick.partCount} total.`
          : 'Waiting for the first phase to report.'}
        {state.stage ? ` Server: ${state.stage}.` : ''}
      </p>
      <p className="bw-gen__hint">Cancelling leaves the document exactly as it is.</p>
    </div>
  )
}

function CandidateCard({
  candidate,
  rank,
  selected,
  onReview,
}: {
  candidate: Candidate
  rank: number
  selected: boolean
  onReview: () => void
}) {
  const rows = HEADLINE_METRIC_KEYS.map((key) => CANDIDATE_METRICS.find((row) => row.key === key)!).filter(Boolean)
  return (
    <li className="bw-gen__candidate" data-selected={selected}>
      <button
        className="bw-gen__pick"
        onClick={onReview}
        aria-pressed={selected}
        aria-label={`Candidate ${rank}: ${candidate.strategy}, ${candidate.metrics.partCount} parts. Review as a ghost.`}
      >
        <span className="bw-gen__rank" aria-hidden="true">
          {rank}
        </span>
        <strong>{candidate.strategy}</strong>
        <span className="bw-gen__grid">
          {rows.map((row) => (
            <span className="bw-gen__metric" key={row.key} data-tone={row.tone?.(candidate.metrics) ?? 'neutral'}>
              <span>{row.label}</span>
              <b>{row.value(candidate.metrics)}</b>
            </span>
          ))}
        </span>
      </button>
      <div className="bw-gen__candidate-actions">
        <button
          className="bw-gen__btn"
          onClick={onReview}
          aria-label={`Preview candidate ${rank} as a ghost`}
          disabled={selected}
        >
          <Eye size={11} aria-hidden="true" /> {selected ? 'Under review' : 'Review as ghost'}
        </button>
      </div>
    </li>
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
  code?: string | null
  alert: boolean
  action: { label: string; run: () => void } | null
  onDismiss: (() => void) | null
}) {
  return (
    <div className="bw-gen__notice" data-tone={tone} role={alert ? 'alert' : 'status'}>
      <strong>
        {alert && <CircleAlert size={11} aria-hidden="true" />} {title}
        {code ? ` · ${code}` : ''}
      </strong>
      <p>{detail}</p>
      {repair && <p className="bw-gen__notice-repair">{repair}</p>}
      {(action || onDismiss) && (
        <div className="bw-gen__actions">
          {action && (
            <button className="bw-gen__btn" onClick={action.run}>
              {action.label}
            </button>
          )}
          {onDismiss && (
            <button className="bw-gen__btn" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  )
}
