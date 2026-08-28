/**
 * Ownership tracking for GPU resources.
 *
 * Three.js will happily let a component allocate a geometry, a material or a
 * render target and then drop the reference. The JavaScript object is collected;
 * the GPU allocation behind it is not, because the WebGL context still holds it.
 * A leak of that shape does not crash — it grows, slowly, across an hour of
 * selecting and deselecting, until the tab is using two gigabytes and the
 * operator blames the model.
 *
 * The mitigation is not vigilance. It is making ownership explicit and then
 * *asserting* on it: every resource the renderer creates is registered against a
 * scope, scopes are released in the effect that created them, and a test can
 * read the live count and require that a hundred selection cycles end where they
 * started.
 */

export interface Disposable {
  dispose(): void
}

export type ResourceKind = 'geometry' | 'material' | 'texture' | 'renderTarget' | 'other'

interface Entry {
  readonly kind: ResourceKind
  readonly resource: Disposable
  readonly label: string
}

export interface ResourceCounts {
  readonly geometry: number
  readonly material: number
  readonly texture: number
  readonly renderTarget: number
  readonly other: number
  readonly total: number
}

const EMPTY_COUNTS: ResourceCounts = { geometry: 0, material: 0, texture: 0, renderTarget: 0, other: 0, total: 0 }

/**
 * A registry of everything the renderer allocated and has not yet released.
 *
 * Scopes are named so that a leak report says *which* subsystem leaked rather
 * than that something did. That distinction is the difference between a
 * five-minute fix and an afternoon.
 */
export class ResourceRegistry {
  private entries = new Map<Disposable, Entry>()
  private scopes = new Map<string, Set<Disposable>>()
  private disposedTotal = 0

  /** Registers a resource under a scope, returning it for direct assignment. */
  track<T extends Disposable>(scope: string, kind: ResourceKind, resource: T, label = scope): T {
    if (this.entries.has(resource)) return resource
    this.entries.set(resource, { kind, resource, label })
    let bucket = this.scopes.get(scope)
    if (!bucket) {
      bucket = new Set()
      this.scopes.set(scope, bucket)
    }
    bucket.add(resource)
    return resource
  }

  /** Disposes one resource and forgets it. Safe to call twice. */
  release(resource: Disposable): boolean {
    const entry = this.entries.get(resource)
    if (!entry) return false
    this.entries.delete(resource)
    for (const [, bucket] of this.scopes) bucket.delete(resource)
    try {
      resource.dispose()
    } finally {
      this.disposedTotal += 1
    }
    return true
  }

  /** Disposes everything in a scope. This is what an effect's cleanup calls. */
  releaseScope(scope: string): number {
    const bucket = this.scopes.get(scope)
    if (!bucket) return 0
    let count = 0
    for (const resource of [...bucket]) {
      if (this.release(resource)) count += 1
    }
    this.scopes.delete(scope)
    return count
  }

  releaseAll(): number {
    let count = 0
    for (const scope of [...this.scopes.keys()]) count += this.releaseScope(scope)
    // Anything registered without ever landing in a scope map still gets freed.
    for (const resource of [...this.entries.keys()]) if (this.release(resource)) count += 1
    return count
  }

  counts(): ResourceCounts {
    const totals = { ...EMPTY_COUNTS } as { -readonly [K in keyof ResourceCounts]: number }
    for (const entry of this.entries.values()) {
      totals[entry.kind] += 1
      totals.total += 1
    }
    return totals
  }

  /** Live resources per scope, which is what a leak report needs to be useful. */
  byScope(): Record<string, number> {
    const report: Record<string, number> = {}
    for (const [scope, bucket] of this.scopes) if (bucket.size) report[scope] = bucket.size
    return report
  }

  get disposedCount(): number {
    return this.disposedTotal
  }

  get liveCount(): number {
    return this.entries.size
  }
}

/**
 * The renderer's registry.
 *
 * A module singleton rather than context, because disposal has to work from
 * places React is not: a context-loss handler, an imperative capture path, and
 * the acceptance run's probe all need to reach it without a component tree.
 */
export const rendererResources = new ResourceRegistry()

/**
 * Disposes a three.js object tree's own geometries and materials.
 *
 * Used on context loss and on unmount for trees the registry does not own —
 * anything drei allocated internally, for instance. Shared resources are
 * deliberately *not* disposed here: the geometry cache hands the same buffer to
 * every instance of a definition, so disposing it because one batch unmounted
 * would blank every other batch using that part.
 */
export function disposeOwnedTree(
  root: { traverse(callback: (node: unknown) => void): void },
  isShared: (resource: Disposable) => boolean = () => false,
): number {
  let disposed = 0
  const dispose = (resource: Disposable | undefined) => {
    if (!resource || isShared(resource)) return
    resource.dispose()
    disposed += 1
  }
  root.traverse((node) => {
    const candidate = node as { geometry?: Disposable; material?: Disposable | Disposable[] }
    dispose(candidate.geometry)
    if (Array.isArray(candidate.material)) for (const material of candidate.material) dispose(material)
    else dispose(candidate.material)
  })
  return disposed
}
