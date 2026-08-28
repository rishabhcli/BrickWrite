import { Crosshair, X } from 'lucide-react'
import type { WorkbenchApi } from '../editor/workbench'
import { useRefineState } from './RefinePanel'
import { selectedProposal, type RefinementSession } from './session'
import { CHANGE_KINDS, type ChangeKind } from './types'
import './panel.css'

/**
 * The changed-part heatmap, over the viewport.
 *
 * The engine already emits exactly what this draws: one `OverlayInstruction` per
 * touched part, carrying the kind of change, an absolute 0–1 magnitude and a
 * sentence describing it. This surface renders that vector and drives the real
 * 3-D highlight through `api.select`, which is the only honest way to point at a
 * part from here — the overlay slot has no access to the renderer's camera, so
 * projecting `atLdu` into screen space would be a guess drawn to three decimal
 * places.
 */

const KIND_COLOUR: Record<ChangeKind, string> = {
  added: 'var(--bw-r-green)',
  removed: 'var(--bw-r-red)',
  moved: 'var(--bw-r-cyan)',
  recolored: 'var(--bw-r-orange)',
  substituted: 'var(--bw-r-orange)',
  reassigned: 'var(--bw-r-muted)',
}

export function RefineOverlay({ api, session }: { api: WorkbenchApi; session: RefinementSession }) {
  const state = useRefineState(session)
  const proposal = selectedProposal(state)
  if (!proposal || proposal.status !== 'ranked' || !proposal.overlay.length) return null

  const kinds = CHANGE_KINDS.filter((kind) => proposal.overlay.some((entry) => entry.changeKind === kind))

  return (
    <aside className="bw-refine-overlay bw-refine" aria-label="Changed parts heatmap">
      <div className="bw-refine-overlay__head">
        <span>Changed parts · {proposal.overlay.length}</span>
        <button
          className="bw-refine__btn"
          onClick={() => session.select(null)}
          aria-label="Hide the changed-part heatmap"
        >
          <X size={10} aria-hidden="true" />
        </button>
      </div>
      <div className="bw-refine-overlay__legend">
        {kinds.map((kind) => (
          <span className="bw-refine-overlay__key" key={kind}>
            <i style={{ background: KIND_COLOUR[kind] }} aria-hidden="true" />
            {kind}
          </span>
        ))}
      </div>
      <ul className="bw-refine-overlay__list">
        {proposal.overlay.map((entry) => (
          <li key={entry.partId}>
            <button
              className="bw-refine-overlay__row"
              onClick={() => {
                api.select([entry.partId])
                api.frameSelection()
              }}
              aria-label={`Focus ${entry.partId}: ${entry.changeKind}, magnitude ${entry.magnitude.toFixed(2)}. ${entry.detail}`}
            >
              <span className="bw-refine-overlay__part">{entry.partId}</span>
              <span className="bw-refine-overlay__magnitude">{entry.magnitude.toFixed(2)}</span>
              <span className="bw-refine-overlay__heat" aria-hidden="true">
                <i
                  style={{
                    width: `${Math.round(entry.magnitude * 100)}%`,
                    background: KIND_COLOUR[entry.changeKind],
                  }}
                />
              </span>
              <span className="bw-refine-overlay__detail">{entry.detail}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="bw-refine-overlay__foot">
        <button
          className="bw-refine__btn"
          onClick={() => {
            api.select(proposal.changedPartIds)
            api.frameSelection()
          }}
        >
          <Crosshair size={10} aria-hidden="true" /> Frame all {proposal.changedPartIds.length}
        </button>
      </div>
    </aside>
  )
}
