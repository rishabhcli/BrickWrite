import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { findArticulatedJoints, type ArticulatedJoint } from '../../cad/articulation'
import { clearCollisionGeometryCache, findCollisions, geometryFromArrays, type GeometryProvider } from '../../cad/collision'
import { CadEngine } from '../../cad/engine'
import { IDENTITY_BASIS, type Mat3 } from '../../cad/math'
import { decodeMesh } from '../../cad/mesh'
import { createEmptyDocument } from '../../cad/sample'
import type { CadOperation, ModelDocument, PartInstance } from '../../cad/types'
import { previewTransforms } from './jointDrag'
import { describeSweep, sweepJoint, sweepNeighbourhood } from './sweep'

/**
 * The sweep is only meaningful against real triangles.
 *
 * Geometry comes from the committed `.bwmesh` pack — the same bytes the browser
 * fetches — so a blocked hinge here is blocked in the product. A box-only test
 * would report the flap colliding with its own base at every angle and prove
 * nothing.
 */
const PUBLIC_ROOT = path.resolve('public')

const packGeometry = (() => {
  const index = new Map<string, string>()
  try {
    const pointer = JSON.parse(readFileSync(path.join(PUBLIC_ROOT, 'catalog/latest.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(PUBLIC_ROOT, pointer.manifest.path), 'utf8'))
    const parts = JSON.parse(readFileSync(path.join(PUBLIC_ROOT, manifest.files.parts.path), 'utf8'))
    for (const record of parts) {
      if (record.geometryAsset?.file) index.set(record.canonicalId, record.geometryAsset.file)
    }
  } catch {
    // No committed pack: the suite skips rather than exercising a box-only path
    // and appearing to pass.
  }
  return index
})()

const HAVE_PACK = ['3937', '3938', '3024'].every((id) => packGeometry.has(id))

const geometries = new Map<string, THREE.BufferGeometry | null>()
const provide: GeometryProvider = (definitionId) => {
  if (geometries.has(definitionId)) return geometries.get(definitionId)!
  const file = packGeometry.get(definitionId)
  if (!file) {
    geometries.set(definitionId, null)
    return null
  }
  const bytes = readFileSync(path.join(PUBLIC_ROOT, file))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const mesh = decodeMesh(buffer)
  const geometry = geometryFromArrays(mesh.positions, mesh.indices, mesh.normals)
  geometries.set(definitionId, geometry)
  return geometry
}

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

/**
 * A hinge with a mast standing on its flap.
 *
 * The bare hinge is the wrong test subject: `3938` is 40 LDU across and pivots
 * about a point inside itself, so its swept envelope barely moves and any
 * obstacle close enough to be hit is already touching at rest. Four plates
 * stacked on the flap give the mechanism a real radius — the tip travels from
 * z = −10 to z = +47 over the swing — which is what makes "clear at rest,
 * blocked part-way" an arrangement that can exist at all.
 */
const hinge = () =>
  assemble([
    part('base', '3937', [0, 0, 0]),
    part('flap', '3938', [0, 0, 0]),
    part('r0', '3024', [10, -8, 0]),
    part('r1', '3024', [10, -16, 0]),
    part('r2', '3024', [10, -24, 0]),
    part('tip', '3024', [10, -32, 0]),
  ])
const jointOf = (document: ModelDocument): ArticulatedJoint => findArticulatedJoints(document, ['flap'])[0]

/**
 * Places an obstacle exactly where the mast's tip will be part-way through the
 * swing.
 *
 * Deriving the obstacle from the motion rather than guessing a coordinate is
 * what makes this test independent of the parts' own measurements: whatever
 * `3937`/`3938`/`3024` turn out to be, the obstacle is in the arc and nowhere
 * near the rest pose.
 */
function withObstacleAt(document: ModelDocument, joint: ArticulatedJoint, degrees: number): ModelDocument {
  const posed = previewTransforms(document, joint, { rotateDegrees: degrees, slideLdu: 0 }).get('tip')
  if (!posed) throw new Error('The hinge produced no preview to place an obstacle against.')
  return {
    ...document,
    parts: { ...document.parts, wall: part('wall', '3024', [...posed.position] as [number, number, number]) },
  }
}

describe.skipIf(!HAVE_PACK)('swept collision along a joint', () => {
  beforeAll(() => {
    clearCollisionGeometryCache()
    expect(provide('3937')).not.toBeNull()
    expect(provide('3938')).not.toBeNull()
    expect(provide('3024')).not.toBeNull()
  })

  it('reports the whole range clear when nothing is in the way', () => {
    const document = hinge()
    const joint = jointOf(document)
    const result = sweepJoint(document, joint, { rotateDegrees: -70, slideLdu: 0 }, { provide })
    expect(result.blocking).toBeNull()
    expect(result.permissibleFraction).toBe(1)
    expect(result.permissible.rotateDegrees).toBeCloseTo(-70, 6)
    expect(describeSweep(result, { rotateDegrees: -70, slideLdu: 0 })).toMatch(/Clear/)
  })

  it('finds the pair that stops the motion, and how far it gets first', () => {
    const document = hinge()
    const joint = jointOf(document)
    // A plate sitting where the mast reaches at −40° of a −70° swing.
    const blocked = withObstacleAt(document, joint, -40)
    const blockedJoint = jointOf(blocked)
    const result = sweepJoint(blocked, blockedJoint, { rotateDegrees: -70, slideLdu: 0 }, { provide })

    expect(result.blocking).not.toBeNull()
    expect([result.blocking!.partA, result.blocking!.partB]).toContain('wall')
    // The block is *found*, not merely suspected: the motion is permitted up to
    // the contact and no further.
    expect(result.permissibleFraction).toBeGreaterThan(0)
    expect(result.permissibleFraction).toBeLessThan(1)
    expect(Math.abs(result.permissible.rotateDegrees)).toBeLessThan(70)
    expect(describeSweep(result, { rotateDegrees: -70, slideLdu: 0 })).toMatch(/Blocked by/)
  })

  it('catches an obstacle in the middle that the endpoint alone would miss', () => {
    // The failure the sweep exists to prevent: a door clear at 10° and clear at
    // 170° is not clear, because it passed through the frame at 90°.
    const document = hinge()
    const joint = jointOf(document)
    const blocked = withObstacleAt(document, joint, -40)
    const blockedJoint = jointOf(blocked)

    // The destination at −80° is past the obstacle and clean on its own. This
    // is asserted directly against the kernel, so the claim is about the model
    // rather than about how the sweep happens to sample.
    const island = new Set(blockedJoint.movingPartIds)
    const parts = { ...blocked.parts }
    for (const [partId, transform] of previewTransforms(blocked, blockedJoint, { rotateDegrees: -80, slideLdu: 0 })) {
      parts[partId] = { ...parts[partId], transform }
    }
    const atDestination = findCollisions({ ...blocked, parts }, { onlyPartIds: [...island], provide })
      .filter((contact) => !(island.has(contact.partA) && island.has(contact.partB)))
    expect(atDestination).toEqual([])

    // The path is not.
    const swept = sweepJoint(blocked, blockedJoint, { rotateDegrees: -80, slideLdu: 0 }, { provide, samples: 20 })
    expect(swept.blocking).not.toBeNull()
    expect([swept.blocking!.partA, swept.blocking!.partB]).toContain('wall')
    expect(swept.permissibleFraction).toBeLessThan(0.7)
  })

  it('refines the boundary rather than reporting the coarse bucket', () => {
    const document = hinge()
    const joint = jointOf(document)
    const blocked = withObstacleAt(document, joint, -40)
    const blockedJoint = jointOf(blocked)
    const coarse = sweepJoint(blocked, blockedJoint, { rotateDegrees: -70, slideLdu: 0 }, { provide, samples: 8, refinements: 0 })
    const refined = sweepJoint(blocked, blockedJoint, { rotateDegrees: -70, slideLdu: 0 }, { provide, samples: 8, refinements: 8 })
    // Bisection can only move the answer forward: it finds clean poses the
    // coarse scan stepped over.
    expect(refined.permissibleFraction).toBeGreaterThanOrEqual(coarse.permissibleFraction)
    expect(refined.samples).toBeGreaterThan(coarse.samples)
  })

  it('does not report contacts the model already had before the drag', () => {
    // A hinge's two halves interleave their fingers, so they are permanently in
    // contact. Reporting that would make every joint appear seized.
    const document = hinge()
    const joint = jointOf(document)
    const result = sweepJoint(document, joint, { rotateDegrees: -15, slideLdu: 0 }, { provide })
    expect(result.blocking).toBeNull()
  })

  it('does nothing at all for a request that drives nothing', () => {
    const document = hinge()
    const joint = jointOf(document)
    const result = sweepJoint(document, joint, { rotateDegrees: 0, slideLdu: 0 }, { provide })
    expect(result.samples).toBe(0)
    expect(result.blocking).toBeNull()
  })
})

describe.skipIf(!HAVE_PACK)('sweep scope', () => {
  it('cuts the document down to what the motion can reach', () => {
    // The kernel's exact rules are affordable here only because the problem is
    // small: tens of parts, not thousands.
    const base = hinge()
    const joint = jointOf(base)
    const far = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `far_${index}`,
        part(`far_${index}`, '3024', [4000 + index * 40, 0, 0]),
      ]),
    )
    const large: ModelDocument = { ...base, parts: { ...base.parts, ...far } }
    const scope = sweepNeighbourhood(large, joint, { rotateDegrees: -70, slideLdu: 0 })
    expect(scope).not.toBeNull()
    expect(Object.keys(scope!.document.parts).length).toBeLessThan(20)
    expect(Object.keys(scope!.document.parts)).toContain('flap')
  })

  it('carries the connection edges across, or every hinge would read as a collision', () => {
    const base = hinge()
    const joint = jointOf(base)
    const scope = sweepNeighbourhood(base, joint, { rotateDegrees: -45, slideLdu: 0 })!
    expect(Object.keys(scope.document.connections).length).toBeGreaterThan(0)
  })
})

describe.skipIf(!HAVE_PACK)('the cost the caller has to budget against', () => {
  it('reports how long it took, so a drag can decide whether it can afford another', () => {
    const document = hinge()
    const joint = jointOf(document)
    const result = sweepJoint(document, joint, { rotateDegrees: 90, slideLdu: 0 }, { provide })

    // Not asserted to be fast — it is fast on six parts and need not be on
    // eleven thousand. Asserted to be *measured*, because the drag rations the
    // sweep against this number and a zero would mean it never rations.
    expect(result.elapsedMs).toBeGreaterThan(0)
    expect(Number.isFinite(result.elapsedMs)).toBe(true)
    expect(result.samples).toBeGreaterThan(0)
  })

  it('costs nothing to report nothing', () => {
    const document = hinge()
    const result = sweepJoint(document, jointOf(document), { rotateDegrees: 0, slideLdu: 0 }, { provide })
    expect(result.elapsedMs).toBe(0)
    expect(result.samples).toBe(0)
  })
})
