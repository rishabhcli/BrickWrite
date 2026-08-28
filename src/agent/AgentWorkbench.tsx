import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { cadEngine } from '../cad/engine'
import { parseReferenceTokens, resolveReference, type SpatialReference } from './references'
import { AgentSession, type SessionState } from './session'
import type { AgentMode } from './modes'
import './workbench.css'

/**
 * The in-editor composer.
 *
 * Design constraints that shaped it:
 *
 *   - It is persistent. A design conversation that disappears when you click
 *     the model is not a design conversation, so the panel collapses to a
 *     header rather than unmounting, and the session survives the collapse.
 *   - Every state it can be in is visible and named. Streaming, running tools,
 *     cancelled, failed and idle are distinct, and the failed state carries the
 *     reason and the two things you can do about it.
 *   - There is no fabricated progress. The pulse next to "waiting for the
 *     model" is shown while a stream is genuinely open; it is never shown to
 *     cover a request that has already failed.
 *   - Nothing here commits. Accept is an explicit act on one wave, and it goes
 *     through the same revision check the kernel would apply anyway.
 */

const MODES: ReadonlyArray<{ id: AgentMode; label: string; hint: string }> = [
  { id: 'inspect', label: 'Inspect', hint: 'Read-only. The assistant can look but cannot propose.' },
  { id: 'propose', label: 'Propose', hint: 'The assistant plans reviewable waves. Nothing changes until you accept.' },
  { id: 'build', label: 'Build', hint: 'Accepted waves are committed automatically after a revision re-check.' },
]

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    // jsdom and older embedders have no matchMedia; the absence of the API is
    // not a statement that motion is wanted, so the default stays "animate".
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

