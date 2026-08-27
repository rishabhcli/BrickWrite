import { describe, expect, it } from 'vitest'
import { CadEngine } from './engine'
import { createEmptyDocument, createShowcaseDocument } from './sample'
import { IDENTITY_BASIS } from './math'
import type { CadOperation, PartInstance } from './types'

const makePart = (id: string, position: readonly [number, number, number] = [0, 0, 0]): PartInstance => ({
  id,
  definitionId: '3001',
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

describe('CadEngine', () => {
  it('keeps the showcase inside its hard design constraints', () => {
    const report = new CadEngine(createShowcaseDocument()).getSnapshot().validation
    expect(report.collisions).toHaveLength(0)
    expect(report.virtualColors).toHaveLength(0)
    expect(report.constraints.every((constraint) => constraint.status === 'pass')).toBe(true)
  })

  it('commits through monotonic revisions and rejects stale agent work', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.setAutonomy('build')
    const first = engine.execute('Place foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    expect(first.ok && first.value.resultRevision).toBe(1)
    const stale = engine.execute('Stale move', [{ type: 'part.transform', partId: 'a', transform: { position: [20, 0, 0], basis: IDENTITY_BASIS } }], 'agent', 0)
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_DOCUMENT' } })
    expect(engine.getSnapshot().document.parts.a.transform.position).toEqual([0, 0, 0])
  })

  it('enforces protected regions in the kernel, not tool descriptions', () => {
    const document = createEmptyDocument()
    document.parts.a = { ...makePart('a'), protected: true }
    document.subassemblies.hull.partIds = ['a']
    const engine = new CadEngine(document)
    engine.setAutonomy('build')
    const result = engine.execute('Remove protected part', [{ type: 'part.remove', partId: 'a' }], 'agent', 0)
    expect(result).toMatchObject({ ok: false, error: { code: 'PROTECTED_REGION' } })
    expect(engine.getSnapshot().document.parts.a).toBeDefined()
  })

  it('preflights without mutation and blocks colliding proposals atomically', () => {
    const engine = new CadEngine(createEmptyDocument())
    const operations: CadOperation[] = [
      { type: 'part.add', part: makePart('a') },
      { type: 'part.add', part: makePart('b') },
    ]
    const proposal = engine.preflight('Impossible overlap', operations, 'agent', 0)
    expect(proposal.ok).toBe(true)
    expect(engine.getSnapshot().document.revision).toBe(0)
    expect(Object.keys(engine.getSnapshot().document.parts)).toHaveLength(0)
    if (!proposal.ok) return
    expect(proposal.value.validation.collisions).toHaveLength(1)
    expect(engine.applyProposal(proposal.value.id, 'agent')).toMatchObject({ ok: false, error: { code: 'COLLISION' } })
    expect(Object.keys(engine.getSnapshot().document.parts)).toHaveLength(0)
  })

  it('shares undo and redo while keeping revisions monotonic', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Place part', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    const undo = engine.undo('human')
    expect(undo.ok && undo.value.resultRevision).toBe(2)
    expect(engine.getSnapshot().document.parts.a).toBeUndefined()
    const redo = engine.redo('human')
    expect(redo.ok && redo.value.resultRevision).toBe(3)
    expect(engine.getSnapshot().document.parts.a).toBeDefined()
  })
})
