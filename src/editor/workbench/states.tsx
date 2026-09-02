import { CircleAlert, CloudOff, LoaderCircle, PackageOpen, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { session } from '../../cad/session'

/**
 * The states an editor is in when it is not simply working.
 *
 * Each of these is a designed surface rather than a blank area, because every
 * one of them is a moment where the operator is asking "is it broken, or am I?"
 * and the answer has to be on screen.
 */

/**
 * Nothing placed yet. Offers the one action that gets past it.
 *
 * The button puts a brick down rather than arming one. Arming left the viewport
 * looking untouched until the pointer happened to cross it — the first thing a
 * newcomer does here appearing to do nothing — and it cost a second click to
 * finish. One press now lands a brick, selected, with its handles already up.
 * How to place the *next* one is the sentence above it.
 */
type Starter = { id: string; title: string; parts: number }

/**
 * The library is fetched here rather than imported.
 *
 * `src/demos` carries the full generated manifest, and the editor's critical
 * chunk has no reason to hold a hundred kilobytes of showcase metadata for a
 * panel that only appears over an empty document. Loading it on mount keeps
 * the cost where the panel is.
 */
function useStarters(): Starter[] {
  const [starters, setStarters] = useState<Starter[]>([])
  useEffect(() => {
    let live = true
    void import('../../demos').then(({ DEMOS }) => {
      if (!live) return
      setStarters(
        DEMOS.slice(0, 3).map((demo) => ({ id: demo.id, title: demo.title, parts: demo.validation.partCount })),
      )
    })
    return () => { live = false }
  }, [])
  return starters
}

export function EmptyBuildState({ onPickStarter }: { onPickStarter: () => void }) {
  const starters = useStarters()
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)

  const open = async (id: string) => {
    if (busy.current) return
    busy.current = true
    setOpening(id)
    setError(null)
    try {
      const [{ getDemo }, { forkDemo }] = await Promise.all([import('../../demos'), import('../../demos/fork')])
      const demo = getDemo(id)
      if (!demo) {
        setError('That build is not in this copy of the library.')
        return
      }
      const outcome = await forkDemo(demo)
      if (outcome.ok) await session.openProject(outcome.projectId)
      else setError(outcome.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open that build.')
    } finally {
      busy.current = false
      setOpening(null)
    }
  }

  return (
    <div className="viewport-empty" data-state="empty">
      <div className="viewport-empty-mark" aria-hidden="true"><span /><span /><span /></div>
      <strong>Drag a part here</strong>
      <p>Drop from the palette, or start with a 2×4 brick.</p>
      <button type="button" onClick={onPickStarter}>Start with a brick</button>
      {starters.length > 0 && (
        <div className="viewport-empty-starters">
          <span>or open a build</span>
          {starters.map((starter) => (
            <button
              type="button"
              key={starter.id}
              className="viewport-empty-starter"
              disabled={opening !== null}
              onClick={() => void open(starter.id)}
            >
              {opening === starter.id ? 'Opening…' : starter.title}
              <small>{starter.parts.toLocaleString()} parts</small>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="viewport-empty-error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}

/** Work in flight that the operator should not mistake for a stall. */
export function BusyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="viewport-state busy" role="status" aria-live="polite" data-state="loading">
      <LoaderCircle size={22} className="spin" />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  )
}

/**
 * A control that needs a different selection than the one that exists.
 *
 * It says what is selected, what is needed and how to get there, rather than
 * greying out and leaving the operator to guess.
 */
export function InvalidSelectionState({
  have,
  need,
  action,
}: {
  have: string
  need: string
  action?: ReactNode
}) {
  return (
    <div className="workbench-state invalid-selection" role="note" data-state="invalid-selection">
      <CircleAlert size={16} />
      <div>
        <strong>{need}</strong>
        <p>Currently {have}.</p>
      </div>
      {action}
    </div>
  )
}

/**
 * A catalogue identity this build cannot place.
 *
 * The distinction matters and is stated: LDraw may model the part while this
 * build carries no compiled mesh, or the wider catalogue may only record that
 * the part exists at all.
 */
export function UnavailablePartState({
  name,
  tier,
  onWidenSearch,
}: {
  name: string
  tier: 'modelled' | 'catalogued'
  onWidenSearch?: () => void
}) {
  return (
    <div className="workbench-state unavailable-part" role="note" data-state="unavailable-part">
      <PackageOpen size={16} />
      <div>
        <strong>{name} cannot be placed</strong>
        <p>
          {tier === 'modelled'
            ? 'LDraw models this part, but this build carries no compiled mesh for it. Nothing is substituted in its place.'
            : 'The wider LEGO catalogue records that this part exists. Nothing about its shape is known here, so it cannot be built with.'}
        </p>
      </div>
      {onWidenSearch && <button type="button" onClick={onWidenSearch}>Find a buildable equivalent</button>}
    </div>
  )
}

/** The network is gone. Says what still works, which is nearly everything. */
export function OfflineState({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="workbench-state offline" role="status" data-state="offline">
      <CloudOff size={16} />
      <div>
        <strong>No network</strong>
        <p>
          The catalogue, the kernel, validation and every export run locally, so editing is unaffected. Cloud
          projects and the assistant will reconnect on their own.
        </p>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss the offline notice">Dismiss</button>
    </div>
  )
}

/** A pending agent proposal, awaiting an explicit accept or reject. */
export function ProposalReviewState({
  label,
  operations,
  collisions,
  onAccept,
  onReject,
}: {
  label: string
  operations: number
  collisions: number
  onAccept: () => void
  onReject: () => void
}) {
  return (
    <div className="workbench-state proposal-review" role="alertdialog" aria-label="Agent proposal" data-state="proposal-review">
      <Sparkles size={16} />
      <div>
        <strong>{label}</strong>
        <p>
          {operations} operation{operations === 1 ? '' : 's'} · {collisions} collision{collisions === 1 ? '' : 's'} in the
          preview. Nothing is committed until you accept.
        </p>
      </div>
      <button type="button" className="proposal-accept" onClick={onAccept}>Accept</button>
      <button type="button" onClick={onReject}>Reject</button>
    </div>
  )
}