export interface AgentWorkbenchProps {
  /** Injected by tests and by hosts that own the session lifetime. */
  session?: AgentSession
  defaultCollapsed?: boolean
  /** Controlled collapse, for a shell that remembers panel state. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

export function AgentWorkbench({ session: injected, defaultCollapsed = false, collapsed, onCollapsedChange }: AgentWorkbenchProps) {
  const ownedSession = useMemo(() => injected ?? new AgentSession(), [injected])
  useEffect(() => () => {
    if (!injected) ownedSession.dispose()
  }, [injected, ownedSession])

  const state = useSyncExternalStore<SessionState>(ownedSession.subscribe, ownedSession.getState, ownedSession.getState)
  const reducedMotion = usePrefersReducedMotion()

  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed)
  const isCollapsed = collapsed ?? internalCollapsed
  const [draft, setDraft] = useState('')
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null)
  const [feedbackText, setFeedbackText] = useState('')

  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const setCollapsed = useCallback(
    (next: boolean) => {
      // Focus is restored deliberately: collapsing from a button inside the
      // panel would otherwise drop focus onto <body> and strand a keyboard user.
      if (next) restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null
      if (collapsed === undefined) setInternalCollapsed(next)
      onCollapsedChange?.(next)
      queueMicrotask(() => {
        if (next) toggleRef.current?.focus()
        else (restoreFocusRef.current ?? composerRef.current)?.focus()
      })
    },
    [collapsed, onCollapsedChange],
  )

  // Follow the tail of the transcript while it grows, without stealing the
  // scroll position from someone reading further up.
  const atBottomRef = useRef(true)
  useEffect(() => {
    const node = transcriptRef.current
    if (!node || !atBottomRef.current) return
    node.scrollTop = node.scrollHeight
  }, [state.transcript])

  const draftReferences = useMemo<SpatialReference[]>(() => {
    const snapshot = cadEngine.getSnapshot()
    return parseReferenceTokens(draft).map((token) =>
      resolveReference(token, { document: snapshot.document, selection: snapshot.selection }),
    )
  }, [draft, state.revision, state.transcript])

  const pendingWaves = state.waves.filter((wave) => wave.status === 'pending')
  const reviewableWaves = state.waves.filter((wave) => wave.status !== 'rejected')
  const streaming = state.status === 'streaming'
  const runningTools = state.status === 'tools'
  const awaitingFirstToken =
    streaming && !state.transcript.some((message) => message.status === 'streaming' && message.text.length > 0)

  const submit = useCallback(async () => {
    const text = draft.trim()
    if (!text || state.busy) return
    setDraft('')
    await ownedSession.send(text)
  }, [draft, ownedSession, state.busy])

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void submit()
      }
      if (event.key === 'Escape' && state.busy) {
        event.preventDefault()
        ownedSession.cancel()
      }
    },
    [ownedSession, state.busy, submit],
  )

  const statusLabel = runningTools
    ? `Running ${state.transcript.at(-1)?.toolCalls?.length ?? 0} tool call(s)`
    : awaitingFirstToken
      ? 'Waiting for the model'
      : streaming
        ? 'Replying'
        : state.status === 'cancelled'
          ? 'Cancelled'
          : state.status === 'error'
            ? 'Failed'
            : 'Ready'

  return (
    <section
      className="bw-agent"
      aria-label="Design partner"
      data-collapsed={isCollapsed}
      data-status={state.status}
      data-reduced-motion={reducedMotion}
    >
      <header className="bw-agent__header">
        <button
          ref={toggleRef}
          type="button"
          className="bw-agent__toggle"
          aria-expanded={!isCollapsed}
          aria-controls={panelId}
          onClick={() => setCollapsed(!isCollapsed)}
        >
          <span className="bw-agent__chevron" aria-hidden="true">
            ▾
          </span>
          Design partner
        </button>
        <span className="bw-agent__revision" aria-label={`Document revision ${state.revision}`}>
          r{state.revision}
        </span>
        <span className="bw-agent__visually-hidden" role="status" aria-live="polite">
          {statusLabel}
        </span>
      </header>

      <div id={panelId} hidden={isCollapsed} className="bw-agent__body">
        <div className="bw-agent__modes" role="radiogroup" aria-label="Autonomy mode">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              className="bw-agent__mode"
              aria-checked={state.mode === mode.id}
              title={mode.hint}
              onClick={() => ownedSession.setMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <div
          ref={transcriptRef}
          className="bw-agent__transcript"
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          aria-relevant="additions text"
          onScroll={(event) => {
            const node = event.currentTarget
            atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
          }}
        >
          {state.transcript.length === 0 ? (
            <div className="bw-agent__empty">
              <h3>Nothing has been asked yet.</h3>
              <p>Describe a change in your own words. The assistant reads the model before it plans, and every change it proposes waits for you.</p>
              <ul>
                <li>
                  <code>@selection</code> — whatever is selected in the viewport
                </li>
                <li>
                  <code>@part:&lt;id&gt;</code>, <code>@subassembly:&lt;id&gt;</code>, <code>@note:&lt;id&gt;</code>
                </li>
                <li>
                  <code>@view</code> — what the camera is looking at
                </li>
              </ul>
            </div>
          ) : (
            state.transcript.map((message) => (
              <article
                key={message.id}
                className="bw-agent__message"
                data-role={message.role}
                data-status={message.status}
                aria-label={`${message.role} message`}
              >
                <span className="bw-agent__role">
                  {message.role === 'user' ? 'You' : message.role === 'notice' ? 'Workbench' : 'Assistant'}
                </span>
                {message.text || (message.status === 'streaming' ? '' : '(no reply)')}
                {message.references && message.references.length > 0 && (
                  <ul className="bw-agent__chips" aria-label="References in this message">
                    {message.references.map((reference) => (
                      <li key={reference.token} className="bw-agent__chip" data-resolved={reference.resolved}>
                        {reference.label}
                        {!reference.resolved && <span className="bw-agent__visually-hidden"> — unresolved: {reference.problem}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <ul className="bw-agent__toolcalls" aria-label="Tools used">
                    {message.toolCalls.map((call) => (
                      <li key={call.id} className="bw-agent__toolcall" data-ok={call.ok === null ? 'pending' : String(call.ok)}>
                        {call.name}
                        {call.ok === false ? ' · failed' : call.ok === true ? ' · ok' : ' · running'}
                      </li>
                    ))}
                  </ul>
                )}
                {message.problem && <p className="bw-agent__problem">{message.problem}</p>}
              </article>
            ))
          )}

          {(streaming || runningTools) && (
            <p className="bw-agent__pending">
              <span className="bw-agent__pulse" aria-hidden="true" />
              {statusLabel}
            </p>
          )}
        </div>

        {state.error && (
          <div className="bw-agent__error" role="alert">
            <strong>{state.error.code}</strong>
            <p>{state.error.message}</p>
            <div className="bw-agent__wave-actions">
              <button
                type="button"
                className="bw-agent__button"
                onClick={() => void ownedSession.retry()}
                disabled={!state.canRetry}
              >
                Retry
              </button>
              <button type="button" className="bw-agent__button" onClick={() => void ownedSession.replan()}>
                Replan
              </button>
            </div>
          </div>
        )}

        {reviewableWaves.length > 0 && (
          <section className="bw-agent__waves" aria-label="Proposed changes">
            <h3>
              Proposed changes ({pendingWaves.length} awaiting review)
            </h3>
            {reviewableWaves.map((wave) => (
              <article key={wave.id} className="bw-agent__wave" data-status={wave.status} aria-label={`Wave: ${wave.label}`}>
                <span className="bw-agent__wave-title">{wave.label}</span>
                <span className="bw-agent__wave-meta">
                  {wave.summary} · {wave.operations.length} operation(s) · planned at r{wave.baseRevision}
                  {wave.validation ? ` · ${wave.validation.collisions.length} collision(s) in preview` : ''}
                </span>
                {wave.problem && <p className="bw-agent__problem">{wave.problem}</p>}
                {wave.status === 'pending' ? (
                  <div className="bw-agent__wave-actions">
                    <button
                      type="button"
                      className="bw-agent__button"
                      data-variant="primary"
                      onClick={() => ownedSession.acceptWave(wave.id)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="bw-agent__button"
                      data-variant="danger"
                      onClick={() => ownedSession.rejectWave(wave.id)}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="bw-agent__button"
                      onClick={() => {
                        setFeedbackFor(wave.id)
                        setFeedbackText('')
                      }}
                    >
                      Reject with reason
                    </button>
                  </div>
                ) : (
                  <span className="bw-agent__wave-meta">{wave.status}</span>
                )}
                {feedbackFor === wave.id && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      const reason = feedbackText.trim()
                      if (!reason) return
                      setFeedbackFor(null)
                      void ownedSession.feedback(wave.id, reason)
                    }}
                  >
                    <label className="bw-agent__visually-hidden" htmlFor={`${panelId}-feedback`}>
                      Why are you rejecting {wave.label}?
                    </label>
                    <input
                      id={`${panelId}-feedback`}
                      value={feedbackText}
                      onChange={(event) => setFeedbackText(event.target.value)}
                      placeholder="Why does this not work?"
                    />
                    <button type="submit" className="bw-agent__button">
                      Send
                    </button>
                  </form>
                )}
              </article>
            ))}
            {pendingWaves.length > 1 && (
              <button type="button" className="bw-agent__button" onClick={() => ownedSession.acceptAll()}>
                Accept all {pendingWaves.length} waves in order
              </button>
            )}
          </section>
        )}

        <form
          className="bw-agent__composer"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {draftReferences.length > 0 && (
            <ul className="bw-agent__chips" aria-label="References in this message">
              {draftReferences.map((reference) => (
                <li key={reference.token} className="bw-agent__chip" data-resolved={reference.resolved}>
                  {reference.label}
                  {!reference.resolved && <span className="bw-agent__visually-hidden"> — unresolved: {reference.problem}</span>}
                </li>
              ))}
            </ul>
          )}
          <label className="bw-agent__visually-hidden" htmlFor={`${panelId}-composer`}>
            Ask the design partner
          </label>
          <textarea
            id={`${panelId}-composer`}
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Describe a change. Reference parts with @selection or @part:id."
            aria-describedby={`${panelId}-hint`}
          />
          <div className="bw-agent__composer-actions">
            <button type="submit" className="bw-agent__button" data-variant="primary" disabled={state.busy || !draft.trim()}>
              Send
            </button>
            <button type="button" className="bw-agent__button" onClick={() => ownedSession.cancel()} disabled={!state.busy}>
              Cancel
            </button>
            <button
              type="button"
              className="bw-agent__button"
              onClick={() => void ownedSession.retry()}
              disabled={!state.canRetry}
            >
              Retry
            </button>
            <button
              type="button"
              className="bw-agent__button"
              onClick={() => void ownedSession.replan()}
              disabled={!state.canReplan || state.busy}
            >
              Replan
            </button>
            <span className="bw-agent__hint" id={`${panelId}-hint`}>
              {state.model ? `${state.model} · ` : ''}
              {state.toolTurn}/{state.maxToolTurns} tool rounds · ⌘↵ to send
            </span>
          </div>
        </form>

        <details className="bw-agent__trace">
          <summary>Activity ({state.trace.length})</summary>
          <ol aria-label="Activity trace">
            {state.trace.map((entry) => (
              <li key={entry.id} data-status={entry.status}>
                r{entry.revision} · {entry.kind} · {entry.label}
                {entry.problem ? ` — ${entry.problem}` : ''}
                {entry.durationMs !== undefined ? ` · ${entry.durationMs}ms` : ''}
              </li>
            ))}
          </ol>
        </details>
      </div>
    </section>
  )
}

export default AgentWorkbench
