import { describe, expect, it } from 'vitest'
import { articulate, findArticulatedJoints, type ArticulatedJoint } from './articulation'
import { CadEngine } from './engine'
import { IDENTITY_BASIS, type Mat3 } from './math'
import { createEmptyDocument } from './sample'
import { catalog } from './catalog'
import { jointFor } from './connections'
import { deriveConnectionEdges, jointOverrideIndex } from './snapping'
import type { CadOperation, JointOverride, ModelDocument, PartInstance } from './types'

/**
 * Freedoms the builder asserts, over the ones the connectors imply.
 *
 * Connection edges are derived on every edit, which is the right default —
 * geometry should decide what a stud can do. It also means a mechanism whose
 * behaviour is a matter of *intent* has nowhere to live: a winch drum is an
 * axle in an axle-hole, and so is a plain axle. These tests cover the channel
 * that closes that gap, and the one freedom that can only reach a document
 * through it.
 */

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

function assemble(parts: PartInstance[]): { engine: CadEngine; document: ModelDocument } {
  const engine = new CadEngine(createEmptyDocument())
  let revision = engine.getSnapshot().document.revision
  for (const item of parts) {
    const result = engine.execute(`Place ${item.id}`, [{ type: 'part.add', part: item }], 'human', revision)
    if (result.ok) revision = result.value.resultRevision
  }
  return { engine, document: engine.getSnapshot().document }
}

/**
 * Two 1 x 1 bricks, stacked.
 *
 * Deliberately 1 x 1 rather than 2 x 4: a pair of 2 x 4 bricks meet at eight
 * stud pairs, so they form one rigid group and no single joint among them can
 * articulate anything. One stud is one edge, which is what makes the override
 * observable.
 */
const stack = () => assemble([part('lower', '3005', [0, 0, 0]), part('upper', '3005', [0, -24, 0])])

const firstEdge = (document: ModelDocument) => Object.values(document.connections)[0]

const winch = (edge: ReturnType<typeof firstEdge>): JointOverride => ({
  a: edge.a,
  b: edge.b,
  joint: { kind: 'winch', axis: [0, 1, 0], payoutAxis: [0, 1, 0], drumRadiusLdu: 10, minLdu: -200, maxLdu: 0 },
})

