import type { PublishedDocument } from '../types'

/**
 * The viewer's entire mutable state.
 *
 * It is a plain object behind a pure reducer, and it describes *how the model is
 * being looked at* — never the model itself. That separation is the structural
 * reason the public viewer cannot mutate a project: there is no action in this
 * union that touches a part, and there is no engine, command bus or repository
 * handle anywhere in `viewer/`. The snapshot it renders arrives frozen from the
 * publication and is never written back to anything.
 */

export interface ViewerState {
  /** Degrees, wrapped to [0, 360). */
  yaw: number
  /** Degrees, clamped so the model never flips through the pole. */
  pitch: number
  /** 0.4–3.0 multiplier on the fitted scale. */
  zoom: number
  /** 0 assembled, 1 fully exploded. */
  explode: number
  /**
   * Which step is being shown. `null` means the finished model; otherwise it is
   * a 1-based index into the published steps.
   */
  step: number | null
  /** True while a pointer is dragging, so the canvas can render cheaply. */
  dragging: boolean
}

export type ViewerAction =
  | { type: 'orbit'; deltaYaw: number; deltaPitch: number }
  | { type: 'set-orbit'; yaw: number; pitch: number }
  | { type: 'zoom'; delta: number }
  | { type: 'explode'; value: number }
  | { type: 'step'; value: number | null }
  | { type: 'step-delta'; delta: number; stepCount: number }
  | { type: 'drag'; dragging: boolean }
  | { type: 'reset' }

export const INITIAL_VIEWER_STATE: Readonly<ViewerState> = Object.freeze({
  yaw: 0,
  pitch: 0,
  zoom: 1,
  explode: 0,
  step: null,
  dragging: false,
})

const wrap = (value: number) => {
  if (!Number.isFinite(value)) return 0
  const wrapped = value % 360
  return (wrapped < 0 ? wrapped + 360 : wrapped) + 0
}
const clamp = (value: number, low: number, high: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case 'orbit':
      return {
        ...state,
        yaw: wrap(state.yaw + action.deltaYaw),
        // Pitch stops short of vertical. Passing through the pole flips the
        // horizon and there is no recovery gesture that feels right afterwards.
        pitch: clamp(state.pitch + action.deltaPitch, -80, 80, state.pitch),
      }
    case 'set-orbit':
      return { ...state, yaw: wrap(action.yaw), pitch: clamp(action.pitch, -80, 80, state.pitch) }
    case 'zoom':
      return { ...state, zoom: clamp(state.zoom * Math.exp(action.delta), 0.4, 3, state.zoom) }
    case 'explode':
      return { ...state, explode: clamp(action.value, 0, 1, state.explode) }
    case 'step':
      return { ...state, step: action.value === null ? null : Math.max(1, Math.round(action.value)) }
    case 'step-delta': {
      if (action.stepCount <= 0) return state
      // Stepping forward from the finished model wraps to the first step, and
      // stepping back from step 1 returns to the finished model. That makes the
      // arrow keys a loop with an obvious home position.
      const current = state.step ?? action.stepCount
      const next = current + action.delta
      if (next < 1) return { ...state, step: null }
      if (next > action.stepCount) return { ...state, step: null }
      return { ...state, step: next }
    }
    case 'drag':
      return state.dragging === action.dragging ? state : { ...state, dragging: action.dragging }
    case 'reset':
      return { ...INITIAL_VIEWER_STATE }
    default:
      return state
  }
}

/**
 * Which parts are visible, and which the current step introduces.
 *
 * Returns `null` for "everything", so the caller can skip building a set of
 * every part id on the common path.
 */
export function stepSelection(
  document: PublishedDocument,
  step: number | null,
): { include: Set<string> | null; highlight: Set<string> | null } {
  if (step === null || !document.steps.length) return { include: null, highlight: null }
  const include = new Set<string>()
  let highlight: Set<string> | null = null
  for (const entry of document.steps) {
    if (entry.index > step) break
    for (const partId of entry.partIds) include.add(partId)
    if (entry.index === step) highlight = new Set(entry.partIds)
  }
  return { include, highlight: highlight ?? new Set() }
}

/** Human label for the current step, for the scrubber's live region. */
export function describeStep(document: PublishedDocument, step: number | null): string {
  if (step === null) return `Finished model, ${document.parts.length} parts`
  const entry = document.steps.find((candidate) => candidate.index === step)
  if (!entry) return `Step ${step}`
  const placed = document.steps
    .filter((candidate) => candidate.index <= step)
    .reduce((total, candidate) => total + candidate.partIds.length, 0)
  return `Step ${entry.index} of ${document.steps.length}: ${entry.name}. ${entry.partIds.length} new, ${placed} placed.`
}
