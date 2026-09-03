import { describe, expect, it } from 'vitest'
import { basisFromEulerDegrees, composeTransform, IDENTITY_BASIS, type Mat3 } from './math'
import {createEmptyDocument} from './sample'
import { createRoverDocument } from './__fixtures__/rover'
import { catalog, originForSurface } from './catalog'
import { getPartBounds } from './geometry'
import { findWeakAttachments, floatingPartIds, airbornePartIds, poseRefusal, unclutchedRestPartIds, validateDocument } from './validation'
import type { ModelDocument, PartInstance } from './types'

const part = (id: string, definitionId: string, position: [number, number, number], basis: Mat3 = IDENTITY_BASIS): PartInstance => ({
  id,
  definitionId,
  color: 15,
  transform: { position, basis },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/** Fresh document object per call: derived state is memoized on identity. */
const withParts = (...parts: PartInstance[]): ModelDocument => {
  const base = createEmptyDocument()
  return {
    ...base,
    parts: Object.fromEntries(parts.map((item) => [item.id, item])),
    subassemblies: {
      ...base.subassemblies,
      hull: { ...base.subassemblies.hull, partIds: parts.map((item) => item.id) },
    },
  }
}

function plateTileId(): string {
  if (catalog.get('3070b')) return '3070b'
  const found = catalog.placeable().find((item) => {
    if (item.connectors.some((feature) => feature.family === 'stud')) return false
    const bounds = item.dimensions?.bounds
    return Boolean(bounds) && bounds!.max[1] - bounds!.min[1] <= 10
  })
  if (!found) throw new Error('compiled catalog has no plate-height tile')
  return found.canonicalId
}

describe('validation', () => {
  it('reports the showcase as clean and fully connected', () => {
    const report = validateDocument(createRoverDocument())
    expect(report.collisions).toEqual([])
    expect(report.componentCount).toBe(1)
    expect(report.disconnectedPartIds).toEqual([])
    expect(report.connectionCount).toBeGreaterThan(50)
  })

  it('marks a box-only verdict unverified rather than confirmed', () => {
    // Without resident geometry the kernel can only compare bounds. It says so
    // instead of presenting the result as a verified collision.
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [20, 0, 0]))
    const report = validateDocument(document, { provideGeometry: () => null })
    expect(report.collisions).toHaveLength(1)
    expect(report.collisions[0].certainty).toBe('unknown')
    expect(report.unverifiedCollisions).toBe(1)
    expect(report.collisions[0].message).toContain('unverified')
  })

  it('does not flag a legitimately stacked pair', () => {
    const document = withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [0, -24, 0]))
    const report = validateDocument(document, { provideGeometry: () => null })
    expect(report.collisions).toEqual([])
    expect(report.connectionCount).toBe(8)
  })

  it('separates unconnected islands', () => {
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [400, 0, 0]))
    const report = validateDocument(document, { provideGeometry: () => null })
    expect(report.componentCount).toBe(2)
    expect(report.disconnectedPartIds).toHaveLength(1)
  })

  it('treats two bricks on the table as grounded, not floating', () => {
    expect(floatingPartIds(withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [400, 0, 0])))).toEqual([])
  })

  it('flags a hovering brick that clutches to nothing', () => {
    expect(floatingPartIds(withParts(part('a', '3001', [0, 0, 0]), part('ghost', '3001', [0, -200, 0])))).toEqual(['ghost'])
  })

  it('does not flag a clutched stack as floating', () => {
    expect(floatingPartIds(withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [0, -24, 0])))).toEqual([])
  })

  it('flags a clutched stack that never reaches the ground beside a real building', () => {
    expect(
      airbornePartIds(
        withParts(
          part('ground', '3001', [0, 0, 0]),
          part('a', '3001', [400, -200, 0]),
          part('b', '3001', [400, -224, 0]),
        ),
      ).sort(),
    ).toEqual(['a', 'b'])
  })

  it('does not flag two buildings on the table as airborne', () => {
    expect(airbornePartIds(withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [400, 0, 0])))).toEqual([])
  })

  it('flags a brick resting on a tile with no clutch', () => {
    const tileId = plateTileId()
    const tile = part('tile', tileId, [0, 0, 0])
    const brickY = originForSurface(catalog.get('3001'), getPartBounds(tile).min[1])
    const stacked = withParts(tile, part('loose', '3001', [0, brickY, 0]))
    expect(floatingPartIds(stacked)).toEqual([])
    expect(unclutchedRestPartIds(stacked)).toEqual(['loose'])
  })

  it('does not flag a clutched stack as an unclutched rest', () => {
    expect(unclutchedRestPartIds(withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [0, -24, 0])))).toEqual([])
  })

  it('does not flag two buildings on the table as resting on each other', () => {
    expect(unclutchedRestPartIds(withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [400, 0, 0])))).toEqual([])
  })

  it('flags a part held by a single connector', () => {
    // The base brick has two neighbours; each 1x1 perched on a single stud has
    // exactly one, which is the classic "will fall off" warning.
    const document = withParts(
      part('base', '3001', [0, 0, 0]),
      part('perchA', '3005', [30, -24, 10]),
      part('perchB', '3005', [-30, -24, -10]),
    )
    expect(findWeakAttachments(document).map((entry) => entry.partId).sort()).toEqual(['perchA', 'perchB'])
  })

  it('treats an unobserved part/colour pairing as virtual, not illegal', () => {
    const document = withParts(part('a', '3001', [0, 0, 0]))
    document.parts.a.color = 999
    const report = validateDocument(document, { provideGeometry: () => null })
    expect(report.virtualColors).toHaveLength(1)
    expect(report.virtualColors[0].reason).toBe('unobserved')
    // Virtual colours are buildable and exportable, so the document stays healthy.
    expect(report.healthy).toBe(true)
  })

  it('fails a hard dimension constraint that the model exceeds', () => {
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [400, 0, 0]))
    document.constraints = [{ id: 'c', kind: 'dimensions', label: 'Envelope', value: { width: 4, depth: 4 }, hard: true }]
    const report = validateDocument(document, { provideGeometry: () => null })
    expect(report.constraints[0].status).toBe('fail')
    expect(report.healthy).toBe(false)
  })

  it('is invariant under a rigid transform of the whole model', () => {
    const base = createRoverDocument()
    const moved = createRoverDocument()
    // A genuine rigid transform composes with each part's own pose; overwriting
    // the pose instead would change the model, not move it.
    const world = { position: [137, -41, 89] as const, basis: basisFromEulerDegrees([0, 90, 0]) }
    for (const item of Object.values(moved.parts)) {
      item.transform = composeTransform(world, item.transform)
    }
    const a = validateDocument(base, { provideGeometry: () => null })
    const b = validateDocument(moved, { provideGeometry: () => null })
    // Moving the whole assembly cannot change its topology.
    expect(b.connectionCount).toBe(a.connectionCount)
    expect(b.componentCount).toBe(a.componentCount)
    expect(b.collisions.length).toBe(a.collisions.length)
    expect(b.disconnectedPartIds.length).toBe(a.disconnectedPartIds.length)
  })
})

