import { describe, expect, it } from 'vitest'
import {
  planSharedMutation,
  SHARED_CAPABILITIES,
  SHARED_MUTATION_CAPABILITIES,
  SharedCapabilityError,
} from './capabilities'
import { catalog } from './catalog'
import { CadEngine } from './engine'
import { IDENTITY_BASIS } from './math'
import { createEmptyDocument, createShowcaseDocument } from './sample'
import type { ModelDocument, PartInstance } from './types'
import { floatingPartIds } from './validation'

const part = (id: string, position: readonly [number, number, number] = [0, 0, 0]): PartInstance => ({
  id,
  definitionId: '3001',
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

const withParts = (...parts: PartInstance[]): ModelDocument => {
  const document = createEmptyDocument()
  return {
    ...document,
    parts: Object.fromEntries(parts.map((item) => [item.id, item])),
    subassemblies: {
      ...document.subassemblies,
      hull: { ...document.subassemblies.hull, partIds: parts.map((item) => item.id) },
    },
  }
}

describe('shared human/agent capabilities', () => {
  it('has one unique, fully described registry for both control surfaces', () => {
    const ids = SHARED_CAPABILITIES.map((capability) => capability.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(SHARED_MUTATION_CAPABILITIES.length).toBeGreaterThanOrEqual(12)
    for (const capability of SHARED_CAPABILITIES) {
      expect(capability.title.trim()).not.toBe('')
      expect(capability.summary.trim()).not.toBe('')
      expect(capability.group.trim()).not.toBe('')
      expect(capability.input).toBeTypeOf('object')
    }
  })

  it('plans exact duplicate and array transforms without mutating the source', () => {
    const source = part('source', [10, -24, 30])
    const document = withParts(source)
    const context = { document, selection: ['source'], actor: 'human' as const }

    const duplicate = planSharedMutation('duplicate_selection', { offsetLdu: [20, 0, 40] }, context)
    expect(duplicate.operations).toHaveLength(1)
    expect(duplicate.operations[0]).toMatchObject({
      type: 'part.add',
      part: { transform: { position: [30, -24, 70] } },
    })

    const array = planSharedMutation('linear_array', { copies: 3, offsetLdu: [0, 0, 20] }, context)
    expect(array.operations).toHaveLength(3)
    expect(array.operations.map((operation) => operation.type === 'part.add' && operation.part.transform.position)).toEqual([
      [10, -24, 50],
      [10, -24, 70],
      [10, -24, 90],
    ])
    expect(document.parts.source.transform.position).toEqual([10, -24, 30])
  })

  it('uses the 6-DOF solver for the same connect command exposed to both actors', () => {
    const document = withParts(part('base'), part('moving', [3, -27, 2]))
    const plan = planSharedMutation(
      'connect_parts',
      { movingPartId: 'moving', targetPartId: 'base' },
      { document, selection: [], actor: 'human' },
    )
    expect(plan.operations).toEqual([
      {
        type: 'part.transform',
        partId: 'moving',
        transform: { position: [0, -24, 0], basis: IDENTITY_BASIS },
      },
    ])
  })

  it('mates a hovering brick onto a measured anchor instead of leaving it in the air', () => {
    const document = withParts(part('base'), part('moving', [0, -200, 0]))
    const plan = planSharedMutation(
      'connect_parts',
      { movingPartId: 'moving', targetPartId: 'base' },
      { document, selection: [], actor: 'human' },
    )
    expect(plan.operations[0]).toMatchObject({
      type: 'part.transform',
      partId: 'moving',
      transform: { position: [0, -24, 0] },
    })
  })

  it('creates and assigns a subassembly as one consistent transaction', () => {
    const document = withParts(part('a'))
    const plan = planSharedMutation(
      'create_subassembly',
      { name: 'Sensor mast', partIds: ['a'], accent: '#41d6c3' },
      { document, selection: [], actor: 'human' },
    )
    const engine = new CadEngine(document)
    const result = engine.execute(plan.label, [...plan.operations], 'human', document.revision)
    expect(result.ok).toBe(true)

    const next = engine.getSnapshot().document
    const created = Object.values(next.subassemblies).find((subassembly) => subassembly.name === 'Sensor mast')
    expect(created).toMatchObject({ partIds: ['a'], accent: '#41d6c3', locked: false })
    expect(next.parts.a.subassemblyId).toBe(created?.id)
    expect(next.subassemblies.hull.partIds).not.toContain('a')
    expect(result.ok && result.value.patch.touched.subassemblyIds).toEqual(expect.arrayContaining(['hull', created!.id]))
  })

  it('refuses a duplicate that would hover', () => {
    const document = withParts(part('source'))
    try {
      planSharedMutation(
        'duplicate_selection',
        { offsetLdu: [0, -200, 0] },
        { document, selection: ['source'], actor: 'human' },
      )
      throw new Error('expected DISCONNECTED')
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'DISCONNECTED', name: 'SharedCapabilityError' })
    }
  })

  it('still plans a colliding duplicate so propose can show a ghost', () => {
    const document = withParts(part('source'))
    const plan = planSharedMutation(
      'duplicate_selection',
      { offsetLdu: [0, 0, 0] },
      { document, selection: ['source'], actor: 'human' },
    )
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]).toMatchObject({ type: 'part.add', part: { transform: { position: [0, 0, 0] } } })
  })

  it('names another nearby part when connect_parts cannot mate', () => {
    const tileId = catalog.get('3070b')?.canonicalId
    expect(tileId).toBeTruthy()
    const tile = (id: string, position: readonly [number, number, number]): PartInstance => ({
      ...part(id, position),
      definitionId: tileId!,
    })
    const document = withParts(tile('tileA'), tile('tileB', [400, 0, 0]), part('anchor', [800, 0, 0]))
    try {
      planSharedMutation(
        'connect_parts',
        { movingPartId: 'tileA', targetPartId: 'tileB' },
        { document, selection: [], actor: 'human' },
      )
      throw new Error('expected connect_parts to refuse two tiles')
    } catch (cause) {
      expect(cause).toBeInstanceOf(SharedCapabilityError)
      expect(cause).toMatchObject({
        details: {
          movingPartId: 'tileA',
          targetPartId: 'tileB',
        },
      })
      const details = (cause as SharedCapabilityError).details
      expect(details?.nearbyPartId).toBeTruthy()
      expect(details?.nearbyPartId).not.toBe('tileB')
      expect(String((cause as SharedCapabilityError).repair)).toMatch(/connect_parts/)
    }
  })

  it('renames revisioned document state and round-trips it through shared undo/redo', () => {
    const engine = new CadEngine(createEmptyDocument())
    const plan = planSharedMutation(
      'rename_document',
      { name: 'Orbital service cart' },
      { document: engine.getSnapshot().document, selection: [], actor: 'human' },
    )
    expect(engine.execute(plan.label, [...plan.operations], 'human', 0).ok).toBe(true)
    expect(engine.getSnapshot().document).toMatchObject({ name: 'Orbital service cart', revision: 1 })

    expect(engine.undo('human').ok).toBe(true)
    expect(engine.getSnapshot().document).toMatchObject({ name: 'Untitled build', revision: 2 })
    expect(engine.redo('human').ok).toBe(true)
    expect(engine.getSnapshot().document).toMatchObject({ name: 'Orbital service cart', revision: 3 })
  })

  it('attributes notes to the executing actor even if a caller forges metadata', () => {
    const engine = new CadEngine(withParts(part('anchor')))
    const result = engine.execute(
      'Human note',
      [{
        type: 'note.add',
        note: {
          id: 'forged-note',
          anchorPartIds: ['anchor'],
          text: 'Keep this interface clear.',
          status: 'open',
          author: 'agent',
          revisionCreated: 999,
        },
      }],
      'human',
      0,
    )
    expect(result.ok).toBe(true)
    expect(engine.getSnapshot().document.notes.at(-1)).toMatchObject({
      id: 'forged-note',
      author: 'human',
      revisionCreated: 0,
    })
  })

  it('keeps a human lock authoritative over the agent surface', () => {
    const engine = new CadEngine(createShowcaseDocument())
    engine.setAutonomy('build')
    const document = engine.getSnapshot().document
    const plan = planSharedMutation(
      'lock_subassembly',
      { subassemblyId: 'cockpit', locked: false },
      { document, selection: [], actor: 'agent' },
    )
    expect(engine.execute(plan.label, [...plan.operations], 'agent', document.revision)).toMatchObject({
      ok: false,
      error: { code: 'PROTECTED_REGION' },
    })
    expect(engine.getSnapshot().document.subassemblies.cockpit.locked).toBe(true)
  })

  it('rejects unbounded work before allocating operations', () => {
    const selection = Array.from({ length: 501 }, (_, index) => `part_${index}`)
    expect(() => planSharedMutation(
      'duplicate_selection',
      {},
      { document: createEmptyDocument(), selection, actor: 'agent' },
    )).toThrow(SharedCapabilityError)
    try {
      planSharedMutation('duplicate_selection', {}, { document: createEmptyDocument(), selection, actor: 'agent' })
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'RESOURCE_LIMIT' })
    }
  })

  it('refuses a stamp that would hover', () => {
    const document = withParts(part('source'))
    const captured = planSharedMutation(
      'capture_module',
      { name: 'Bay', partIds: ['source'] },
      { document, selection: ['source'], actor: 'human' },
    )
    const engine = new CadEngine(document)
    expect(engine.execute(captured.label, [...captured.operations], 'human', document.revision).ok).toBe(true)
    try {
      planSharedMutation(
        'stamp_module',
        { module: 'Bay', atLdu: [0, -200, 0] },
        { document: engine.getSnapshot().document, selection: [], actor: 'human' },
      )
      throw new Error('expected DISCONNECTED')
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'DISCONNECTED', name: 'SharedCapabilityError' })
    }
  })

  it('stamps onto a measured anchor instead of invented XYZ', () => {
    const document = withParts(part('source'), part('island', [400, 0, 0]))
    const captured = planSharedMutation(
      'capture_module',
      { name: 'Bay', partIds: ['source'] },
      { document, selection: ['source'], actor: 'human' },
    )
    const engine = new CadEngine(document)
    expect(engine.execute(captured.label, [...captured.operations], 'human', document.revision).ok).toBe(true)
    const plan = planSharedMutation(
      'stamp_module',
      { module: 'Bay', anchorPartId: 'island' },
      { document: engine.getSnapshot().document, selection: [], actor: 'human' },
    )
    expect(plan.operations.length).toBeGreaterThan(0)
    expect(plan.report).toMatchObject({ anchorPartId: 'island' })
  })

  it('refuses a wall that would hover beside a grounded brick', () => {
    const document = withParts(part('ground'))
    try {
      planSharedMutation(
        'build_wall',
        { lengthStuds: 8, courses: 3, originLdu: [0, -200, 0] },
        { document, selection: [], actor: 'human' },
      )
      throw new Error('expected DISCONNECTED')
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'DISCONNECTED', name: 'SharedCapabilityError' })
    }
  })

  it('lays a wall onto a measured anchor instead of invented XYZ', () => {
    const document = withParts(part('island', [400, 0, 0]))
    const plan = planSharedMutation(
      'build_wall',
      { lengthStuds: 4, courses: 1, anchorPartId: 'island' },
      { document, selection: [], actor: 'human' },
    )
    expect(plan.report).toMatchObject({ anchorPartId: 'island' })
    const engine = new CadEngine(document)
    const result = engine.execute(plan.label, [...plan.operations], 'human', document.revision)
    expect(result.ok).toBe(true)
    expect(floatingPartIds(engine.getSnapshot().document)).toEqual([])
  })

  it('duplicates beside the selection by its measured width instead of an invented offset', () => {
    const source = part('source')
    const document = withParts(source)
    const plan = planSharedMutation(
      'duplicate_selection',
      { along: 'x' },
      { document, selection: ['source'], actor: 'human' },
    )
    expect(plan.operations).toHaveLength(1)
    const copy = plan.operations[0]
    expect(copy?.type).toBe('part.add')
    if (copy?.type !== 'part.add') return
    expect(copy.part.transform.position[0]).toBeGreaterThan(source.transform.position[0] + 40)
    expect(copy.part.transform.position[1]).toBe(source.transform.position[1])
    expect(copy.part.transform.position[2]).toBe(source.transform.position[2])
  })

  it('mirrors a clutched pair about its own centre when about is selection', () => {
    const document = withParts(part('a', [400, 0, 0]), part('b', [480, 0, 0]))
    const plan = planSharedMutation(
      'mirror_selection',
      { about: 'selection' },
      { document, selection: ['a', 'b'], actor: 'human' },
    )
    const poses = Object.fromEntries(
      plan.operations.flatMap((operation) =>
        operation.type === 'part.transform' ? [[operation.partId, operation.transform.position]] : [],
      ),
    ) as Record<string, [number, number, number]>
    expect(poses.a[0]).toBeCloseTo(480, 6)
    expect(poses.b[0]).toBeCloseTo(400, 6)
    expect(poses.a[1]).toBe(0)
    expect(poses.b[1]).toBe(0)
  })

  it('mirrors front-to-back, which builders do as often as left-to-right', () => {
    // The command reflected across X and only X for as long as it existed, so a
    // front-to-back symmetry — the other half of almost every vehicle and
    // facade — could not be asked for at all.
    const document = withParts(part('a', [0, 0, 400]), part('b', [0, 0, 480]))
    const plan = planSharedMutation(
      'mirror_selection',
      { axis: 'z', about: 'selection' },
      { document, selection: ['a', 'b'], actor: 'human' },
    )
    const poses = Object.fromEntries(
      plan.operations.flatMap((operation) =>
        operation.type === 'part.transform' ? [[operation.partId, operation.transform.position]] : [],
      ),
    ) as Record<string, [number, number, number]>
    expect(poses.a[2]).toBeCloseTo(480, 6)
    expect(poses.b[2]).toBeCloseTo(400, 6)
    expect(poses.a[0]).toBe(0)
  })

  it('names the parts a reflection cannot carry faithfully, and still places them', () => {
    // A 45° slope mirrored across its own ramp wants the opposite-hand element,
    // which this build carries no table to name. The pose emitted is a real
    // placement of a real part — the determinant stays positive, so nothing
    // unbuyable reaches the BOM — but it is not a true reflection of the shape,
    // and saying so is the whole point. Reported, never blocking: the operator
    // gets the part count they asked for and knows which ones to swap by hand.
    const slope: PartInstance = { ...part('s', [0, 0, 0]), definitionId: '3039' }
    const document = withParts(slope, part('b', [200, 0, 0]))
    const plan = planSharedMutation(
      'mirror_selection',
      { axis: 'z' },
      { document, selection: ['s', 'b'], actor: 'human' },
    )
    expect(plan.operations).toHaveLength(2)
    expect(plan.summary).toContain('not a true mirror')
    expect(plan.summary).toContain('s')
    // The plain brick is symmetric front-to-back and is not accused.
    expect(plan.summary).not.toContain('b,')
  })

  it('says nothing about faithfulness when every part is symmetric about the plane', () => {
    const document = withParts(part('a', [0, 0, 0]), part('b', [200, 0, 0]))
    const plan = planSharedMutation('mirror_selection', {}, { document, selection: ['a', 'b'], actor: 'human' })
    expect(plan.summary).not.toContain('true mirror')
  })
})
