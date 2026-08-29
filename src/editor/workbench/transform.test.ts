import { describe, expect, it } from 'vitest'
import { canonicalTransform, degreesToRadians, IDENTITY_BASIS, isOrthonormal, rotateLocal, rotateWorld } from '../../cad/math'
import type { Transform } from '../../cad/types'
import {
  applyLocks,
  canonicalisePose,
  gizmoPose,
  numericPose,
  planRotateSelection,
  planTranslateSelection,
  poseKey,
  posesEqual,
  readNumericPose,
  rotatePose,
  snapPosition,
  translatePose,
} from './transform'

/**
 * Gate: numeric entry and gizmo manipulation must produce identical canonical
 * matrices.
 *
 * If they did not, the document would carry two spellings of one placement:
 * exports would differ, the connector solver would see two different poses, and
 * typing back the number the inspector shows would move the part. Everything
 * funnels through `canonicalisePose`; these tests are what make that a fact
 * rather than an intention.
 */

const identity: Transform = { position: [0, 0, 0], basis: IDENTITY_BASIS }
const tilted: Transform = { position: [37.5, -24, 11.25], basis: rotateLocal(identity, [0, 1, 0], degreesToRadians(30)).basis }

describe('canonical pose', () => {
  it('normalises negative zero so two spellings of one pose compare equal', () => {
    const a = canonicalisePose({ position: [-0, 0, -0], basis: IDENTITY_BASIS })
    const b = canonicalisePose({ position: [0, 0, 0], basis: IDENTITY_BASIS })
    expect(canonicalTransform(a)).toBe(canonicalTransform(b))
  })

  it('re-orthonormalises a basis that composition has sheared', () => {
    // A sheared basis is refused by the kernel's operation validator, so every
    // produced pose has to arrive orthonormal. The residual rotation is kept
    // rather than snapped away — this repairs the shear, it does not invent a
    // pose the operator did not ask for.
    const sheared: Transform = { position: [0, 0, 0], basis: [1, 0.0000004, 0, 0, 1, 0, 0, 0, 1] }
    const cleaned = canonicalisePose(sheared)
    expect(isOrthonormal(cleaned.basis, 1e-12)).toBe(true)
  })

  it('leaves an already-exact basis untouched', () => {
    expect(canonicalisePose({ position: [0, 0, 0], basis: IDENTITY_BASIS }).basis).toEqual(IDENTITY_BASIS)
  })
})

describe('numeric entry and gizmo manipulation agree', () => {
  it('a snapped gizmo drop equals typing the coordinate it landed on', () => {
    // The gizmo reports an arbitrary dragged position; the stud grid decides
    // where it actually lands.
    const dragged: Transform = { position: [43.7, -21.2, 8.9], basis: IDENTITY_BASIS }
    const fromGizmo = gizmoPose(identity, dragged, { gridLdu: 20 })
    const landed = snapPosition(dragged.position, 20)
    const fromFields = numericPose(identity, { position: landed })
    expect(poseKey(fromGizmo)).toBe(poseKey(fromFields))
    expect(fromGizmo.position).toEqual([40, -20, 0])
  })

  it('reading a gizmo result into the fields and recommitting does not move the part', () => {
    const dragged: Transform = { position: [61.4, -47.9, -13.05], basis: tilted.basis }
    const committed = gizmoPose(tilted, dragged, { gridLdu: 10 })
    const shown = readNumericPose(committed)
    const recommitted = numericPose(committed, { position: shown.position, rotationDegrees: shown.rotationDegrees })
    expect(poseKey(recommitted)).toBe(poseKey(committed))
    expect(posesEqual(recommitted, committed)).toBe(true)
  })

  it.each([90, 180, 270, 37, 5, -45])('a %s° numeric rotation equals the same gizmo rotation', (degrees) => {
    const fromFields = numericPose(identity, { rotationDegrees: [0, degrees, 0] })
    const fromGizmo = gizmoPose(identity, rotateLocal(identity, [0, 1, 0], degreesToRadians(degrees)), { rotating: true })
    expect(poseKey(fromFields)).toBe(poseKey(fromGizmo))
  })

  it.each([
    ['X', [1, 0, 0], 0],
    ['Y', [0, 1, 0], 1],
    ['Z', [0, 0, 1], 2],
  ] as const)('agrees on the %s axis for an off-grid angle', (_label, axis, index) => {
    const degrees = 23.5
    const rotation: [number, number, number] = [0, 0, 0]
    rotation[index] = degrees
    const fromFields = numericPose(identity, { rotationDegrees: rotation })
    const fromGizmo = gizmoPose(identity, rotateLocal(identity, axis, degreesToRadians(degrees)), { rotating: true })
    expect(poseKey(fromFields)).toBe(poseKey(fromGizmo))
  })

  it('four quarter turns return exactly to the starting matrix', () => {
    let pose = tilted
    for (let turn = 0; turn < 4; turn += 1) pose = rotatePose(pose, [0, 1, 0], 90, 'local')
    expect(poseKey(pose)).toBe(poseKey(canonicalisePose(tilted)))
  })

  it('a stepper nudge equals typing the resulting coordinate', () => {
    const nudged = translatePose(tilted, [20, 0, 0], 'world')
    const typed = numericPose(tilted, {
      position: [tilted.position[0] + 20, tilted.position[1], tilted.position[2]],
    })
    expect(poseKey(nudged)).toBe(poseKey(typed))
  })

  it('a world-frame turn about the part origin matches the gizmo world rotation', () => {
    const degrees = 45
    const viaPanel = rotatePose(tilted, [0, 1, 0], degrees, 'world', tilted.position)
    const viaGizmo = gizmoPose(
      tilted,
      rotateWorld(tilted, [0, 1, 0], degreesToRadians(degrees), tilted.position),
      { rotating: true },
    )
    expect(poseKey(viaPanel)).toBe(poseKey(viaGizmo))
  })
})