describe('poseRefusal', () => {
  it('refuses a hover that used to be clutched', () => {
    const document = withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [0, -24, 0]))
    expect(poseRefusal(document, 'upper', { position: [0, -200, 0], basis: IDENTITY_BASIS })).toBe('DISCONNECTED')
  })

  it('allows a clutched stack to stay put', () => {
    const document = withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [0, -24, 0]))
    expect(poseRefusal(document, 'upper', document.parts.upper.transform)).toBeNull()
  })

  it('refuses sliding a brick onto a tile', () => {
    const tileId = plateTileId()
    const tile = part('tile', tileId, [0, 0, 0])
    const brickY = originForSurface(catalog.get('3001'), 0)
    const document = withParts(tile, part('loose', '3001', [400, brickY, 0]))
    const restY = originForSurface(catalog.get('3001'), getPartBounds(tile).min[1])
    expect(poseRefusal(document, 'loose', { position: [0, restY, 0], basis: IDENTITY_BASIS })).toBe('NO_COMPATIBLE_CONNECTOR')
  })

  it('refuses sliding an unconnected brick into another brick', () => {
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [400, 0, 0]))
    expect(poseRefusal(document, 'b', { position: [0, 0, 0], basis: IDENTITY_BASIS })).toBe('COLLISION')
  })
})
