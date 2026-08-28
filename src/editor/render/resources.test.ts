import { describe, expect, it } from 'vitest'
import { disposeOwnedTree, ResourceRegistry, type Disposable } from './resources'

class Probe implements Disposable {
  disposals = 0
  dispose() {
    this.disposals += 1
  }
}

describe('resource ownership', () => {
  it('counts what is live, by kind', () => {
    const registry = new ResourceRegistry()
    registry.track('scope', 'geometry', new Probe())
    registry.track('scope', 'material', new Probe())
    registry.track('scope', 'material', new Probe())
    expect(registry.counts()).toMatchObject({ geometry: 1, material: 2, total: 3 })
  })

  it('frees a whole scope, which is what an effect’s cleanup needs', () => {
    const registry = new ResourceRegistry()
    const kept = new Probe()
    const dropped = [new Probe(), new Probe()]
    registry.track('keep', 'texture', kept)
    for (const probe of dropped) registry.track('drop', 'renderTarget', probe)
    expect(registry.releaseScope('drop')).toBe(2)
    expect(dropped.every((probe) => probe.disposals === 1)).toBe(true)
    expect(kept.disposals).toBe(0)
    expect(registry.liveCount).toBe(1)
  })

  it('does not grow across a hundred cycles of the same allocation', () => {
    // This is the shape of the leak the registry exists to catch: a per-frame
    // or per-selection allocation that is never released grows quietly for an
    // hour and then the tab is using two gigabytes.
    const registry = new ResourceRegistry()
    const baseline = registry.counts().total
    for (let cycle = 0; cycle < 100; cycle += 1) {
      registry.track('selection', 'material', new Probe())
      registry.track('selection', 'geometry', new Probe())
      registry.releaseScope('selection')
    }
    expect(registry.counts().total).toBe(baseline)
    expect(registry.disposedCount).toBe(200)
    expect(registry.byScope()).toEqual({})
  })

  it('is safe to release twice', () => {
    const registry = new ResourceRegistry()
    const probe = new Probe()
    registry.track('scope', 'other', probe)
    expect(registry.release(probe)).toBe(true)
    expect(registry.release(probe)).toBe(false)
    expect(probe.disposals).toBe(1)
  })

  it('ignores a double registration rather than double-counting', () => {
    const registry = new ResourceRegistry()
    const probe = new Probe()
    registry.track('a', 'geometry', probe)
    registry.track('b', 'geometry', probe)
    expect(registry.counts().total).toBe(1)
  })

  it('reports live resources per scope, so a leak names its owner', () => {
    const registry = new ResourceRegistry()
    registry.track('id-pass', 'renderTarget', new Probe())
    registry.track('environment', 'texture', new Probe())
    registry.track('environment', 'texture', new Probe())
    expect(registry.byScope()).toEqual({ 'id-pass': 1, environment: 2 })
  })

  it('frees everything on teardown', () => {
    const registry = new ResourceRegistry()
    for (const scope of ['a', 'b', 'c']) registry.track(scope, 'geometry', new Probe())
    expect(registry.releaseAll()).toBe(3)
    expect(registry.liveCount).toBe(0)
  })

  it('still disposes when a resource throws on the way out', () => {
    const registry = new ResourceRegistry()
    const angry = {
      dispose() {
        throw new Error('driver said no')
      },
    }
    expect(() => registry.release(registry.track('scope', 'other', angry))).toThrow()
    // The registry has still forgotten it: a resource that throws must not be
    // retried forever or counted as live.
    expect(registry.liveCount).toBe(0)
  })
})

describe('tree disposal', () => {
  it('frees a tree’s own geometries and materials', () => {
    const geometry = new Probe()
    const material = new Probe()
    const tree = {
      traverse(callback: (node: unknown) => void) {
        callback({ geometry, material })
      },
    }
    expect(disposeOwnedTree(tree)).toBe(2)
  })

  it('leaves shared resources alone', () => {
    // The geometry cache hands the same buffer to every instance of a
    // definition, so disposing it because one batch unmounted would blank every
    // other batch using that part.
    const shared = new Probe()
    const owned = new Probe()
    const tree = {
      traverse(callback: (node: unknown) => void) {
        callback({ geometry: shared, material: [owned] })
      },
    }
    expect(disposeOwnedTree(tree, (resource) => resource === shared)).toBe(1)
    expect(shared.disposals).toBe(0)
    expect(owned.disposals).toBe(1)
  })
})
