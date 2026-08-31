import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildMergedEdgeGeometry, instanceCapacity, writeInstanceMatrices, type BatchMember } from '../PartBatch'
import { IDENTITY_BASIS } from '../../cad/math'
import { allocateEdgeVertexCounts } from './quality'

describe('slack capacity', () => {
  it('does not shrink or reallocate within its bucket', () => {
    const capacity = instanceCapacity(7000)
    expect(capacity).toBe(8192)
    expect(instanceCapacity(7001, capacity)).toBe(capacity)
    expect(instanceCapacity(1, capacity)).toBe(capacity)
    expect(instanceCapacity(8193, capacity)).toBe(16384)
  })
})

describe('bounded large batch edges', () => {
  it.each([7000, 11000])('keeps actual line geometry for %i members, bounded and spatially distributed', count => {
    const box = new THREE.BoxGeometry(20, 24, 40)
    const edges = new THREE.EdgesGeometry(box)
    const members: BatchMember[] = Array.from({ length: count }, (_, index) => {
      const transform = { position: [index * 40, 0, 0] as const, basis: IDENTITY_BASIS }
      return { transform, part: { id: String(index), definitionId: '3001', color: 4, transform, subassemblyId: 'hull', stepId: 'step_1', provenance: 'human', protected: false } }
    })
    const merged = buildMergedEdgeGeometry(members, edges, 6000)!
    expect(merged).not.toBeNull()
    const positions = merged.getAttribute('position')
    expect(positions.count).toBe(6000)
    merged.computeBoundingBox()
    expect(merged.boundingBox!.max.x).toBeGreaterThan(count * 40 * 0.98)
    expect(merged.boundingBox!.min.x).toBeLessThan(count * 40 * 0.02)
    const allocation = allocateEdgeVertexCounts([{ key: 'giant', vertices: positions.count, screenPixels: 100 }], { minScreenPixels: 18, vertexBudget: 1001 })
    expect(allocation.get('giant')).toBe(1000)
    merged.setDrawRange(0, allocation.get('giant'))
    expect(merged.drawRange.count).toBeGreaterThan(0)
    merged.dispose(); edges.dispose(); box.dispose()
  })

  it('prioritizes apparent size and rejects invisible/subpixel batches', () => {
    const allocation = allocateEdgeVertexCounts([
      { key: 'far', vertices: 1000, screenPixels: 20 },
      { key: 'near', vertices: 1000, screenPixels: 80 },
      { key: 'hidden', vertices: 1000, screenPixels: 0 },
    ], { vertexBudget: 1200, minScreenPixels: 18 })
    expect([...allocation.entries()]).toEqual([['near', 1000], ['far', 200]])
  })
})

/**
 * What a commit costs the instance buffers.
 *
 * `planBatches` hands every batch a fresh member array on every commit, so the
 * upload effect cannot use array identity to decide whether anything moved. It
 * asks the buffer instead. The property is "an unchanged pose costs no write",
 * and the write count is the only way to observe it.
 */
describe('instance matrix writes', () => {
  /** cos 45°, which no 32-bit float can hold exactly. */
  const ROTATED = [
    0.7071067811865476, 0, -0.7071067811865476,
    0, 1, 0,
    0.7071067811865476, 0, 0.7071067811865476,
  ]

  // Offset from the origin deliberately: `InstancedMesh` fills a fresh buffer
  // with identity matrices, so a part at the origin with an identity basis is
  // *already* in the buffer and correctly costs no write.
  const poseAt = (index: number, rotated = false) =>
    ({ position: [(index + 1) * 20, -(index + 1) * 24, (index + 1) * 20], basis: rotated ? ROTATED : IDENTITY_BASIS }) as unknown as BatchMember['transform']

  const memberAt = (index: number, rotated = false): BatchMember => {
    const transform = poseAt(index, rotated)
    return { transform, part: { id: `p${index}`, definitionId: '3001', color: 4, transform, subassemblyId: 'hull', stepId: 'step_1', provenance: 'human', protected: false } }
  }

  const batchOf = (count: number) =>
    new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), count)

  it('writes every pose into a fresh buffer', () => {
    const members = Array.from({ length: 64 }, (_, index) => memberAt(index))
    const mesh = batchOf(64)
    expect(writeInstanceMatrices(mesh, members)).toBe(64)
    // And the poses actually landed, so "wrote nothing" later means "already
    // correct" rather than "never wrote anything".
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(63, matrix)
    expect(matrix.elements[12]).toBeCloseTo(64 * 20, 3)
    expect(matrix.elements[14]).toBeCloseTo(64 * 20, 3)
    mesh.dispose()
  })

  it('writes nothing for a plan whose poses did not move', () => {
    const members = Array.from({ length: 64 }, (_, index) => memberAt(index))
    const mesh = batchOf(64)
    writeInstanceMatrices(mesh, members)
    expect(writeInstanceMatrices(mesh, members)).toBe(0)
  })

  it('writes nothing for fresh member objects carrying the same poses', () => {
    // The case that matters: `planBatches` rebuilds the arrays on every commit,
    // so identity is gone and only the values are the same. Every third part is
    // rotated 45°, whose basis a 32-bit buffer cannot hold exactly — comparing
    // the stored value against the 64-bit source without `Math.fround` reports
    // every one of them as moved, on every commit.
    const build = () => Array.from({ length: 64 }, (_, index) => memberAt(index, index % 3 === 0))
    const mesh = batchOf(64)
    writeInstanceMatrices(mesh, build())
    expect(writeInstanceMatrices(mesh, build())).toBe(0)
  })

  it('writes exactly the part that moved', () => {
    const members = Array.from({ length: 64 }, (_, index) => memberAt(index))
    const mesh = batchOf(64)
    writeInstanceMatrices(mesh, members)
    const moved = [...members]
    moved[17] = { ...members[17], transform: { position: [4, 8, 12], basis: IDENTITY_BASIS } as unknown as BatchMember['transform'] }
    expect(writeInstanceMatrices(mesh, moved)).toBe(1)
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(17, matrix)
    expect([matrix.elements[12], matrix.elements[13], matrix.elements[14]]).toEqual([4, 8, 12])
  })

  it('notices a pose mutated in place', () => {
    // A reference check on the Transform object would be faster and would miss
    // this, leaving a moved brick drawn where it used to be. The comparison is
    // against the buffer for exactly this reason.
    const members = Array.from({ length: 8 }, (_, index) => memberAt(index))
    const mesh = batchOf(8)
    writeInstanceMatrices(mesh, members)
    ;(members[3].transform.position as unknown as number[])[1] -= 8
    expect(writeInstanceMatrices(mesh, members)).toBe(1)
  })
})

