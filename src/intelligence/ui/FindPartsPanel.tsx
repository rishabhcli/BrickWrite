import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Loader2, Plus, Search, TriangleAlert } from 'lucide-react'
import { catalog } from '../../cad/catalog'
import type { PartIntentMatch, PartIntentResult } from '../../platform/contracts'
import { resolvePartIntent } from '../parts/resolve'
import type { ResolveOptions } from '../parts/resolve'
import './find-parts.css'

/**
 * Finding a part by describing it.
 *
 * The catalogue palette answers "show me every 1 x 2 plate". This answers "a
 * transparent windscreen about six studs wide", which is the question people
 * actually have, and it answers it with its working shown: the confidence is
 * calibrated against a 129-query evaluation set rather than being a rank in
 * disguise, the explanation names the signals that fired, and the
 * interpretation is printed so a wrong reading of the request is visible and
 * correctable instead of silently baked in.
 *
 * Two refusals are the point of the surface.
 *
 * **It will not pretend a request was fully understood.** `unmatchedTerms` is
 * given its own block, because "a 64 stud long 1 x 1 round brick" has an answer
 * for half of it and none for the other half, and blending those into one
 * confident verdict is how a search engine lies.
 *
 * **It will not offer to place what this build cannot place.** Tier and
 * placeability are read off the compiled geometry. A `modelled` or `catalogued`
 * identity is findable, is shown, states why it cannot be placed, has no Place
 * control, and is not draggable. Arming a part goes through the workbench's own
 * `armPart`, which is the same path the palette uses; there is no second route
 * into the document.
 */

/** The slice of `WorkbenchApi` this panel uses. Structurally a subset of it. */
export interface PartSearchApi {
  /** Arms a catalog identity for click-to-place. False when it has no geometry. */
  armPart(definitionId: string): boolean
  notify(notice: { kind: 'success' | 'error' | 'info'; title: string; detail: string }): void
}

export type PartResolver = (query: string, options: ResolveOptions) => Promise<PartIntentResult>

export interface FindPartsPanelProps {
  api: PartSearchApi
  /** Injected by tests; the editor uses the real resolver. */
  resolve?: PartResolver
  /** Quiet period after the last keystroke before a query is issued. */
  debounceMs?: number
  limit?: number
}

/** Shortest request worth spending a corpus load on. */
const MIN_QUERY = 2

const EXAMPLE = 'a transparent windscreen about six studs wide'

type Phase =
  | { kind: 'blank' }
  | { kind: 'searching'; query: string }
  | { kind: 'ready'; result: PartIntentResult }
  | { kind: 'failed'; query: string; message: string }

