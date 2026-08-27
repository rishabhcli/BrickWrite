import { describe, expect, it } from 'vitest'
import {
  planSharedMutation,
  SHARED_CAPABILITIES,
  SHARED_MUTATION_CAPABILITIES,
  SharedCapabilityError,
} from './capabilities'
import { CadEngine } from './engine'
import { IDENTITY_BASIS } from './math'
import { createEmptyDocument, createShowcaseDocument } from './sample'
import type { ModelDocument, PartInstance } from './types'

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

    const duplicate = planSharedMutation('duplicate_selection', { offsetLdu: [20, -8, 40] }, context)
    expect(duplicate.operations).toHaveLength(1)
    expect(duplicate.operations[0]).toMatchObject({
      type: 'part.add',
      part: { transform: { position: [30, -32, 70] } },
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
})
