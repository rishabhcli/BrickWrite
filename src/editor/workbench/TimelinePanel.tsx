import {
  Box,
  Check,
  CircleDot,
  Clock3,
  ListOrdered,
  MessageSquareText,
  Play,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { useState } from 'react'
import type { EngineSnapshot, Transaction } from '../../cad/types'

interface TimelineProps {
  state: EngineSnapshot
  /** Step index currently being played back, or null when the whole model shows. */
  playbackStep: number | null
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onSelectIds: (ids: string[]) => void
  onSequence: () => void
  onPlayStep: (index: number | null) => void
}

const transactionIcon = (transaction: Transaction) => transaction.author === 'agent' ? <Sparkles size={13} /> : <Box size={13} />

/**
 * The shared bottom band: edit history and build sequence.
 *
 * These are two different readings of the same model — what was done, and what
 * order it goes together in — so they get an explicit switch. Before, the band
 * silently swapped the sequence out for history the moment anything was edited,
 * which meant the build steps disappeared exactly when a builder started using
 * the tool.
 */
export function TimelinePanel({ state, playbackStep, onAccept, onReject, onSelectIds, onSequence, onPlayStep }: TimelineProps) {
  const [view, setView] = useState<'history' | 'steps'>('steps')
  const latestTransactions = state.transactions.slice(-8).reverse()
  const showing = state.proposals.length ? 'history' : view

  return (
    <section className="timeline" aria-label="Build history and sequence">
      <div className="timeline-label">
        <span className="eyebrow">SHARED WORKSPACE</span>
        <h3>{showing === 'steps' ? 'Build sequence' : 'Edit history'}</h3>
        <div><Clock3 size={12} /> {state.document.steps.length} steps · {state.validation.partCount} pcs</div>
        <div className="timeline-switch" role="tablist" aria-label="Timeline view">
          <button role="tab" aria-selected={showing === 'steps'} className={showing === 'steps' ? 'active' : ''} onClick={() => setView('steps')}>
            <ListOrdered size={11} /> STEPS
          </button>
          <button role="tab" aria-selected={showing === 'history'} className={showing === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            <Clock3 size={11} /> HISTORY <em>{state.transactions.length}</em>
          </button>
        </div>
        {showing === 'steps' && (
          <div className="timeline-actions">
            {/* Sequencing is a precedence problem over the connection graph, so it is
                regenerated from the model rather than authored by hand. */}
            <button className="sequence-button" onClick={onSequence} title="Derive a build sequence in which every part attaches to earlier structure">
              <ListOrdered size={11} /> RESEQUENCE
            </button>
            <button
              className={`sequence-button ${playbackStep === null ? '' : 'active'}`}
              onClick={() => onPlayStep(playbackStep === null ? 0 : null)}
              title={playbackStep === null ? 'Play the build one step at a time' : 'Show the whole model again'}
            >
              {playbackStep === null ? <Play size={11} /> : <Square size={11} />} {playbackStep === null ? 'PLAY' : 'SHOW ALL'}
            </button>
          </div>
        )}
      </div>
      <div className="timeline-track">
        {showing === 'history' ? (
          <>
            {state.proposals.map((proposal) => (
              <article className="proposal-card" key={proposal.id}>
                <div className="proposal-glow" />
                <header><Sparkles size={13} /><span>CODEX PROPOSAL</span><em>r{proposal.baseRevision}</em></header>
                <strong>{proposal.label}</strong>
                <p>{proposal.operations.length} operations · {proposal.validation.collisions.length} collisions</p>
                <footer>
                  <button onClick={() => onAccept(proposal.id)}><Check size={12} /> Accept</button>
                  <button onClick={() => onReject(proposal.id)}><X size={12} /> Reject</button>
                </footer>
              </article>
            ))}
            {latestTransactions.length === 0 && (
              <div className="timeline-empty">Nothing has been edited yet. Every change you or the agent makes lands here as one atomic, reversible transaction.</div>
            )}
            {latestTransactions.map((transaction, index) => (
              <button
                className={`transaction-card ${transaction.author}`}
                key={transaction.id}
                title={`Select the ${transaction.affectedPartIds.length} part(s) this transaction touched`}
                onClick={() => onSelectIds(transaction.affectedPartIds)}
              >
                <span className="transaction-index">{String(state.transactions.length - index).padStart(2, '0')}</span>
                <div className="transaction-icon">{transactionIcon(transaction)}</div>
                <div><strong>{transaction.label}</strong><small>{transaction.operations.length} operation{transaction.operations.length === 1 ? '' : 's'} · {transaction.author}</small></div>
                <em>r{transaction.resultRevision}</em>
              </button>
            ))}
          </>
        ) : (
          <>
            {state.document.steps.length === 0 && (
              <div className="timeline-empty">No build sequence yet. Press RESEQUENCE to derive one from the connection graph.</div>
            )}
            {state.document.steps.map((step, index) => {
              // "Complete" means built at the point the operator is looking at:
              // during playback that is everything up to the current step, and
              // with playback off the whole sequence is built.
              const built = playbackStep === null || index <= playbackStep
              const current = playbackStep === index
              return (
                <button
                  className={`step-card ${built ? 'complete' : ''} ${current ? 'current' : ''}`}
                  key={step.id}
                  aria-current={current}
                  title={`Show the build through step ${step.index}: ${step.name}`}
                  onClick={() => {
                    onPlayStep(index)
                    onSelectIds(step.partIds)
                  }}
                >
                  <span>{String(step.index).padStart(2, '0')}</span>
                  <div className="step-node">{built ? <Check size={11} /> : <CircleDot size={10} />}</div>
                  <strong>{step.name}</strong>
                  <small>{step.partIds.length} parts</small>
                </button>
              )
            })}
          </>
        )}
      </div>
      <div className="timeline-note">
        <MessageSquareText size={14} />
        <div><span>OPEN NOTE</span><strong>{state.document.notes.find((note) => note.status === 'open')?.text ?? 'No unresolved builder notes'}</strong></div>
      </div>
    </section>
  )
}
