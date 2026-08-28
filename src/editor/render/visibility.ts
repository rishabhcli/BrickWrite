/**
 * What the viewport is showing, and what it is only implying.
 *
 * A dense model hides itself. Once a facade is up, everything structural behind
 * it is unreachable by eye and unpickable by cursor, and the usual answer —
 * "hide the parts you do not want" — asks the operator to name parts they
 * cannot see. Isolation by *connection distance* asks the question the model
 * can already answer: show me this part, and everything within N connections of
 * it. The connection graph is authoritative (`document.connections`), so the
 * neighbourhood is the assembly's own, not a distance in space that would drag
 * in whatever happens to be nearby.
 *
 * Everything outside the isolated set is ghosted rather than deleted from the
 * frame, because a subassembly floating in a void is much harder to place than
 * one sitting inside a faint outline of the model it belongs to.
 */

import type { ModelDocument } from '../../cad/types'

export interface IsolationRequest {
  /** Parts to isolate around. Empty means "nothing is isolated". */
  readonly seedPartIds: readonly string[]
  /** Connections to walk outward. 0 is the seeds alone. */
  readonly hops: number
}

export interface IsolationResult {
  /** Parts drawn at full fidelity. */
  readonly visible: ReadonlySet<string>
  /** Hop count per included part, so the UI can shade by distance. */
  readonly distance: ReadonlyMap<string, number>
  /** True when nothing is isolated and the whole model is at full fidelity. */
  readonly inactive: boolean
}

const EMPTY_ISOLATION: IsolationResult = {
  visible: new Set(),
  distance: new Map(),
  inactive: true,
}

/**
 * Undirected adjacency over committed connection edges.
 *
 * Memoized on document identity in a `WeakMap`, matching the kernel's own
 * convention for derived world state: a document is immutable per revision, so
 * a cached adjacency can never be stale and there is no invalidation path to
 * get wrong.
 */
const adjacencyCache = new WeakMap<ModelDocument, Map<string, string[]>>()

export function connectionAdjacency(document: ModelDocument): Map<string, string[]> {
  const cached = adjacencyCache.get(document)
  if (cached) return cached
  const adjacency = new Map<string, string[]>()
  for (const partId of Object.keys(document.parts)) adjacency.set(partId, [])
  for (const edge of Object.values(document.connections)) {
    adjacency.get(edge.a.partId)?.push(edge.b.partId)
    adjacency.get(edge.b.partId)?.push(edge.a.partId)
  }
  adjacencyCache.set(document, adjacency)
  return adjacency
}

/** Breadth-first walk of the connection graph, capped at `hops`. */
export function isolateByHops(document: ModelDocument, request: IsolationRequest): IsolationResult {
  const seeds = request.seedPartIds.filter((id) => Boolean(document.parts[id]))
  if (!seeds.length) return EMPTY_ISOLATION
  const adjacency = connectionAdjacency(document)
  const distance = new Map<string, number>()
  let frontier: string[] = []
  for (const seed of seeds) {
    if (distance.has(seed)) continue
    distance.set(seed, 0)
    frontier.push(seed)
  }
  const hops = Math.max(0, Math.floor(request.hops))
  for (let depth = 1; depth <= hops && frontier.length; depth += 1) {
    const next: string[] = []
    for (const partId of frontier) {
      for (const neighbour of adjacency.get(partId) ?? []) {
        if (distance.has(neighbour)) continue
        distance.set(neighbour, depth)
        next.push(neighbour)
      }
    }
    frontier = next
  }
  return { visible: new Set(distance.keys()), distance, inactive: false }
}

/**
 * How a part outside the isolated set is drawn.
 *
 * `ghost` keeps it on screen as context; `hidden` removes it from the frame
 * entirely, which is what a section drawing or a screenshot of one subassembly
 * wants. Both remove it from *picking*, because a part the operator has pushed
 * into the background should not be what their click lands on.
 */
export type OutsideTreatment = 'ghost' | 'hidden'

export interface VisibilityState {
  readonly isolation: IsolationRequest | null
  readonly outside: OutsideTreatment
  /** 0 (invisible) to 1 (solid) for ghosted context. */
  readonly ghostOpacity: number
  /** Parts explicitly hidden by the operator, independent of isolation. */
  readonly hiddenPartIds: ReadonlySet<string>
}

export const DEFAULT_VISIBILITY: VisibilityState = {
  isolation: null,
  outside: 'ghost',
  ghostOpacity: 0.12,
  hiddenPartIds: new Set(),
}

export interface ResolvedVisibility {
  /** Fully drawn and pickable. */
  readonly solid: ReadonlySet<string>
  /** Drawn faintly, never picked. */
  readonly ghosted: ReadonlySet<string>
  /** Not drawn at all. */
  readonly hidden: ReadonlySet<string>
  readonly ghostOpacity: number
  readonly distance: ReadonlyMap<string, number>
}

/** Splits the document's parts into the three drawing classes. */
export function resolveVisibility(document: ModelDocument, state: VisibilityState): ResolvedVisibility {
  const isolation = state.isolation ? isolateByHops(document, state.isolation) : EMPTY_ISOLATION
  const solid = new Set<string>()
  const ghosted = new Set<string>()
  const hidden = new Set<string>()
  for (const partId of Object.keys(document.parts)) {
    if (state.hiddenPartIds.has(partId)) {
      hidden.add(partId)
      continue
    }
    if (isolation.inactive || isolation.visible.has(partId)) {
      solid.add(partId)
      continue
    }
    if (state.outside === 'hidden') hidden.add(partId)
    else ghosted.add(partId)
  }
  return {
    solid,
    ghosted,
    hidden,
    ghostOpacity: Math.min(1, Math.max(0, state.ghostOpacity)),
    distance: isolation.distance,
  }
}

// ---------------------------------------------------------------------------
// Named views
// ---------------------------------------------------------------------------

/**
 * A saved viewpoint.
 *
 * Stored as position, target and zoom rather than as a matrix so that restoring
 * one can be *eased* — interpolating two camera matrices produces a path that
 * swings through the model, while interpolating an orbit's position and target
 * produces the arc the operator would have flown by hand.
 */
export interface NamedView {
  readonly name: string
  readonly position: readonly [number, number, number]
  readonly target: readonly [number, number, number]
  readonly zoom: number
  /** Whether the camera was orthographic, so a restore does not silently swap projection. */
  readonly orthographic: boolean
  readonly savedAt: string
}

/**
 * Named views, in insertion order, with a bounded history.
 *
 * Bounded because these are persisted alongside the session and an unbounded
 * list of viewpoints is a slow leak of storage nobody asked for. Saving over an
 * existing name replaces it in place, keeping its position in the list — the
 * operator's mental order of their own views should not shuffle.
 */
export class NamedViewStore {
  private views: NamedView[] = []

  constructor(private readonly limit = 32) {}

  save(view: NamedView): NamedView {
    const index = this.views.findIndex((entry) => entry.name === view.name)
    if (index >= 0) this.views[index] = view
    else {
      this.views.push(view)
      if (this.views.length > this.limit) this.views.shift()
    }
    return view
  }

  get(name: string): NamedView | null {
    return this.views.find((entry) => entry.name === name) ?? null
  }

  remove(name: string): boolean {
    const index = this.views.findIndex((entry) => entry.name === name)
    if (index < 0) return false
    this.views.splice(index, 1)
    return true
  }

  list(): readonly NamedView[] {
    return [...this.views]
  }

  clear() {
    this.views = []
  }
}
