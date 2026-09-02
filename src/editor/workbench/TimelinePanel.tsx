import {
  AlertTriangle,
  Box,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Crosshair,
  Eye,
  ListOrdered,
  MessageSquareText,
  PenLine,
  Pause,
  Play,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Undo2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { BuilderNote, EngineSnapshot, Proposal, Transaction } from '../../cad/types'
import { summariseProposal, type ProposalReviewSummary } from './proposalReview'

export type TimelineView = 'steps' | 'history' | 'feedback' | 'review'

interface TimelineProps {
  state: EngineSnapshot
  /** Step index currently being played back, or null when the whole model shows. */
  playbackStep: number | null
  /** Controlled so `workspace_reveal({ surface: "feedback" })` opens the exact same inbox a human sees. */
  view?: TimelineView
  onViewChange?: (view: TimelineView) => void
  activeProposalId?: string | null
  onActiveProposal?: (id: string) => void
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onSelectIds: (ids: string[]) => void
  onSequence: () => void
  onPlayStep: (index: number | null) => void
  playbackPlaying?: boolean
  onPlayBuild?: () => void
  onPausePlayback?: () => void
  onAddNote?: (text: string) => boolean
  onRespondNote?: (noteId: string, response: string, resolved: boolean) => boolean
}

const transactionIcon = (transaction: Transaction) =>
  transaction.kind === 'undo' || transaction.kind === 'redo' ? (
    <Undo2 size={13} />
  ) : transaction.author === 'agent' ? (
    <Sparkles size={13} />
  ) : (
    <Box size={13} />
  )

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

const signed = (value: number) => `${value > 0 ? '+' : ''}${value}`

function ProposalQueueCard({
  proposal,
  summary,
  active,
  onOpen,
}: {
  proposal: Proposal
  summary: ProposalReviewSummary
  active: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className={`review-queue-card ${active ? 'active' : ''} ${summary.ready ? 'ready' : 'blocked'}`}
      aria-pressed={active}
      onClick={onOpen}
      title={`Review ${proposal.label}`}
    >
      <header>
        <Sparkles size={12} />
        <span>{proposal.author === 'agent' ? 'AGENT PREFLIGHT' : 'HUMAN PREFLIGHT'}</span>
        <em>r{proposal.baseRevision}</em>
      </header>
      <strong>{proposal.label}</strong>
      <div>
        <span>{proposal.operations.length} ops</span>
        <span>{signed(summary.partDelta)} parts</span>
        <span className={summary.ready ? 'pass' : 'fail'}>
          {summary.ready ? 'READY' : `${summary.blockers.length} BLOCKED`}
        </span>
      </div>
      <footer>
        <i>{active ? 'VIEWING GHOST' : 'OPEN REVIEW'}</i>
        {summary.ready ? <ShieldCheck size={11} /> : <AlertTriangle size={11} />}
      </footer>
    </button>
  )
}

function ProposalReviewInspector({
  proposal,
  summary,
  onInspect,
  onAccept,
  onReject,
}: {
  proposal: Proposal | null
  summary: ProposalReviewSummary | null
  onInspect: (ids: string[]) => void
  onAccept: (id: string) => void
  onReject: (id: string) => void
}) {
  if (!proposal || !summary) {
    return (
      <aside className="review-inspector empty" aria-label="Proposal review details">
        <ShieldCheck size={18} />
        <strong>Review queue clear</strong>
        <span>Agent preflights will appear here before anything reaches shared history.</span>
      </aside>
    )
  }

  const primaryIssue = summary.blockers[0] ?? summary.warnings[0] ?? 'Kernel preflight is clear to commit.'
  return (
    <aside className={`review-inspector ${summary.ready ? 'ready' : 'blocked'}`} aria-label="Proposal review details">
      <header>
        <span>{summary.ready ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}</span>
        <div>
          <small>{summary.ready ? 'READY TO COMMIT' : 'COMMIT BLOCKED'}</small>
          <strong>{proposal.label}</strong>
        </div>
        <em>{proposal.id.slice(-6)}</em>
      </header>
      <div className="review-metrics" aria-label="Proposal metric changes">
        <div>
          <span>PARTS</span>
          <strong>{signed(summary.partDelta)}</strong>
        </div>
        <div>
          <span>CONN</span>
          <strong>{signed(summary.connectionDelta)}</strong>
        </div>
        <div>
          <span>ISLANDS</span>
          <strong>{signed(summary.componentDelta)}</strong>
        </div>
        <div className={summary.collisionDelta > 0 ? 'bad' : ''}>
          <span>HITS</span>
          <strong>{signed(summary.collisionDelta)}</strong>
        </div>
      </div>
      <div className="review-operation-groups">
        {summary.groups.map((group) => (
          <span key={group.id}>
            {group.label}
            <em>{group.count}</em>
          </span>
        ))}
      </div>
      <p className="review-verdict">{primaryIssue}</p>
      <footer>
        <button
          type="button"
          className="review-inspect"
          disabled={!summary.selectablePartIds.length}
          onClick={() => onInspect([...summary.selectablePartIds])}
          title={
            summary.selectablePartIds.length
              ? 'Select existing parts touched by this proposal'
              : summary.addedPartIds.length
                ? 'New parts exist only as ghosts until this preflight is accepted'
                : 'This preflight does not touch existing parts'
          }
        >
          <Eye size={11} />{' '}
          {summary.selectablePartIds.length ? `INSPECT ${summary.selectablePartIds.length}` : 'GHOSTS ONLY'}
        </button>
        <button type="button" className="review-reject" onClick={() => onReject(proposal.id)}>
          <X size={11} /> REJECT
        </button>
        <button
          type="button"
          className="review-accept"
          disabled={!summary.ready}
          onClick={() => onAccept(proposal.id)}
          title={summary.ready ? 'Commit this preflight as one shared transaction' : primaryIssue}
        >
          <Check size={11} /> ACCEPT
        </button>
      </footer>
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
  activeProposalId,
  onActiveProposal,
  onAccept,
  onReject,
  onSelectIds,
  onSequence,
  onPlayStep,
  playbackPlaying = false,
  onPlayBuild,
  onPausePlayback,
  onAddNote,
  onRespondNote,
}: TimelineProps) {
  const [localView, setLocalView] = useState<TimelineView>('steps')
  const [noteScope, setNoteScope] = useState<'open' | 'all'>('open')
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const requestedView = view ?? localView
  const showing: TimelineView = requestedView
  const setView = (next: TimelineView) => {
    setLocalView(next)
    onViewChange?.(next)
    if (next === 'feedback') setComposing(false)
  }

  const latestTransactions = [...state.transactions].reverse()
  const openNotes = state.document.notes.filter((note) => note.status === 'open')
  const visibleNotes = useMemo(
    () => [...state.document.notes].filter((note) => noteScope === 'all' || note.status === 'open').reverse(),
    [noteScope, state.document.notes],
  )
  const selectedNote = composing
    ? null
    : (visibleNotes.find((note) => note.id === selectedNoteId) ?? visibleNotes[0] ?? null)

  const activeProposal =
    state.proposals.find((proposal) => proposal.id === activeProposalId) ?? state.proposals[0] ?? null
  const proposalSummaries = useMemo(
    () => new Map(state.proposals.map((proposal) => [proposal.id, summariseProposal(proposal, state)])),
    [state],
  )
  const activeProposalSummary = activeProposal ? (proposalSummaries.get(activeProposal.id) ?? null) : null

  const title =
    showing === 'steps'
      ? 'Build sequence'
      : showing === 'history'
        ? 'Edit history'
        : showing === 'review'
          ? 'Change review'
          : 'Feedback inbox'
  const summary =
    showing === 'feedback'
      ? `${openNotes.length} open · ${state.document.notes.length} total`
      : showing === 'review'
        ? `${state.proposals.length} pending · document r${state.document.revision}`
        : showing === 'history'
          ? `${state.transactions.length} edits · document r${state.document.revision}`
          : `${state.document.steps.length} steps · ${state.validation.partCount} pcs`

  return (
    <section
      className={`timeline ${showing === 'feedback' ? 'feedback-open' : ''} ${showing === 'review' ? 'review-open' : ''} ${state.proposals.length ? 'has-proposals' : ''}`}
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
          {state.proposals.length > 0 && (
            <button
              role="tab"
              aria-selected={showing === 'review'}
              className={showing === 'review' ? 'active' : ''}
              onClick={() => setView('review')}
            >
              <Sparkles size={11} /> REVIEW <em>{state.proposals.length}</em>
            </button>
          )}
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
        {showing === 'review' ? (
          <>
            {state.proposals.length === 0 && (
              <div className="timeline-empty">
                No preflights are waiting. Agent proposals appear here as measured ghosts before they can become edits.
              </div>
            )}
            {state.proposals.map((proposal) => {
              const proposalSummary = proposalSummaries.get(proposal.id)!
              return (
                <ProposalQueueCard
                  key={proposal.id}
                  proposal={proposal}
                  summary={proposalSummary}
                  active={activeProposal?.id === proposal.id}
                  onOpen={() => onActiveProposal?.(proposal.id)}
                />
              )
            })}
          </>
        ) : showing === 'history' ? (
          <>
            {latestTransactions.length === 0 && (
              <div className="timeline-empty">
                Nothing has been edited yet. Every change you or the agent makes lands here as one atomic, reversible
                transaction.
              </div>
            )}
            {latestTransactions.map((transaction, index) => {
              const liveIds = transaction.affectedPartIds.filter((id) => Boolean(state.document.parts[id]))
              const head = index === 0
              const kind = transaction.kind === 'undo' || transaction.kind === 'redo' ? transaction.kind : 'edit'
              return (
                <button
                  className={`transaction-card ${transaction.author} ${kind} ${head ? 'current' : ''}`}
                  key={transaction.id}
                  type="button"
                  disabled={!liveIds.length}
                  title={
                    liveIds.length
                      ? `Select the ${liveIds.length} live part${liveIds.length === 1 ? '' : 's'} this ${kind} still holds`
                      : 'Those parts are no longer in the document. This card is history, not an undo target.'
                  }
                  onClick={() => onSelectIds(liveIds)}
                >
                  <span className="transaction-index">
                    {String(state.transactions.length - index).padStart(2, '0')}
                  </span>
                  <div className="transaction-icon">{transactionIcon(transaction)}</div>
                  <div>
                    <strong>{transaction.label}</strong>
                    <small>
                      {transaction.operations.length} operation{transaction.operations.length === 1 ? '' : 's'} · {kind}
                      {head ? ' · HEAD' : ''}
                    </small>
                  </div>
                  <em>r{transaction.resultRevision}</em>
                </button>
              )
            })}
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
                  title={`Hold the build at step ${step.index}: ${step.name}`}
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
      {showing === 'review' ? (
        <ProposalReviewInspector
          proposal={activeProposal}
          summary={activeProposalSummary}
          onInspect={onSelectIds}
          onAccept={onAccept}
          onReject={onReject}
        />
      ) : showing === 'feedback' ? (
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
      ) : showing === 'steps' ? (
        <aside className="timeline-transport" aria-label="Build playback controls">
          <header>
            <span>{playbackPlaying ? 'PLAYING' : playbackStep === null ? 'SEQUENCE' : 'SCRUB'}</span>
            <strong>
              {playbackStep === null ? 'Whole model' : `Step ${playbackStep + 1} / ${state.document.steps.length}`}
            </strong>
          </header>
          <p>
            {playbackStep === null
              ? 'Play advances automatically. Click a step to hold there without running the rest.'
              : (state.document.steps[playbackStep]?.name ?? 'Build step')}
          </p>
          <footer>
            <button
              type="button"
              className="sequence-button"
              disabled={!state.document.steps.length}
              onClick={() => {
                if (playbackPlaying) onPausePlayback?.()
                else if (onPlayBuild) onPlayBuild()
                else onPlayStep(playbackStep ?? 0)
              }}
            >
              {playbackPlaying ? <Pause size={11} /> : <Play size={11} />} {playbackPlaying ? 'PAUSE' : 'PLAY'}
            </button>
            <button
              type="button"
              className="sequence-button"
              disabled={playbackStep === null}
              onClick={() => onPlayStep(null)}
            >
              <Square size={11} /> SHOW ALL
            </button>
          </footer>
        </aside>
      ) : (
        <aside className="timeline-history-legend" aria-label="Edit history">
          <Undo2 size={14} />
          <div>
            <span>SHARED HISTORY</span>
            <strong>
              Cards select live parts this edit still holds. Undo appends a new card; it does not jump the playhead.
            </strong>
          </div>
        </aside>
      )}
    </section>
  )
}