/**
 * What a shortened `drawRange` costs a part.
 *
 * A compiled LDraw brick is mostly stud edges: a 2x4 carries about 216 line
 * segments and twelve of them are the box. A uniform sample at a quarter density
 * therefore keeps a scatter of stud chords and loses corners, which reads as the
 * brick dissolving rather than as reduced detail. The buffer is emitted longest
 * edge first so the cut lands on the chords instead.
 */
describe('merged edges degrade by length', () => {
  /** Four long segments and twelve short ones, in the order a compiler emits. */
  const mixedEdges = () => {
    const positions: number[] = []
    const push = (from: [number, number, number], to: [number, number, number]) => positions.push(...from, ...to)
    for (let index = 0; index < 12; index += 1) {
      // Short chords, interleaved so a prefix of the source order is mostly short.
      push([index, 0, 0], [index + 1, 0, 0])
      if (index % 3 === 0) push([0, index * 40, 0], [0, index * 40, 100])
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    return geometry
  }

  const members = (count: number): BatchMember[] =>
    Array.from({ length: count }, (_, index) => {
      const transform = { position: [index * 400, 0, 0] as const, basis: IDENTITY_BASIS }
      return { transform, part: { id: String(index), definitionId: '3001', color: 4, transform, subassemblyId: 'hull', stepId: 'step_1', provenance: 'human', protected: false } }
    })

  const lengths = (geometry: THREE.BufferGeometry) => {
    const position = geometry.getAttribute('position')
    const out: number[] = []
    for (let segment = 0; segment < position.count / 2; segment += 1) {
      const a = segment * 2
      out.push(
        Math.hypot(
          position.getX(a + 1) - position.getX(a),
          position.getY(a + 1) - position.getY(a),
          position.getZ(a + 1) - position.getZ(a),
        ),
      )
    }
    return out
  }

  it('keeps the long edges and spends the cut on the short ones', () => {
    const edges = mixedEdges()
    const batch = members(6)
    // Four long segments per part, six parts: a budget of 48 vertices is exactly
    // the long ones and nothing else.
    const merged = buildMergedEdgeGeometry(batch, edges, 48)!
    expect(merged.getAttribute('position').count).toBe(48)
    expect(lengths(merged).every(length => length > 99)).toBe(true)
    merged.dispose()
    edges.dispose()
  })

  it('still spans the whole batch when it cannot draw every part', () => {
    // Longest-first must not become first-part-first: a prefix shorter than the
    // batch has to come from parts spread across it, or a shortened draw range
    // outlines one corner of the model and nothing else.
    const edges = mixedEdges()
    const batch = members(400)
    const merged = buildMergedEdgeGeometry(batch, edges, 200)!
    merged.computeBoundingBox()
    expect(merged.boundingBox!.max.x).toBeGreaterThan(399 * 400 * 0.95)
    expect(merged.boundingBox!.min.x).toBeLessThan(399 * 400 * 0.05)
    merged.dispose()
    edges.dispose()
  })

  it('draws every segment when the budget is ample', () => {
    // Reordering is free for a model inside its budget: same segments, and so
    // the same picture.
    const edges = mixedEdges()
    const batch = members(3)
    const merged = buildMergedEdgeGeometry(batch, edges, 1_000_000)!
    const perPart = edges.getAttribute('position').count / 2
    expect(merged.getAttribute('position').count).toBe(perPart * 2 * 3)
    const long = lengths(merged).filter(length => length > 99).length
    expect(long).toBe(4 * 3)
    merged.dispose()
    edges.dispose()
  })
})

it('selected overlay materials win coplanar surface depth', async () => {
  const { surfaceMaterialFor } = await import('../PartVisual')
  const selected = surfaceMaterialFor(4, 'selected')
  expect(selected.polygonOffset).toBe(true)
  expect(selected.polygonOffsetFactor).toBe(-1)
  expect(selected.polygonOffsetUnits).toBe(-1)
  expect(surfaceMaterialFor(4, 'solid').polygonOffset).toBe(false)
})