export function FindPartsPanel({ api, resolve = resolvePartIntent, debounceMs = 250, limit = 8 }: FindPartsPanelProps) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'blank' })
  const [armed, setArmed] = useState<string | null>(null)
  const [attempt, retry] = useReducer((count: number) => count + 1, 0)
  const inFlight = useRef<AbortController | null>(null)
  const generation = useRef(0)

  const query = text.trim()

  useEffect(() => {
    if (query.length < MIN_QUERY) {
      // Abandon anything still running: a cleared field is a withdrawn question.
      inFlight.current?.abort()
      inFlight.current = null
      generation.current += 1
      setPhase({ kind: 'blank' })
      return
    }

    const timer = setTimeout(() => {
      // Superseded queries are cancelled, not merely ignored. The resolver
      // threads the signal into its fetches, so abandoning a half-typed
      // question stops the download it started as well as its result.
      inFlight.current?.abort()
      const controller = new AbortController()
      inFlight.current = controller
      const ticket = (generation.current += 1)

      setPhase({ kind: 'searching', query })
      void resolve(query, { limit, signal: controller.signal })
        .then((result) => {
          // Two guards, because they fail differently: the ticket rejects a
          // result whose question has been replaced, and the signal rejects one
          // whose fetch was cancelled but resolved anyway.
          if (ticket !== generation.current || controller.signal.aborted) return
          setPhase({ kind: 'ready', result })
        })
        .catch((cause: unknown) => {
          if (ticket !== generation.current || controller.signal.aborted) return
          if (cause instanceof DOMException && cause.name === 'AbortError') return
          setPhase({
            kind: 'failed',
            query,
            message: cause instanceof Error ? cause.message : String(cause),
          })
        })
    }, debounceMs)

    return () => clearTimeout(timer)
    // `attempt` is the retry token: re-running the effect is the retry, so the
    // failed query takes exactly the path the first one did.
  }, [query, resolve, debounceMs, limit, attempt])

  useEffect(() => () => inFlight.current?.abort(), [])

  const place = (match: PartIntentMatch) => {
    if (!match.placeable) return
    if (api.armPart(match.canonicalId)) {
      setArmed(match.canonicalId)
      api.notify({
        kind: 'info',
        title: `${nameOf(match.canonicalId)} is armed`,
        detail: 'Click in the viewport to place it. Esc puts it back.',
      })
    } else {
      // `armPart` refuses when the compiled geometry is missing. Reported, not
      // swallowed: the alternative is a button that appears to do nothing.
      api.notify({
        kind: 'error',
        title: 'That part could not be armed',
        detail: `${match.canonicalId} is a real catalog identity, but this build has no compiled geometry for it.`,
      })
    }
  }

  return (
    <div className="bw-find" data-testid="find-parts-panel">
      <label className="bw-find-eyebrow" htmlFor="bw-find-query">
        Describe the part you need
      </label>
      <div className="bw-find-row">
        <Search size={12} aria-hidden="true" />
        <input
          id="bw-find-query"
          className="bw-find-field"
          type="search"
          autoComplete="off"
          placeholder={EXAMPLE}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby="bw-find-help"
        />
      </div>
      <p className="bw-find-note" id="bw-find-help">
        Plain language, a part number, or a relationship — “the mirrored counterpart of wedge 41747”.
      </p>

      <div aria-live="polite" aria-atomic="true">
        {phase.kind === 'searching' && (
          <span className="bw-find-status" role="status">
            <Loader2 size={11} aria-hidden="true" /> Searching for “{phase.query}”…
          </span>
        )}
        {phase.kind === 'ready' && (
          <span className="bw-find-note">
            {phase.result.matches.length === 0
              ? 'No identity matched.'
              : `${phase.result.matches.length} ranked ${phase.result.matches.length === 1 ? 'identity' : 'identities'} in ${Math.round(phase.result.elapsedMs)} ms.`}
          </span>
        )}
      </div>

      {phase.kind === 'blank' && (
        <p className="bw-find-empty">
          {query.length === 0
            ? `Nothing has been asked yet. Try “${EXAMPLE}”.`
            : `Keep typing — ${MIN_QUERY} characters or more.`}
        </p>
      )}

      {phase.kind === 'failed' && (
        <div className="bw-find-error" role="alert">
          <strong>That search could not run</strong>
          <p className="bw-find-note">{phase.message}</p>
          <div>
            <button type="button" className="bw-find-btn" onClick={retry}>
              Try again
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'ready' && (
        <>
          <Interpretation result={phase.result} />
          {phase.result.matches.length === 0 ? (
            <p className="bw-find-empty">
              Nothing in this build’s catalogue matches “{phase.result.query}”. The interpretation
              above says which parts of the request were read and which were not.
            </p>
          ) : (
            <ul className="bw-find-list" aria-label="Ranked part matches">
              {phase.result.matches.map((match) => (
                <li key={match.canonicalId}>
                  <MatchCard match={match} armed={armed === match.canonicalId} onPlace={() => place(match)} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** What the resolver committed to, including what it could not satisfy. */
function Interpretation({ result }: { result: PartIntentResult }) {
  const { dimensions, category, colorName, connectorFamilies, unmatchedTerms } = result.interpretation
  const facts: Array<[string, string]> = []
  if (dimensions) facts.push(['Size', dimensions.map((value) => (value === 0 ? '·' : value)).join(' × ')])
  if (category) facts.push(['Category', category])
  if (colorName) facts.push(['Colour', colorName])
  if (connectorFamilies.length) facts.push(['Connectors', connectorFamilies.join(', ')])

  return (
    <>
      <div className="bw-find-interpretation">
        <span className="bw-find-eyebrow">Read as</span>
        {facts.length === 0 ? (
          <p className="bw-find-note">
            No size, category, colour or connector was stated, so the request was matched on its
            words alone.
          </p>
        ) : (
          <ul className="bw-find-facts">
            {facts.map(([label, value]) => (
              <li key={label} className="bw-find-fact">
                {label} <b>{value}</b>
              </li>
            ))}
          </ul>
        )}
      </div>

      {unmatchedTerms.length > 0 && (
        <div className="bw-find-unmatched" role="note" data-testid="find-unmatched">
          <span className="bw-find-eyebrow">
            <TriangleAlert size={10} aria-hidden="true" /> Could not be met
          </span>
          <ul className="bw-find-facts" aria-label="Conditions this build could not satisfy">
            {unmatchedTerms.map((term) => (
              <li key={term} className="bw-find-fact">
                {term}
              </li>
            ))}
          </ul>
          <p className="bw-find-note">
            The results below satisfy the rest of the request. Nothing here meets{' '}
            {unmatchedTerms.length === 1 ? 'that condition' : 'those conditions'}.
          </p>
        </div>
      )}
    </>
  )
}

const TIER_REASON: Record<PartIntentMatch['tier'], string | null> = {
  placeable: null,
  modelled:
    'Not placeable in this build: LDraw models this identity, but no compiled mesh for it ships here.',
  catalogued:
    'Not placeable in this build: the wider LEGO catalogue records this identity and nothing else is known about it.',
}

function MatchCard({
  match,
  armed,
  onPlace,
}: {
  match: PartIntentMatch
  armed: boolean
  onPlace: () => void
}) {
  const name = useMemo(() => nameOf(match.canonicalId), [match.canonicalId])
  const percent = Math.round(match.confidence * 100)
  const reason = TIER_REASON[match.tier]
  const signals = firedSignals(match)

  return (
    <div
      className="bw-find-match"
      data-testid={`find-match-${match.canonicalId}`}
      data-placeable={match.placeable}
      data-tier={match.tier}
      // Only what this build can place may be dragged into the viewport. The
      // payload matches the palette's, so a drop lands through the same handler.
      draggable={match.placeable}
      onDragStart={
        match.placeable
          ? (event) => {
              event.dataTransfer.setData('application/x-brickwright-part', match.canonicalId)
              event.dataTransfer.setData('text/plain', match.canonicalId)
              event.dataTransfer.effectAllowed = 'copy'
            }
          : undefined
      }
    >
      <div className="bw-find-match-head">
        <span className="bw-find-match-name">{name}</span>
        <span className="bw-find-tier" data-tier={match.tier}>
          {match.tier}
        </span>
      </div>
      <span className="bw-find-match-id">{match.canonicalId}</span>

      <div className="bw-find-confidence">
        <span className="bw-find-meter" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </span>
        <b aria-label={`Calibrated confidence ${percent} percent`}>{percent}%</b>
      </div>

      <p className="bw-find-explanation">{match.explanation}</p>

      {signals.length > 0 && (
        <ul className="bw-find-signals" aria-label={`Signals that fired for ${match.canonicalId}`}>
          {signals.map((signal) => (
            <li key={signal} className="bw-find-fact">
              {signal}
            </li>
          ))}
        </ul>
      )}

      {reason ? (
        <p className="bw-find-blocked">{reason}</p>
      ) : (
        <div>
          <button type="button" className="bw-find-btn" data-variant="primary" onClick={onPlace}>
            <Plus size={11} aria-hidden="true" /> {armed ? 'Armed — click the viewport' : 'Place'}
          </button>
        </div>
      )}
    </div>
  )
}

/** The signal names that actually contributed, for the one-line explanation. */
function firedSignals(match: PartIntentMatch): string[] {
  const fired: string[] = []
  if (match.signals.exactId) fired.push('exact identifier')
  if (match.signals.lexical > 0) fired.push('name match')
  if (match.signals.semantic > 0) fired.push('latent similarity')
  if (match.signals.dimensional > 0) fired.push('measured size')
  if (match.signals.connector > 0) fired.push('connector family')
  if (match.signals.frequency > 0) fired.push('set usage')
  return fired
}

/**
 * The catalogue's own name for an identity.
 *
 * Falls back to the id rather than inventing a label: a match with no
 * catalogue record is still a real answer, and a made-up name would be the one
 * part of the row a reader could not check.
 */
function nameOf(canonicalId: string): string {
  return catalog.describe(canonicalId)?.name ?? canonicalId
}
