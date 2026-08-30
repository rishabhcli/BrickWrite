import {
  Box,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Crosshair,
  ListOrdered,
  MessageSquareText,
  PenLine,
  Play,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { BuilderNote, EngineSnapshot, Transaction } from '../../cad/types'

export type TimelineView = 'steps' | 'history' | 'feedback'

interface TimelineProps {
  state: EngineSnapshot
  /** Step index currently being played back, or null when the whole model shows. */
  playbackStep: number | null
  /** Controlled so `workspace_reveal({ surface: "feedback" })` opens the exact same inbox a human sees. */
  view?: TimelineView
  onViewChange?: (view: TimelineView) => void
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onSelectIds: (ids: string[]) => void
  onSequence: () => void
  onPlayStep: (index: number | null) => void
  onAddNote?: (text: string) => boolean
  onRespondNote?: (noteId: string, response: string, resolved: boolean) => boolean
}

const transactionIcon = (transaction: Transaction) =>
  transaction.author === 'agent' ? <Sparkles size={13} /> : <Box size={13} />

function NoteCard({ note, active, onOpen }: { note: BuilderNote; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`feedback-card ${note.author} ${note.status} ${active ? 'active' : ''}`}
      aria-pressed={active}
      onClick={onOpen}
      title={`Select ${note.anchorPartIds.length} anchored part${note.anchorPartIds.length === 1 ? '' : 's'} and review this handoff`}
    >
      <header>
        {note.author === 'agent' ? <Sparkles size={12} /> : <MessageSquareText size={12} />}
        <span>{note.author === 'agent' ? 'AGENT HANDOFF' : 'HUMAN HANDOFF'}</span>
        <em>r{note.revisionCreated}</em>
      </header>
      <strong>{note.text}</strong>
      {note.response && <p>{note.response}</p>}
      <footer>
        <span>
          <Crosshair size={10} /> {note.anchorPartIds.length} anchor{note.anchorPartIds.length === 1 ? '' : 's'}
        </span>
        <i>{note.status === 'open' ? 'OPEN' : 'RESOLVED'}</i>
      </footer>
    </button>
  )
}

function FeedbackComposer({
  note,
  selectionCount,
  onNew,
  onAdd,
  onRespond,
}: {
  note: BuilderNote | null
  selectionCount: number
  onNew: () => void
  onAdd?: (text: string) => boolean
  onRespond?: (noteId: string, response: string, resolved: boolean) => boolean
}) {
  const [draft, setDraft] = useState('')

  if (!note) {
    const submit = () => {
      const text = draft.trim()
      if (!text || !selectionCount || !onAdd?.(text)) return
      setDraft('')
    }
    return (
      <aside className="feedback-compose" aria-label="New spatial handoff">
        <header>
          <div>
            <PenLine size={13} />
            <span>NEW HANDOFF</span>
          </div>
          <em>{selectionCount ? `${selectionCount} PART${selectionCount === 1 ? '' : 'S'}` : 'SELECT PARTS'}</em>
        </header>
        <textarea
          aria-label="New builder note"
          value={draft}
          maxLength={800}
          placeholder={
            selectionCount
              ? 'What should the next operator inspect, preserve, or change?'
              : 'Select the exact parts this handoff belongs to.'
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit()
          }}
        />
        <footer>
          <small>{draft.length}/800 · ⌘↵ to send</small>
          <button type="button" disabled={!draft.trim() || !selectionCount} onClick={submit}>
            <Send size={11} /> ADD NOTE
          </button>
        </footer>
      </aside>
    )
  }

  const submit = (resolved: boolean) => {
    const response = draft.trim()
    if (!response || !onRespond?.(note.id, response, resolved)) return
    setDraft('')
  }

  return (
    <aside className="feedback-compose reviewing" aria-label="Respond to spatial handoff">
      <header>
        <div>
          {note.author === 'agent' ? <Sparkles size={13} /> : <MessageSquareText size={13} />}
          <span>{note.status === 'open' ? 'REVIEW HANDOFF' : 'RESOLVED HANDOFF'}</span>
        </div>
        <button type="button" onClick={onNew}>
          <PenLine size={10} /> NEW
        </button>
      </header>
      {note.status === 'open' ? (
        <>
          <textarea
            aria-label="Handoff response"
            value={draft}
            maxLength={1200}
            placeholder="Record the decision, correction, or next step in shared history."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(false)
            }}
          />
          <footer>
            <button type="button" disabled={!draft.trim()} onClick={() => submit(false)}>
              <Send size={11} /> REPLY
            </button>
            <button className="feedback-resolve" type="button" disabled={!draft.trim()} onClick={() => submit(true)}>
              <CheckCircle2 size={11} /> RESOLVE
            </button>
          </footer>
        </>
      ) : (
        <div className="feedback-resolution">
          <CheckCircle2 size={16} />
          <p>{note.response ?? 'This handoff was resolved in shared history.'}</p>
          <button type="button" onClick={onNew}>
            Create a follow-up
          </button>
        </div>
      )}
    </aside>
  )
}