describe('axis locks', () => {
  it('keeps a locked component at its previous value', () => {
    const next: Transform = { position: [100, 100, 100], basis: IDENTITY_BASIS }
    const locked = applyLocks(identity, next, { x: true, y: false, z: true })
    expect(locked.position).toEqual([0, 100, 0])
  })

  it('lets an unlocked drag through untouched', () => {
    const next: Transform = { position: [100, 100, 100], basis: IDENTITY_BASIS }
    expect(applyLocks(identity, next, { x: false, y: false, z: false })).toBe(next)
  })

  it('applies through the gizmo path, so a locked axis cannot be dragged', () => {
    const dragged: Transform = { position: [60, 40, 20], basis: IDENTITY_BASIS }
    const pose = gizmoPose(identity, dragged, { gridLdu: 20, locks: { x: false, y: true, z: false } })
    expect(pose.position).toEqual([60, 0, 20])
  })
})

describe('reference frames', () => {
  it('moves along the part’s own axes in the local frame', () => {
    const turned = canonicalisePose(rotateLocal(identity, [0, 1, 0], degreesToRadians(90)))
    const world = translatePose(turned, [20, 0, 0], 'world')
    const local = translatePose(turned, [20, 0, 0], 'local')
    expect(world.position).toEqual([20, 0, 0])
    // A 90° yaw sends the part's +X down document -Z, so the two frames must
    // disagree — if they did not, the control would be decorative.
    expect(local.position[0]).toBeCloseTo(0, 6)
    expect(Math.abs(local.position[2])).toBeCloseTo(20, 6)
  })
})

describe('planRotateSelection', () => {
  const brick = (id: string, position: [number, number, number]) => ({
    id,
    definitionId: '3001',
    color: 72,
    transform: { position, basis: IDENTITY_BASIS },
    subassemblyId: 'hull',
    stepId: 'step_1',
    provenance: 'human' as const,
    protected: false,
  })

  it('turns one part about its own origin', () => {
    const part = brick('a', [40, 0, 10])
    const operations = planRotateSelection([part], 90)
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ type: 'part.transform', partId: 'a' })
    const next = operations[0]!.type === 'part.transform' ? operations[0].transform : identity
    expect(next.position).toEqual([40, 0, 10])
    expect(poseKey(next)).toBe(poseKey(rotatePose(part.transform, [0, 1, 0], 90, 'local')))
  })

  it('turns several parts about the selection centre so relative clutch is kept', () => {
    const parts = [brick('a', [0, 0, 0]), brick('b', [0, -24, 0])]
    const before = Math.hypot(
      parts[1]!.transform.position[0] - parts[0]!.transform.position[0],
      parts[1]!.transform.position[1] - parts[0]!.transform.position[1],
      parts[1]!.transform.position[2] - parts[0]!.transform.position[2],
    )
    const operations = planRotateSelection(parts, 90)
    expect(operations).toHaveLength(2)
    const after = Object.fromEntries(
      operations.flatMap((operation) => (operation.type === 'part.transform' ? [[operation.partId, operation.transform]] : [])),
    ) as Record<string, Transform>
    expect(after.a).toBeDefined()
    expect(after.b).toBeDefined()
    const kept = Math.hypot(
      after.b.position[0] - after.a.position[0],
      after.b.position[1] - after.a.position[1],
      after.b.position[2] - after.a.position[2],
    )
    expect(kept).toBeCloseTo(before, 6)
    expect(after.a.position[1]).toBeCloseTo(0, 6)
    expect(after.b.position[1]).toBeCloseTo(-24, 6)
  })
})

describe('planTranslateSelection', () => {
  const brick = (id: string, position: [number, number, number]) => ({
    id,
    definitionId: '3001',
    color: 72,
    transform: { position, basis: IDENTITY_BASIS },
    subassemblyId: 'hull',
    stepId: 'step_1',
    provenance: 'human' as const,
    protected: false,
  })

  it('moves several parts by one world delta so relative clutch is kept', () => {
    const parts = [brick('a', [0, 0, 0]), brick('b', [0, -24, 0])]
    const operations = planTranslateSelection(parts, [40, 0, 20])
    expect(operations).toHaveLength(2)
    const after = Object.fromEntries(
      operations.flatMap((operation) => (operation.type === 'part.transform' ? [[operation.partId, operation.transform.position]] : [])),
    ) as Record<string, [number, number, number]>
    expect(after.a).toEqual([40, 0, 20])
    expect(after.b).toEqual([40, -24, 20])
  })
})
