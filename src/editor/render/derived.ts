/**
 * Derived viewport state, computed off the main thread when one is available.
 *
 * Isolation distance, island decomposition and component labelling are all
 * breadth-first walks over the connection graph. On a five-thousand-part model
 * each is only a few milliseconds — but a few milliseconds *on the frame's
 * critical path*, recomputed every time the operator changes a hop count, is
 * exactly the kind of cost that turns a smooth drag into a stutter.
 *
 * They are also pure functions of data that structured-clones cheaply: part ids
 * and connection endpoints, no geometry, no transforms. That makes them the
 * right — and honestly, the *only* — part of this renderer worth moving to a
 * worker. Anything touching compiled geometry or a BVH would have to ship
 * megabytes across the boundary per call, which costs more than it saves; that
 * work stays on the main thread and is bounded by scope instead (see
 * `sweep.ts`).
 *
 * The fallback is synchronous and shares the same function, so behaviour cannot
 * diverge between a browser with workers and a test environment without them.
 */

/** The projection of a document a derived computation needs. Structured-cloneable. */
export interface DerivedGraph {
  readonly partIds: readonly string[]
  /** Flat pairs: `[a0, b0, a1, b1, …]`, so the transfer is one array. */
  readonly edges: readonly string[]
}

export interface DerivedRequest {
  readonly id: number
  readonly graph: DerivedGraph
  readonly seedPartIds: readonly string[]
  readonly hops: number
}

export interface DerivedResponse {
  readonly id: number
  /** Part ids within `hops` connections of a seed, with their distance. */
  readonly withinHops: readonly string[]
  readonly distances: readonly number[]
  /** Component index per part, in `graph.partIds` order. */
  readonly components: readonly number[]
  readonly componentCount: number
  readonly computeMs: number
}

/** Adjacency as index lists, which is what makes the walks allocation-free. */
function indexGraph(graph: DerivedGraph): { index: Map<string, number>; adjacency: number[][] } {
  const index = new Map<string, number>()
  graph.partIds.forEach((partId, position) => index.set(partId, position))
  const adjacency: number[][] = graph.partIds.map(() => [])
  for (let pair = 0; pair + 1 < graph.edges.length; pair += 2) {
    const a = index.get(graph.edges[pair])
    const b = index.get(graph.edges[pair + 1])
    if (a === undefined || b === undefined) continue
    adjacency[a].push(b)
    adjacency[b].push(a)
  }
  return { index, adjacency }
}

/** The whole derived computation, shared by the worker and the fallback. */
export function computeDerived(request: DerivedRequest): DerivedResponse {
  const started = typeof performance !== 'undefined' ? performance.now() : 0
  const { index, adjacency } = indexGraph(request.graph)
  const count = request.graph.partIds.length

  const distance = new Int32Array(count).fill(-1)
  let frontier: number[] = []
  for (const seed of request.seedPartIds) {
    const position = index.get(seed)
    if (position === undefined || distance[position] >= 0) continue
    distance[position] = 0
    frontier.push(position)
  }
  const hops = Math.max(0, Math.floor(request.hops))
  for (let depth = 1; depth <= hops && frontier.length; depth += 1) {
    const next: number[] = []
    for (const node of frontier) {
      for (const neighbour of adjacency[node]) {
        if (distance[neighbour] >= 0) continue
        distance[neighbour] = depth
        next.push(neighbour)
      }
    }
    frontier = next
  }

  const withinHops: string[] = []
  const distances: number[] = []
  for (let position = 0; position < count; position += 1) {
    if (distance[position] < 0) continue
    withinHops.push(request.graph.partIds[position])
    distances.push(distance[position])
  }

  const components = new Int32Array(count).fill(-1)
  let componentCount = 0
  const stack: number[] = []
  for (let start = 0; start < count; start += 1) {
    if (components[start] >= 0) continue
    const label = componentCount
    componentCount += 1
    components[start] = label
    stack.length = 0
    stack.push(start)
    while (stack.length) {
      const node = stack.pop()!
      for (const neighbour of adjacency[node]) {
        if (components[neighbour] >= 0) continue
        components[neighbour] = label
        stack.push(neighbour)
      }
    }
  }

  return {
    id: request.id,
    withinHops,
    distances,
    components: Array.from(components),
    componentCount,
    computeMs: (typeof performance !== 'undefined' ? performance.now() : 0) - started,
  }
}

/**
 * Runs derived computations on a worker, falling back to synchronous execution.
 *
 * The fallback is not a degraded path: it is the same function on the same
 * input. What the worker buys is that the main thread is free while it runs, so
 * an operator sweeping a hop slider on a large model keeps their frame rate. If
 * a worker cannot be constructed — a test environment, a locked-down embed, a
 * browser that refused the module type — the feature still works and says so.
 */
export class DerivedRunner {
  private worker: Worker | null = null
  private pending = new Map<number, (response: DerivedResponse) => void>()
  private nextId = 1
  private failed = false

  constructor(private readonly enableWorker = true) {}

  /** Whether the last request actually ran off the main thread. */
  get mode(): 'worker' | 'synchronous' {
    return this.worker && !this.failed ? 'worker' : 'synchronous'
  }

  private ensureWorker(): Worker | null {
    if (!this.enableWorker || this.failed) return null
    if (this.worker) return this.worker
    if (typeof Worker === 'undefined') {
      this.failed = true
      return null
    }
    try {
      // `new URL(..., import.meta.url)` is the form the bundler recognises, so
      // the worker is emitted as its own chunk rather than inlined into the
      // viewport bundle.
      const worker = new Worker(new URL('./derivedWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<DerivedResponse>) => {
        const resolve = this.pending.get(event.data.id)
        if (!resolve) return
        this.pending.delete(event.data.id)
        resolve(event.data)
      }
      worker.onerror = () => {
        // One failure is enough: a worker that cannot start will not start on
        // the next call either, and retrying per request would add a rejected
        // module fetch to every interaction.
        this.failed = true
        for (const [, resolve] of this.pending) resolve
        this.pending.clear()
      }
      this.worker = worker
      return worker
    } catch {
      this.failed = true
      return null
    }
  }

  async run(graph: DerivedGraph, seedPartIds: readonly string[], hops: number): Promise<DerivedResponse> {
    const id = this.nextId
    this.nextId += 1
    const request: DerivedRequest = { id, graph, seedPartIds, hops }
    const worker = this.ensureWorker()
    if (!worker) return computeDerived(request)
    return new Promise<DerivedResponse>((resolve) => {
      this.pending.set(id, resolve)
      try {
        worker.postMessage(request)
      } catch {
        this.pending.delete(id)
        this.failed = true
        resolve(computeDerived(request))
      }
    })
  }

  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.pending.clear()
  }
}

/** Builds the transferable projection from a document-shaped object. */
export function graphOf(document: {
  parts: Record<string, unknown>
  connections: Record<string, { a: { partId: string }; b: { partId: string } }>
}): DerivedGraph {
  const edges: string[] = []
  for (const edge of Object.values(document.connections)) {
    edges.push(edge.a.partId, edge.b.partId)
  }
  return { partIds: Object.keys(document.parts), edges }
}