describe('an asserted joint freedom', () => {
  it('replaces the one the connectors imply', () => {
    const { engine, document } = stack()
    const edge = firstEdge(document)
    expect(edge.joint.kind).toBe('revolute')

    const result = engine.execute('Assert a winch', [{ type: 'joint.override', override: winch(edge) }], 'human', document.revision)
    expect(result.ok).toBe(true)

    const after = engine.getSnapshot().document
    expect(after.jointOverrides).toHaveLength(1)
    expect(deriveConnectionEdges(after, after.revision, 'snap')[edge.id].joint.kind).toBe('winch')
  })

  it('survives the next edit, which is the whole point', () => {
    // Edges are re-derived incrementally when a part moves. An override that
    // only applied to the bulk derivation would revert to a plain axle the next
    // time anything near it was touched.
    const { engine, document } = stack()
    const edge = firstEdge(document)
    const asserted = engine.execute('Assert a winch', [{ type: 'joint.override', override: winch(edge) }], 'human', document.revision)
    expect(asserted.ok).toBe(true)

    const moved = engine.execute(
      'Nudge the load',
      [{ type: 'part.transform', partId: 'upper', transform: { position: [0, -24, 0], basis: IDENTITY_BASIS } }],
      'human',
      engine.getSnapshot().document.revision,
    )
    expect(moved.ok).toBe(true)

    const after = engine.getSnapshot().document
    expect(after.connections[edge.id].joint.kind).toBe('winch')
  })

  it('applies whichever way round the endpoints are written', () => {
    // Edge ids are order-independent, and so is the override key. A builder
    // naming the pair the other way round means the same joint.
    const { document } = stack()
    const edge = firstEdge(document)
    const reversed: JointOverride = { ...winch(edge), a: edge.b, b: edge.a }
    const index = jointOverrideIndex({ ...document, jointOverrides: [reversed] })
    expect(index.get(edge.id)?.kind).toBe('winch')
  })

  it('is inert when it names a joint that is not there', () => {
    const { document } = stack()
    const ghost: JointOverride = {
      a: { partId: 'gone', featureId: 'nowhere' },
      b: { partId: 'also-gone', featureId: 'nowhere' },
      joint: { kind: 'fixed' },
    }
    const withGhost = { ...document, jointOverrides: [ghost] }
    const edges = deriveConnectionEdges(withGhost, withGhost.revision, 'snap')
    expect(Object.values(edges).every((entry) => entry.joint.kind === 'revolute')).toBe(true)
  })

  it('holds one freedom per joint, not a pile of them', () => {
    const { engine, document } = stack()
    const edge = firstEdge(document)
    let revision = document.revision
    for (const drumRadiusLdu of [10, 20, 30]) {
      const result = engine.execute(
        'Assert',
        [{ type: 'joint.override', override: { ...winch(edge), joint: { ...winch(edge).joint, drumRadiusLdu } as never } }],
        'human',
        revision,
      )
      expect(result.ok).toBe(true)
      revision = engine.getSnapshot().document.revision
    }
    const overrides = engine.getSnapshot().document.jointOverrides!
    expect(overrides).toHaveLength(1)
    expect((overrides[0].joint as { drumRadiusLdu: number }).drumRadiusLdu).toBe(30)
  })

  it('is undone by replay like anything else', () => {
    const { engine, document } = stack()
    const edge = firstEdge(document)
    engine.execute('Assert a winch', [{ type: 'joint.override', override: winch(edge) }], 'human', document.revision)
    expect(engine.getSnapshot().document.jointOverrides).toHaveLength(1)

    engine.undo()
    expect(engine.getSnapshot().document.jointOverrides ?? []).toHaveLength(0)
  })
})

describe('driving a winch', () => {
  const joint = (freedomExtra: Partial<{ minLdu: number; maxLdu: number }> = {}): ArticulatedJoint => ({
    edgeId: 'e',
    joint: {
      kind: 'winch',
      axis: [0, 0, 1],
      payoutAxis: [0, 1, 0],
      drumRadiusLdu: 10,
      minLdu: -200,
      maxLdu: 0,
      ...freedomExtra,
    },
    family: 'axle',
    pivotLdu: [0, 0, 0],
    axis: [0, 0, 1],
    movingPartIds: ['hook'],
    anchoredPartIds: ['drum'],
    label: 'winch',
  })

  const document = (): ModelDocument => {
    const base = createEmptyDocument()
    return { ...base, parts: { ...base.parts, hook: part('hook', '3005', [0, 0, 0]) } }
  }

  it('turns rotation of the drum into travel of the load', () => {
    // A full turn pays out one circumference: 2πr, here about 62.8 LDU. The
    // load translates and does not spin — a hook that rotated with the drum
    // would be a hook welded to the shaft.
    const operations = articulate(document(), joint(), { rotateDegrees: -360 })
    expect(operations).toHaveLength(1)
    const moved = operations[0] as Extract<CadOperation, { type: 'part.transform' }>
    expect(moved.transform.position[1]).toBeCloseTo(-2 * Math.PI * 10, 5)
    expect(moved.transform.position[0]).toBe(0)
    expect(moved.transform.basis).toEqual(IDENTITY_BASIS)
  })

  it('pays out along its own axis, not the one it turns about', () => {
    const operations = articulate(document(), joint(), { rotateDegrees: -180 })
    const moved = operations[0] as Extract<CadOperation, { type: 'part.transform' }>
    // Drum axis is z; payout is y. Travel must be entirely on y.
    expect(moved.transform.position[2]).toBe(0)
    expect(Math.abs(moved.transform.position[1])).toBeGreaterThan(1)
  })

  it('stops at the end of its cable', () => {
    const operations = articulate(document(), joint({ minLdu: -30, maxLdu: 0 }), { rotateDegrees: -3600 })
    const moved = operations[0] as Extract<CadOperation, { type: 'part.transform' }>
    expect(moved.transform.position[1]).toBeCloseTo(-30, 5)
  })

  it('drives nothing when the drum is not turned', () => {
    expect(articulate(document(), joint(), { rotateDegrees: 0 })).toEqual([])
  })

  it('finds the winch as a drivable joint on the model', () => {
    const { engine, document: built } = stack()
    const edge = firstEdge(built)
    engine.execute('Assert a winch', [{ type: 'joint.override', override: winch(edge) }], 'human', built.revision)
    const joints = findArticulatedJoints(engine.getSnapshot().document, ['upper'])
    expect(joints.map((entry) => entry.joint.kind)).toContain('winch')
  })
})

