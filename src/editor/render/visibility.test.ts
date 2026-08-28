import { describe, expect, it } from 'vitest'
import { CadEngine } from '../../cad/engine'
import { IDENTITY_BASIS, type Mat3 } from '../../cad/math'
import { createEmptyDocument } from '../../cad/sample'
import type { CadOperation, ModelDocument, PartInstance } from '../../cad/types'
import {
  connectionAdjacency,
  DEFAULT_VISIBILITY,
  isolateByHops,
  NamedViewStore,
  resolveVisibility,
} from './visibility'

const part = (id: string, definitionId: string, position: [number, number, number], basis: Mat3 = IDENTITY_BASIS): PartInstance => ({
  id,
  definitionId,
  color: 71,
  transform: { position, basis },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/** Builds through the engine so the connection edges under test are real ones. */
function assemble(parts: PartInstance[]): ModelDocument {
  const engine = new CadEngine(createEmptyDocument())
  let revision = engine.getSnapshot().document.revision
  for (const item of parts) {
    const operations: CadOperation[] = [{ type: 'part.add', part: item }]
    const result = engine.execute(`Place ${item.id}`, operations, 'human', revision)
    if (result.ok) revision = result.value.resultRevision
  }
  return engine.getSnapshot().document
}

/** A five-brick tower plus one part standing on its own, well clear of it. */
const tower = () =>
  assemble([
    part('a', '3001', [0, 0, 0]),
    part('b', '3001', [0, -24, 0]),
    part('c', '3001', [0, -48, 0]),
    part('d', '3001', [0, -72, 0]),
    part('loose', '3001', [600, 0, 0]),
  ])

describe('isolation by connection distance', () => {
  it('walks the connection graph, not proximity', () => {
    const document = tower()
    const one = isolateByHops(document, { seedPartIds: ['a'], hops: 1 })
    expect([...one.visible].sort()).toEqual(['a', 'b'])
    const two = isolateByHops(document, { seedPartIds: ['a'], hops: 2 })
    expect([...two.visible].sort()).toEqual(['a', 'b', 'c'])
  })

  it('reports the hop count per part, so a UI can shade by distance', () => {
    const document = tower()
    const result = isolateByHops(document, { seedPartIds: ['a'], hops: 3 })
    expect(result.distance.get('a')).toBe(0)
    expect(result.distance.get('b')).toBe(1)
    expect(result.distance.get('d')).toBe(3)
  })

  it('never reaches a part that is not connected, at any hop count', () => {
    // This is the property that makes isolation trustworthy: a part sitting
    // beside the tower but attached to nothing is not "near" it in the sense
    // the assembly cares about.
    const document = tower()
    expect(isolateByHops(document, { seedPartIds: ['a'], hops: 99 }).visible.has('loose')).toBe(false)
  })

  it('treats an empty or unknown seed as no isolation at all', () => {
    const document = tower()
    expect(isolateByHops(document, { seedPartIds: [], hops: 3 }).inactive).toBe(true)
    expect(isolateByHops(document, { seedPartIds: ['ghost'], hops: 3 }).inactive).toBe(true)
  })

  it('memoizes adjacency on document identity', () => {
    const document = tower()
    expect(connectionAdjacency(document)).toBe(connectionAdjacency(document))
  })
})

describe('resolved visibility', () => {
  it('draws everything solid when nothing is isolated', () => {
    const document = tower()
    const resolved = resolveVisibility(document, DEFAULT_VISIBILITY)
    expect(resolved.solid.size).toBe(5)
    expect(resolved.ghosted.size).toBe(0)
    expect(resolved.hidden.size).toBe(0)
  })

  it('ghosts the context outside an isolation rather than deleting it', () => {
    const document = tower()
    const resolved = resolveVisibility(document, {
      ...DEFAULT_VISIBILITY,
      isolation: { seedPartIds: ['a'], hops: 1 },
    })
    expect([...resolved.solid].sort()).toEqual(['a', 'b'])
    // A subassembly floating in a void is much harder to place than one inside
    // a faint outline of the model it belongs to.
    expect(resolved.ghosted.size).toBe(3)
    expect(resolved.hidden.size).toBe(0)
  })

  it('can remove the context entirely when a section drawing needs it', () => {
    const document = tower()
    const resolved = resolveVisibility(document, {
      ...DEFAULT_VISIBILITY,
      outside: 'hidden',
      isolation: { seedPartIds: ['a'], hops: 0 },
    })
    expect([...resolved.solid]).toEqual(['a'])
    expect(resolved.hidden.size).toBe(4)
  })

  it('honours explicit hiding ahead of isolation', () => {
    const document = tower()
    const resolved = resolveVisibility(document, {
      ...DEFAULT_VISIBILITY,
      hiddenPartIds: new Set(['a']),
      isolation: { seedPartIds: ['a'], hops: 1 },
    })
    expect(resolved.hidden.has('a')).toBe(true)
    expect(resolved.solid.has('a')).toBe(false)
  })

  it('clamps ghost opacity into range', () => {
    const document = tower()
    expect(resolveVisibility(document, { ...DEFAULT_VISIBILITY, ghostOpacity: 4 }).ghostOpacity).toBe(1)
    expect(resolveVisibility(document, { ...DEFAULT_VISIBILITY, ghostOpacity: -1 }).ghostOpacity).toBe(0)
  })
})

describe('named views', () => {
  const view = (name: string) => ({
    name,
    position: [1, 2, 3] as const,
    target: [0, 0, 0] as const,
    zoom: 1,
    orthographic: false,
    savedAt: '2026-01-01T00:00:00.000Z',
  })

  it('replaces a view in place, keeping the operator’s own order', () => {
    const store = new NamedViewStore()
    store.save(view('front'))
    store.save(view('detail'))
    store.save({ ...view('front'), zoom: 4 })
    expect(store.list().map((entry) => entry.name)).toEqual(['front', 'detail'])
    expect(store.get('front')?.zoom).toBe(4)
  })

  it('is bounded, so saved viewpoints cannot grow without limit', () => {
    const store = new NamedViewStore(3)
    for (const name of ['a', 'b', 'c', 'd']) store.save(view(name))
    expect(store.list().map((entry) => entry.name)).toEqual(['b', 'c', 'd'])
  })

  it('reports a missing view rather than inventing one', () => {
    const store = new NamedViewStore()
    expect(store.get('nope')).toBeNull()
    expect(store.remove('nope')).toBe(false)
  })
})
