import { CircleAlert, CloudOff, LoaderCircle, PackageOpen, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The states an editor is in when it is not simply working.
 *
 * Each of these is a designed surface rather than a blank area, because every
 * one of them is a moment where the operator is asking "is it broken, or am I?"
 * and the answer has to be on screen.
 */

/** Nothing placed yet. Offers the one action that gets past it. */
export function EmptyBuildState({ onPickStarter }: { onPickStarter: () => void }) {
  return (
    <div className="viewport-empty" data-state="empty">
      <div className="viewport-empty-mark" aria-hidden="true"><span /><span /><span /></div>
      <strong>Nothing placed yet</strong>
      <p>
        Choose a part on the left, then click here to drop it. Placement is solved against the part's real
        LDraw connectors, so the first brick sets the frame everything else mates into.
      </p>
      <button onClick={onPickStarter}>Pick a starter brick</button>
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