/**
 * The translation half of `articulate`, which no test could reach before.
 *
 * `jointFor` takes a joint's axial range from the connectors, and only clips
 * declare one. The test fixture carried no clip that did, so every prismatic
 * and cylindrical freedom in every test clamped to a zero-length range and the
 * slide path — the offset arithmetic, the clamp, the emitted transform — was
 * never exercised with a real value.
 *
 * The derivation is tested at `jointFor`, which is where it happens, rather
 * than by positioning two parts until their connectors mate: that would be a
 * test of the snap solver wearing this one's name, and an arrangement that
 * failed to mate would make these pass while proving nothing.
 */
describe('a derived sliding joint', () => {
  const connector = (definitionId: string, family: string) => {
    const found = catalog.get(definitionId)?.connectors.find((entry) => entry.family === family)
    expect(found, `${definitionId} has no ${family} connector in this fixture`).toBeDefined()
    return found!
  }

  it('derives a real axial range from the connectors', () => {
    const joint = jointFor(connector('3023b', 'bar'), connector('60897', 'clip'))
    expect(joint.kind).toBe('cylindrical')
    const range = joint as Extract<typeof joint, { minLdu: number; maxLdu: number }>
    expect(range.maxLdu - range.minLdu).toBeGreaterThan(0)
  })

  const sliding = (): ArticulatedJoint => {
    const joint = jointFor(connector('3023b', 'bar'), connector('60897', 'clip'))
    return {
      edgeId: 'e',
      joint,
      family: 'clip',
      pivotLdu: [0, 0, 0],
      axis: [0, 1, 0],
      movingPartIds: ['load'],
      anchoredPartIds: ['rail'],
      label: 'slide',
    }
  }

  const document = (): ModelDocument => {
    const base = createEmptyDocument()
    return { ...base, parts: { ...base.parts, load: part('load', '3005', [0, 0, 0]) } }
  }

  const travelOf = (operations: CadOperation[]) => {
    expect(operations.length).toBeGreaterThan(0)
    const moved = operations[0] as Extract<CadOperation, { type: 'part.transform' }>
    return Math.hypot(...moved.transform.position)
  }

  it('translates the moving island along the joint axis', () => {
    const joint = sliding()
    const limit = (joint.joint as { maxLdu: number }).maxLdu
    const asked = limit / 2
    expect(travelOf(articulate(document(), joint, { slideLdu: asked }))).toBeCloseTo(asked, 5)
  })

  it('clamps travel to the range the connectors declare', () => {
    const joint = sliding()
    const limit = (joint.joint as { maxLdu: number }).maxLdu
    // Asked for 10,000 LDU. A slide that ignored the range would pull the part
    // clean off the model.
    expect(travelOf(articulate(document(), joint, { slideLdu: 10_000 }))).toBeCloseTo(limit, 5)
  })
})
