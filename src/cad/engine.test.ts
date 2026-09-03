import { describe, expect, it } from 'vitest'
import { catalog, originForSurface } from './catalog'
import { CadEngine } from './engine'
import { getPartBounds } from './geometry'
import {createEmptyDocument} from './sample'
import { createRoverDocument } from './__fixtures__/rover'
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
    const report = new CadEngine(createRoverDocument()).getSnapshot().validation
    expect(report.collisions).toHaveLength(0)
    expect(report.virtualColors).toHaveLength(0)
    expect(report.constraints.every((constraint) => constraint.status === 'pass')).toBe(true)
  })

  it('commits through monotonic revisions and rejects stale agent work', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.setAutonomy('build')
    const first = engine.execute('Place foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    expect(first.ok && first.value.resultRevision).toBe(1)
    const stale = engine.execute(
      'Stale move',
      [{ type: 'part.transform', partId: 'a', transform: { position: [20, 0, 0], basis: IDENTITY_BASIS } }],
      'agent',
      0,
    )
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
    expect(engine.getSnapshot().proposals.some((entry) => entry.id === proposal.value.id)).toBe(true)
  })

  /**
   * A document that already overlaps must not veto every proposal on it.
   *
   * `applyProposal` counted the preview document's collisions rather than the
   * ones the proposal introduced, so any pre-existing overlap froze all agent
   * work: the shipped showcase carries 121, and every proposal against it was
   * refused before it was read. `execute` has always judged the delta.
   */
  it('applies a proposal that adds nothing to a document already colliding', () => {
    // Placed directly, because the engine's own gate would refuse them — which
    // is the case that matters: a document can arrive already overlapping from
    // an import, a fork, or a shipped starting model.
    const document = createEmptyDocument()
    document.parts.a = makePart('a')
    document.parts.b = makePart('b')
    document.subassemblies.hull.partIds = ['a', 'b']
    const engine = new CadEngine(document)
    engine.setAutonomy('build')
    const existing = engine.getSnapshot().validation.collisions
    expect(existing.length).toBeGreaterThan(0)

    const proposal = engine.preflight('Stack clear of the overlap', [{ type: 'part.add', part: makePart('c', [0, -24, 0]) }], 'agent', 0)
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    // The preview still reports the overlap it inherited.
    expect(proposal.value.validation.collisions.length).toBeGreaterThan(0)

    const applied = engine.applyProposal(proposal.value.id, 'agent')
    expect(applied.ok).toBe(true)
    expect(engine.getSnapshot().document.parts.c).toBeDefined()
  })

  it('keeps a constraint-refused ghost queued instead of silently dropping it', () => {
    const engine = new CadEngine(createRoverDocument())
    const stray = engine.preflight(
      'Place far out',
      [{ type: 'part.add', part: makePart('stray', [400, 0, 0]) }],
      'human',
    )
    expect(stray.ok).toBe(true)
    if (!stray.ok) return
    expect(stray.value.validation.healthy).toBe(false)
    const applied = engine.applyProposal(stray.value.id, 'human')
    expect(applied).toMatchObject({ ok: false, error: { code: 'CONSTRAINT_VIOLATION' } })
    expect(engine.getSnapshot().document.parts.stray).toBeUndefined()
    expect(engine.getSnapshot().proposals.some((entry) => entry.id === stray.value.id)).toBe(true)
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

/**
 * The hard-constraint gate.
 *
 * A `hard` constraint is the difference between a design limit the kernel
 * enforces and one it merely reports, so the flag has to change what `execute`
 * does — for every actor, since the limit is the operator's own declared intent
 * rather than a physical fact discovered about the model. These tests pin the
 * three decisions that make the gate usable: what it refuses, what it lets
 * through, and how an operator gets out from under one.
 */
describe('hard design constraints', () => {
  // The showcase spans 8 × 12 studs inside a hard `Envelope ≤ 10 × 14 studs`,
  // so a part beyond x ∈ [-80, 80] LDU is the smallest edit that breaks it.
  const outside = (id: string) => [{ type: 'part.add', part: makePart(id, [400, 0, 0]) }] as CadOperation[]

  it('refuses a human edit that would newly break a hard constraint', () => {
    const engine = new CadEngine(createRoverDocument())
    const revision = engine.getSnapshot().document.revision

    const result = engine.execute('Place far out', outside('stray'), 'human')

    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('CONSTRAINT_VIOLATION')
    expect(!result.ok && (result.error.details as Array<{ id: string }>)[0].id).toBe('c_size')
    // A refused transaction must not half-apply: no part, no revision bump.
    expect(engine.getSnapshot().document.parts.stray).toBeUndefined()
    expect(engine.getSnapshot().document.revision).toBe(revision)
  })

  it('refuses the same edit from an agent', () => {
    const engine = new CadEngine(createRoverDocument())
    engine.setAutonomy('build')
    const result = engine.execute('Place far out', outside('stray'), 'agent')
    expect(!result.ok && result.error.code).toBe('CONSTRAINT_VIOLATION')
  })

  it('reports but does not refuse when the constraint is advisory', () => {
    const document = createRoverDocument()
    document.constraints = document.constraints.map((constraint) =>
      constraint.id === 'c_size' ? { ...constraint, hard: false } : constraint,
    )
    const engine = new CadEngine(document)

    const result = engine.execute('Place far out', outside('stray'), 'human')

    expect(result.ok).toBe(true)
    // Advisory means visible, not ignored: the report still fails the check.
    const size = engine.getSnapshot().validation.constraints.find((entry) => entry.id === 'c_size')
    expect(size?.status).toBe('fail')
  })

  it('lets an operator declare a target the build has not reached yet', () => {
    // Tightening the envelope below the current 8 × 12 footprint states intent.
    // Refusing it would make an aspirational budget impossible to express, and
    // would contradict the refusal message's own advice to soften the limit.
    const engine = new CadEngine(createRoverDocument())
    const result = engine.execute(
      'Tighten envelope',
      [
        {
          type: 'constraint.set',
          constraint: {
            id: 'c_size',
            kind: 'dimensions',
            label: 'Envelope ≤ 5 × 5 studs',
            value: { width: 5, depth: 5 },
            hard: true,
          },
        },
      ],
      'human',
    )

    expect(result.ok).toBe(true)
    expect(engine.getSnapshot().validation.constraints.find((entry) => entry.id === 'c_size')?.status).toBe('fail')
  })

  it('does not lock the document once a hard constraint is already failing', () => {
    // Having gone over budget, an operator still has to be able to edit — not
    // least to edit their way back under it.
    const engine = new CadEngine(createRoverDocument())
    engine.execute(
      'Tighten envelope',
      [
        {
          type: 'constraint.set',
          constraint: {
            id: 'c_size',
            kind: 'dimensions',
            label: 'Envelope ≤ 5 × 5 studs',
            value: { width: 5, depth: 5 },
            hard: true,
          },
        },
      ],
      'human',
    )

    const followUp = engine.execute(
      'Keep building',
      [{ type: 'part.recolor', partId: Object.keys(engine.getSnapshot().document.parts)[0]!, color: 4 }],
      'human',
    )
    expect(followUp.ok).toBe(true)
  })

  it('releases the edit once the constraint is removed', () => {
    const engine = new CadEngine(createRoverDocument())
    expect(engine.execute('Place far out', outside('stray'), 'human').ok).toBe(false)

    expect(engine.execute('Drop envelope', [{ type: 'constraint.remove', constraintId: 'c_size' }], 'human').ok).toBe(
      true,
    )
    expect(engine.execute('Place far out', outside('stray'), 'human').ok).toBe(true)
  })
})

describe('physical placement', () => {
  it('refuses a human commit that newly interpenetrates two parts', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    const result = engine.execute('Overlap', [{ type: 'part.add', part: makePart('b') }], 'human', 1)
    expect(result).toMatchObject({ ok: false, error: { code: 'COLLISION' } })
    expect(engine.getSnapshot().document.parts.b).toBeUndefined()
    expect(engine.getSnapshot().document.revision).toBe(1)
  })

  it('refuses dragging an unconnected brick into another brick', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    engine.execute('Beside', [{ type: 'part.add', part: makePart('b', [400, 0, 0]) }], 'human', 1)
    const result = engine.execute(
      'Overlap',
      [{ type: 'part.transform', partId: 'b', transform: { position: [0, 0, 0], basis: IDENTITY_BASIS } }],
      'human',
      2,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'COLLISION' } })
    expect(engine.getSnapshot().document.parts.b.transform.position).toEqual([400, 0, 0])
  })

  it('allows a second brick on the table that does not clutch to the first', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    const result = engine.execute('Beside', [{ type: 'part.add', part: makePart('b', [400, 0, 0]) }], 'human', 1)
    expect(result.ok).toBe(true)
    expect(engine.getSnapshot().document.parts.b).toBeDefined()
  })

  it('refuses a brick hovering with no clutch and no ground under it', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    const result = engine.execute('Hover', [{ type: 'part.add', part: makePart('ghost', [0, -200, 0]) }], 'human', 1)
    expect(result).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } })
    expect(engine.getSnapshot().document.parts.ghost).toBeUndefined()
    expect(engine.getSnapshot().document.revision).toBe(1)
  })

  it('allows the first brick on an empty plate', () => {
    const engine = new CadEngine(createEmptyDocument())
    const result = engine.execute('First', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    expect(result.ok).toBe(true)
  })

  it('allows a stacked brick that clutches to the one below', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    const result = engine.execute('Stack', [{ type: 'part.add', part: makePart('b', [0, -24, 0]) }], 'human', 1)
    expect(result.ok).toBe(true)
    expect(engine.getSnapshot().validation.connectionCount).toBeGreaterThan(0)
  })

  it('refuses a brick sitting on a tile with no clutch', () => {
    const tileId = catalog.get('3070b')
      ? '3070b'
      : catalog.placeable().find((item) => {
          if (item.connectors.some((feature) => feature.family === 'stud')) return false
          const bounds = item.dimensions?.bounds
          return Boolean(bounds) && bounds!.max[1] - bounds!.min[1] <= 10
        })?.canonicalId
    expect(tileId).toBeTruthy()
    const engine = new CadEngine(createEmptyDocument())
    const tile: PartInstance = { ...makePart('tile'), definitionId: tileId! }
    engine.execute('Tile', [{ type: 'part.add', part: tile }], 'human', 0)
    const brickY = originForSurface(catalog.get('3001'), getPartBounds(engine.getSnapshot().document.parts.tile).min[1])
    const result = engine.execute('Rest', [{ type: 'part.add', part: makePart('loose', [0, brickY, 0]) }], 'human', 1)
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_COMPATIBLE_CONNECTOR' } })
    expect(engine.getSnapshot().document.parts.loose).toBeUndefined()
  })

  it('nudges a clutched stack as one transaction without leaving a brick hovering', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    engine.execute('Stack', [{ type: 'part.add', part: makePart('b', [0, -24, 0]) }], 'human', 1)
    const result = engine.execute(
      'Nudge stack',
      [
        { type: 'part.transform', partId: 'a', transform: { position: [40, 0, 0], basis: IDENTITY_BASIS } },
        { type: 'part.transform', partId: 'b', transform: { position: [40, -24, 0], basis: IDENTITY_BASIS } },
      ],
      'human',
      2,
    )
    expect(result.ok).toBe(true)
    expect(engine.getSnapshot().document.parts.a.transform.position[0]).toBe(40)
    expect(engine.getSnapshot().document.parts.b.transform.position[0]).toBe(40)
  })

  it('refuses lifting unconnected bricks off a remaining ground brick as one transaction', () => {
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Foundation', [{ type: 'part.add', part: makePart('a') }], 'human', 0)
    engine.execute('Beside', [{ type: 'part.add', part: makePart('b', [400, 0, 0]) }], 'human', 1)
    engine.execute('Stay', [{ type: 'part.add', part: makePart('c', [800, 0, 0]) }], 'human', 2)
    const result = engine.execute(
      'Lift both',
      [
        { type: 'part.transform', partId: 'a', transform: { position: [0, -200, 0], basis: IDENTITY_BASIS } },
        { type: 'part.transform', partId: 'b', transform: { position: [400, -200, 0], basis: IDENTITY_BASIS } },
      ],
      'human',
      3,
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } })
    expect(engine.getSnapshot().document.parts.a.transform.position).toEqual([0, 0, 0])
    expect(engine.getSnapshot().document.parts.c.transform.position).toEqual([800, 0, 0])
  })
})