/**
 * The shared bottom band: build order, edit history, and the human-agent inbox.
 *
 * Builder notes were already durable model entities and agent tools could read
 * them, but the human surface only exposed the first open note through a modal.
 * The feedback view makes every anchored handoff visible, selectable, replyable
 * and resolvable through the same command bus used by WebMCP.
 */
export function TimelinePanel({
  state,
  playbackStep,
  view,
  onViewChange,
  onAccept,
  onReject,
  onSelectIds,
  onSequence,
  onPlayStep,
  onAddNote,
  onRespondNote,
}: TimelineProps) {
  const [localView, setLocalView] = useState<TimelineView>('steps')
  const [noteScope, setNoteScope] = useState<'open' | 'all'>('open')
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const requestedView = view ?? localView
  const showing: TimelineView = state.proposals.length ? 'history' : requestedView
  const setView = (next: TimelineView) => {
    setLocalView(next)
    onViewChange?.(next)
    if (next === 'feedback') setComposing(false)
  }

  const latestTransactions = state.transactions.slice(-8).reverse()
  const openNotes = state.document.notes.filter((note) => note.status === 'open')
  const visibleNotes = useMemo(
    () => [...state.document.notes].filter((note) => noteScope === 'all' || note.status === 'open').reverse(),
    [noteScope, state.document.notes],
  )
  const selectedNote = composing
    ? null
    : (visibleNotes.find((note) => note.id === selectedNoteId) ?? visibleNotes[0] ?? null)

  const title = showing === 'steps' ? 'Build sequence' : showing === 'history' ? 'Edit history' : 'Feedback inbox'
  const summary =
    showing === 'feedback'
      ? `${openNotes.length} open · ${state.document.notes.length} total`
      : `${state.document.steps.length} steps · ${state.validation.partCount} pcs`

  return (
    <section
      className={`timeline ${showing === 'feedback' ? 'feedback-open' : ''}`}
      aria-label="Build history, sequence, and feedback"
    >
      <div className="timeline-label">
        <span className="eyebrow">SHARED WORKSPACE</span>
        <h3>{title}</h3>
        <div>
          <Clock3 size={12} /> {summary}
        </div>
        <div className="timeline-switch" role="tablist" aria-label="Timeline view">
          <button
            role="tab"
            aria-selected={showing === 'steps'}
            className={showing === 'steps' ? 'active' : ''}
            onClick={() => setView('steps')}
          >
            <ListOrdered size={11} /> STEPS
          </button>
          <button
            role="tab"
            aria-selected={showing === 'history'}
            className={showing === 'history' ? 'active' : ''}
            onClick={() => setView('history')}
          >
            <Clock3 size={11} /> HISTORY <em>{state.transactions.length}</em>
          </button>
          <button
            role="tab"
            aria-selected={showing === 'feedback'}
            className={showing === 'feedback' ? 'active' : ''}
            onClick={() => setView('feedback')}
          >
            <MessageSquareText size={11} /> NOTES <em>{openNotes.length}</em>
          </button>
        </div>
        {showing === 'steps' && (
          <div className="timeline-actions">
            <button
              className="sequence-button"
              onClick={onSequence}
              title="Derive a build sequence in which every part attaches to earlier structure"
            >
              <ListOrdered size={11} /> RESEQUENCE
            </button>
            <button
              className={`sequence-button ${playbackStep === null ? '' : 'active'}`}
              onClick={() => onPlayStep(playbackStep === null ? 0 : null)}
              title={playbackStep === null ? 'Play the build one step at a time' : 'Show the whole model again'}
            >
              {playbackStep === null ? <Play size={11} /> : <Square size={11} />}{' '}
              {playbackStep === null ? 'PLAY' : 'SHOW ALL'}
            </button>
          </div>
        )}
        {showing === 'feedback' && (
          <div className="timeline-actions feedback-actions">
            <button
              className={`sequence-button ${noteScope === 'open' ? 'active' : ''}`}
              onClick={() => setNoteScope('open')}
            >
              OPEN
            </button>
            <button
              className={`sequence-button ${noteScope === 'all' ? 'active' : ''}`}
              onClick={() => setNoteScope('all')}
            >
              ALL
            </button>
            <button
              className={`sequence-button ${composing ? 'active' : ''}`}
              onClick={() => {
                setComposing(true)
                setSelectedNoteId(null)
              }}
            >
              <PenLine size={10} /> NEW
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
                <header>
                  <Sparkles size={13} />
                  <span>CODEX PROPOSAL</span>
                  <em>r{proposal.baseRevision}</em>
                </header>
                <strong>{proposal.label}</strong>
                <p>
                  {proposal.operations.length} operations · {proposal.validation.collisions.length} collisions
                </p>
                <footer>
                  <button onClick={() => onAccept(proposal.id)}>
                    <Check size={12} /> Accept
                  </button>
                  <button onClick={() => onReject(proposal.id)}>
                    <X size={12} /> Reject
                  </button>
                </footer>
              </article>
            ))}
            {latestTransactions.length === 0 && (
              <div className="timeline-empty">
                Nothing has been edited yet. Every change you or the agent makes lands here as one atomic, reversible
                transaction.
              </div>
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
                <div>
                  <strong>{transaction.label}</strong>
                  <small>
                    {transaction.operations.length} operation{transaction.operations.length === 1 ? '' : 's'} ·{' '}
                    {transaction.author}
                  </small>
                </div>
                <em>r{transaction.resultRevision}</em>
              </button>
            ))}
          </>
        ) : showing === 'feedback' ? (
          <>
            {visibleNotes.length === 0 && (
              <div className="timeline-empty feedback-empty">
                <MessageSquareText size={18} />
                <strong>{noteScope === 'open' ? 'The handoff queue is clear.' : 'No handoffs yet.'}</strong>
                <span>Select exact parts and add a note for the human or agent who works here next.</span>
              </div>
            )}
            {visibleNotes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                active={selectedNote?.id === note.id}
                onOpen={() => {
                  setComposing(false)
                  setSelectedNoteId(note.id)
                  onSelectIds(note.anchorPartIds)
                }}
              />
            ))}
          </>
        ) : (
          <>
            {state.document.steps.length === 0 && (
              <div className="timeline-empty">
                No build sequence yet. Press RESEQUENCE to derive one from the connection graph.
              </div>
            )}
            {state.document.steps.map((step, index) => {
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
      {showing === 'feedback' ? (
        <FeedbackComposer
          key={selectedNote?.id ?? 'new'}
          note={selectedNote}
          selectionCount={state.selection.length}
          onNew={() => {
            setComposing(true)
            setSelectedNoteId(null)
          }}
          onAdd={onAddNote}
          onRespond={onRespondNote}
        />
      ) : (
        <button
          type="button"
          className="timeline-note"
          onClick={() => {
            setView('feedback')
            setSelectedNoteId(openNotes[0]?.id ?? null)
            setComposing(!openNotes.length)
          }}
        >
          <MessageSquareText size={14} />
          <div>
            <span>HANDOFF INBOX{openNotes.length ? ` · ${openNotes.length} OPEN` : ''}</span>
            <strong>{openNotes[0]?.text ?? 'Leave anchored context for the next human or agent.'}</strong>
          </div>
        </button>
      )}
    </section>
  )
}
