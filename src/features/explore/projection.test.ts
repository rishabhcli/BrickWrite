import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DemoPreview } from '../../demos'
import {
  buildScene,
  cameraBasis,
  depthOf,
  explodeOffsets,
  fitScene,
  PART_FIELDS,
  pointInPolygon,
  project,
  shadeHex,
  visibleFaces,
  type Camera,
} from './projection'

/**
 * The projection is the whole renderer.
 *
 * Nothing else decides what the explorer draws, so it is tested directly rather
 * than through a canvas that jsdom cannot rasterise: the camera basis, the fit,
 * which faces are visible from where, the depth order and the hit test.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..')
// Read whichever demo the manifest ships first rather than naming one: the
// collection changes, and a projection test should not be the thing that breaks
// when a demo is retired.
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/demos/manifest.json'), 'utf8')) as {
  demos: Array<{ assets: { preview: { url: string } } }>
}
const preview = JSON.parse(
  readFileSync(path.join(ROOT, 'public', manifest.demos[0].assets.preview.url.replace(/^\//, '')), 'utf8'),
) as DemoPreview

const CAMERA: Camera = { yaw: 38, pitch: 26, zoom: 1 }

describe('the camera basis', () => {
  it('is orthonormal, and looks down when the pitch is positive', () => {
    const basis = cameraBasis(CAMERA)
    const length = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2])
    for (const axis of [basis.forward, basis.right, basis.up]) expect(length(axis)).toBeCloseTo(1, 6)
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    expect(dot(basis.forward, basis.right)).toBeCloseTo(0, 6)
    expect(dot(basis.forward, basis.up)).toBeCloseTo(0, 6)
    expect(dot(basis.right, basis.up)).toBeCloseTo(0, 6)
    // LDraw is Y-down, so looking down the model means a positive Y component.
    expect(basis.forward[1]).toBeGreaterThan(0)
    expect(basis.up[1]).toBeLessThan(0)
  })

  it('agrees with the offline rasterizer at its fixed three-quarter view', () => {
    // src/cad/raster.ts renders every still from normalize([0.82, 0.62, 0.95]).
    const reference = [0.82, 0.62, 0.95]
    const norm = Math.hypot(...reference)
    const yaw = (Math.atan2(reference[0], reference[2]) * 180) / Math.PI
    const pitch = (Math.asin(reference[1] / norm) * 180) / Math.PI
    const basis = cameraBasis({ yaw, pitch, zoom: 1 })
    for (let axis = 0; axis < 3; axis += 1) {
      expect(basis.forward[axis]).toBeCloseTo(reference[axis] / norm, 6)
    }
  })
})

describe('fitting a model into a viewport', () => {
  it('keeps the whole model on screen, at any orbit', () => {
    const viewport = { width: 800, height: 500 }
    for (const yaw of [0, 45, 137, -96, 200]) {
      for (const pitch of [-60, 0, 26, 70]) {
        const basis = cameraBasis({ yaw, pitch, zoom: 1 })
        const fit = fitScene(preview.boundsLdu, basis, viewport, { padding: 0.1 })
        for (let corner = 0; corner < 8; corner += 1) {
          const point = [
            corner & 1 ? preview.boundsLdu.max[0] : preview.boundsLdu.min[0],
            corner & 2 ? preview.boundsLdu.max[1] : preview.boundsLdu.min[1],
            corner & 4 ? preview.boundsLdu.max[2] : preview.boundsLdu.min[2],
          ] as const
          const [x, y] = project(point, basis, fit)
          expect(x).toBeGreaterThanOrEqual(-1)
          expect(x).toBeLessThanOrEqual(viewport.width + 1)
          expect(y).toBeGreaterThanOrEqual(-1)
          expect(y).toBeLessThanOrEqual(viewport.height + 1)
        }
      }
    }
  })

  it('scales linearly with zoom', () => {
    const basis = cameraBasis(CAMERA)
    const one = fitScene(preview.boundsLdu, basis, { width: 800, height: 500 }, { zoom: 1 })
    const two = fitScene(preview.boundsLdu, basis, { width: 800, height: 500 }, { zoom: 2 })
    expect(two.scale / one.scale).toBeCloseTo(2, 6)
  })
})

describe('box faces', () => {
  const min = [0, -24, 0] as const
  const max = [40, 0, 20] as const

  it('returns exactly the three faces a camera can see, one per axis', () => {
    const faces = visibleFaces(min, max, cameraBasis(CAMERA))
    expect(faces).toHaveLength(3)
    expect(new Set(faces.map((face) => face.axis))).toEqual(new Set([0, 1, 2]))
  })

  it('shows the top face while the camera is above the model, and the underside below it', () => {
    const above = visibleFaces(min, max, cameraBasis({ ...CAMERA, pitch: 30 })).find((face) => face.axis === 1)!
    const below = visibleFaces(min, max, cameraBasis({ ...CAMERA, pitch: -30 })).find((face) => face.axis === 1)!
    // LDraw is Y-down: the top of a box is its minimum Y.
    expect(above.corners.every((corner) => corner[1] === min[1])).toBe(true)
    expect(below.corners.every((corner) => corner[1] === max[1])).toBe(true)
  })

  it('emits each face as a simple rectangle rather than a crossed ring', () => {
    for (const face of visibleFaces(min, max, cameraBasis(CAMERA))) {
      const [a, b, c, d] = face.corners
      // Opposite corners of a rectangle share no coordinate on the spanned axes.
      const spanned = [0, 1, 2].filter((axis) => axis !== face.axis)
      for (const axis of spanned) {
        expect(a[axis] === b[axis] || a[axis] === d[axis]).toBe(true)
        expect(new Set([a[axis], b[axis], c[axis], d[axis]]).size).toBe(2)
      }
    }
  })

  it('shades the top face brightest, matching the rasterizer’s key light', () => {
    const faces = visibleFaces(min, max, cameraBasis(CAMERA))
    const byAxis = new Map(faces.map((face) => [face.axis, face.shade]))
    expect(byAxis.get(1)!).toBeGreaterThan(byAxis.get(2)!)
    expect(byAxis.get(2)!).toBeGreaterThan(byAxis.get(0)!)
    for (const shade of byAxis.values()) expect(shade).toBeGreaterThan(0.4)
  })
})

describe('the scene', () => {
  const basis = cameraBasis(CAMERA)

  it('is depth-sorted farthest first, so the painter’s order is right', () => {
    const scene = buildScene(preview, basis)
    expect(scene).toHaveLength(preview.parts.length)
    for (let index = 1; index < scene.length; index += 1) {
      expect(scene[index - 1].depth).toBeGreaterThanOrEqual(scene[index].depth)
    }
    expect(scene[0].depth).toBeCloseTo(depthOf(scene[0].centre, basis), 6)
  })

  it('draws only what a build step has introduced', () => {
    const first = buildScene(preview, basis, { stepLimit: 1 })
    const all = buildScene(preview, basis)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThan(all.length)
    expect(first.every((box) => box.step === 0)).toBe(true)
    expect(buildScene(preview, basis, { stepLimit: preview.steps.length })).toHaveLength(all.length)
  })

  it('moves each sub-assembly outward, and no further at rest', () => {
    const offsets = explodeOffsets(preview)
    expect(offsets).toHaveLength(preview.subassemblies.length)
    for (const offset of offsets) expect(Math.hypot(...offset)).toBeCloseTo(1, 6)

    const rest = buildScene(preview, basis, { explode: 0, explodeOffsets: offsets })
    const apart = buildScene(preview, basis, { explode: 1, explodeOffsets: offsets, spreadLdu: 120 })
    const restBySub = new Map(rest.map((box) => [box.index, box]))
    let moved = 0
    for (const box of apart) {
      const original = restBySub.get(box.index)!
      const distance = Math.hypot(
        box.centre[0] - original.centre[0],
        box.centre[1] - original.centre[1],
        box.centre[2] - original.centre[2],
      )
      if (distance > 1) moved += 1
      expect(distance).toBeLessThanOrEqual(120.001)
    }
    expect(moved).toBeGreaterThan(preview.parts.length / 2)
  })

  it('preserves every part’s catalog identity through the scene build', () => {
    for (const box of buildScene(preview, basis)) {
      const source = preview.parts[box.index]
      expect(box.definition).toBe(source[PART_FIELDS.definition])
      expect(box.color).toBe(source[PART_FIELDS.color])
      expect(preview.definitions[box.definition]).toBeTruthy()
      expect(preview.colors[box.color]).toBeTruthy()
    }
  })
})

describe('hit testing', () => {
  it('finds a point inside a projected face and rejects one outside it', () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]]
    expect(pointInPolygon([5, 5], square)).toBe(true)
    expect(pointInPolygon([11, 5], square)).toBe(false)
    expect(pointInPolygon([-1, -1], square)).toBe(false)
  })

  it('lands on a real part when a ray is aimed at the middle of the model', () => {
    const basis = cameraBasis(CAMERA)
    const viewport = { width: 800, height: 500 }
    const fit = fitScene(preview.boundsLdu, basis, viewport, { padding: 0.1 })
    const scene = buildScene(preview, basis)
    const nearest = [...scene].reverse()
    const centre: [number, number] = [viewport.width / 2, viewport.height / 2]
    const hit = nearest.find((box) =>
      visibleFaces(box.min, box.max, basis).some((face) =>
        pointInPolygon(centre, face.corners.map((corner) => project(corner, basis, fit))),
      ),
    )
    expect(hit).toBeTruthy()
    expect(preview.partIds[hit!.index]).toMatch(/^part_/)
  })
})

describe('shading a colour', () => {
  it('darkens toward zero and clamps at full brightness', () => {
    expect(shadeHex('#ffffff', 1)).toBe('rgb(255, 255, 255)')
    expect(shadeHex('#808080', 0.5)).toBe('rgb(64, 64, 64)')
    expect(shadeHex('#ffffff', 2)).toBe('rgb(255, 255, 255)')
    expect(shadeHex('not-a-colour', 1)).toBe('not-a-colour')
  })
})
