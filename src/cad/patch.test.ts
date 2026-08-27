import { describe, expect, it } from 'vitest'
import { CadEngine } from './engine'
import { IDENTITY_BASIS, basisFromEulerDegrees } from './math'
import { applyMutations, invertMutations, mutationsForOperations, touchedBy } from './patch'
import { createEmptyDocument } from './sample'
import type { CadOperation, ModelDocument, PartInstance } from './types'

const part = (id: string, position: [number, number, number] = [0, 0, 0]): PartInstance => ({
  id,
  definitionId: '3001',
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

const documentWith = (...parts: PartInstance[]): ModelDocument => {
  const document = createEmptyDocument()
  for (const item of parts) {
    document.parts[item.id] = item
    document.subassemblies.hull.partIds.push(item.id)
  }
  return document
}

describe('document patches', () => {
  it('shares structure with the previous document', () => {
    const document = documentWith(part('a'), part('b'), part('c'))
    const next = applyMutations(document, [{ kind: 'part', id: 'b', value: part('b', [40, 0, 0]) }])

    // Untouched parts are the *same objects*: an edit to one brick must not deep
    // copy the rest of the model.
    expect(next.parts.a).toBe(document.parts.a)
    expect(next.parts.c).toBe(document.parts.c)
    expect(next.parts.b).not.toBe(document.parts.b)
    // The original is untouched.
    expect(document.parts.b.transform.position).toEqual([0, 0, 0])
  })

  it('inverts to exactly the prior state, including absence', () => {
    const document = documentWith(part('a'))
    const forward = [
      { kind: 'part', id: 'a', value: part('a', [20, 0, 0]) },
      { kind: 'part', id: 'new', value: part('new') },
    ] as const
    const inverse = invertMutations(document, forward)
    const applied = applyMutations(document, forward)
    const reverted = applyMutations(applied, inverse)

    expect(reverted.parts.a).toEqual(document.parts.a)
    // 'new' did not exist before, so its inverse deletes it.
    expect(reverted.parts.new).toBeUndefined()
  })

  it('inverts a batch to the state before the whole batch, not before the last touch', () => {
    const document = documentWith(part('a'))
    const forward = [
      { kind: 'part', id: 'a', value: part('a', [20, 0, 0]) },
      { kind: 'part', id: 'a', value: part('a', [40, 0, 0]) },
    ] as const
    const reverted = applyMutations(applyMutations(document, forward), invertMutations(document, forward))
    expect(reverted.parts.a.transform.position).toEqual([0, 0, 0])
  })

  it('reports the entities an edit touched', () => {
    const document = createEmptyDocument()
    const mutations = mutationsForOperations(
      document,
      [{ type: 'part.add', part: part('a') }],
      'human',
      'txn_1',
    )
    const touched = touchedBy(mutations)
    expect(touched.partIds).toEqual(['a'])
    expect(touched.subassemblyIds).toEqual(['hull'])
  })

  it('lets one batch build on its own earlier operations', () => {
    const document = createEmptyDocument()
    const operations: CadOperation[] = [
      { type: 'part.add', part: part('a') },
      { type: 'part.recolor', partId: 'a', color: 15 },
    ]
    const applied = applyMutations(document, mutationsForOperations(document, operations, 'human', 'txn_1'))
    expect(applied.parts.a.color).toBe(15)
  })

  it('drops connection edges when a part is removed', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Place base', [{ type: 'part.add', part: part('base') }], 'human', 0)
    engine.execute('Stack', [{ type: 'part.add', part: part('upper', [0, -24, 0]) }], 'human', 1)
    expect(Object.keys(engine.getSnapshot().document.connections).length).toBe(8)

    engine.execute('Remove upper', [{ type: 'part.remove', partId: 'upper' }], 'human', 2)
    expect(engine.getSnapshot().document.connections).toEqual({})
  })
})

describe('history through patches', () => {
  const stack = () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Place base', [{ type: 'part.add', part: part('base') }], 'human', 0)
    engine.execute('Stack upper', [{ type: 'part.add', part: part('upper', [0, -24, 0]) }], 'human', 1)
    return engine
  }

  it('carries a forward and inverse patch on every transaction', () => {
    const engine = stack()
    const [first] = engine.getSnapshot().transactions
    expect(first.patch.baseRevision).toBe(0)
    expect(first.patch.forward.length).toBeGreaterThan(0)
    expect(first.patch.inverse.length).toBe(first.patch.forward.length)
    expect(first.patch.touched.partIds).toEqual(['base'])
  })

  it('undoes by applying the inverse, and keeps revisions moving forward', () => {
    const engine = stack()
    const undo = engine.undo('human')
    expect(undo.ok && undo.value.resultRevision).toBe(3)
    const afterUndo = engine.getSnapshot().document
    expect(afterUndo.parts.upper).toBeUndefined()
    // The connections that edit created went away with it.
    expect(afterUndo.connections).toEqual({})

    const redo = engine.redo('human')
    expect(redo.ok && redo.value.resultRevision).toBe(4)
    expect(engine.getSnapshot().document.parts.upper).toBeDefined()
    expect(Object.keys(engine.getSnapshot().document.connections).length).toBe(8)
  })

  it('round-trips a deep undo/redo sequence exactly', () => {
    const engine = stack()
    engine.execute('Recolour', [{ type: 'part.recolor', partId: 'upper', color: 15 }], 'human', 2)
    engine.execute(
      'Rotate',
      [{ type: 'part.transform', partId: 'upper', transform: { position: [0, -24, 0], basis: basisFromEulerDegrees([0, 90, 0]) } }],
      'human',
      3,
    )
    const target = JSON.stringify(engine.getSnapshot().document.parts)

    for (let step = 0; step < 4; step += 1) engine.undo('human')
    expect(Object.keys(engine.getSnapshot().document.parts)).toEqual([])
    for (let step = 0; step < 4; step += 1) engine.redo('human')

    expect(JSON.stringify(engine.getSnapshot().document.parts)).toBe(target)
  })

  it('clears the redo stack once a new edit lands', () => {
    const engine = stack()
    engine.undo('human')
    expect(engine.getSnapshot().canRedo).toBe(true)
    engine.execute('Divergent edit', [{ type: 'part.add', part: part('other', [200, 0, 0]) }], 'human', 3)
    expect(engine.getSnapshot().canRedo).toBe(false)
  })
})
