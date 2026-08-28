import { describe, expect, it } from 'vitest'
import { IDENTITY_BASIS } from '../../../cad/math'
import { renderScene, rgbFromHex } from '../../../cad/raster'
import { boxMesh, privateDocument } from '../__fixtures__/model'
import { serializePublishedDocument } from '../serialize'
import { buildScene, cameraBasis, frameForCard } from './scene'
import { STUDIO_PRESETS } from './presets'

/**
 * The camera trick, pinned.
 *
 * `scene.ts` restates the rasteriser's private camera basis so it can build the
 * pitch and roll axes. That copy is the one thing in this workstream that can
 * silently drift out of step with `src/cad/raster.ts`, so these tests assert the
 * relationship through the rasteriser's actual output rather than through the
 * duplicated constants.
 */

const published = serializePublishedDocument(privateDocument(3))
const geometry = () => boxMesh()
const palette = (code: number) => rgbFromHex(code === 4 ? '#b40000' : '#f4f4f4')

const scene = (yaw: number, pitch = 0, roll = 0) =>
  buildScene(published, geometry, { camera: { yaw, pitch, roll }, palette })

const renderAt = (yaw: number, pitch = 0) => {
  const built = scene(yaw, pitch)
  const framing = frameForCard(built.fullBounds, 64, 64, STUDIO_PRESETS.contact.framing, 1)
  return renderScene(built.parts, framing, { palette, outlineNew: false })
}

describe('camera basis', () => {
  it('is the identity with no camera move', () => {
    expect(cameraBasis({ yaw: 0, pitch: 0, roll: 0 }).map((value) => Math.round(value * 1e6) / 1e6)).toEqual([
      ...IDENTITY_BASIS,
    ])
  })

  it('is a rotation: orthonormal, determinant 1', () => {
    const basis = cameraBasis({ yaw: 37, pitch: -18, roll: 12 })
    const determinant =
      basis[0] * (basis[4] * basis[8] - basis[5] * basis[7]) -
      basis[1] * (basis[3] * basis[8] - basis[5] * basis[6]) +
      basis[2] * (basis[3] * basis[7] - basis[4] * basis[6])
    expect(determinant).toBeCloseTo(1, 9)
    for (let row = 0; row < 3; row += 1) {
      const length = Math.hypot(basis[row * 3], basis[row * 3 + 1], basis[row * 3 + 2])
      expect(length).toBeCloseTo(1, 9)
    }
  })

  it('turns the model on its own vertical axis, so a full turn is a no-op', () => {
    const start = scene(0).parts.map((part) => part.transform.position)
    const full = scene(360).parts.map((part) => part.transform.position)
    for (const [index, position] of full.entries()) {
      for (let axis = 0; axis < 3; axis += 1) expect(position[axis]).toBeCloseTo(start[index][axis], 6)
    }
    // A yaw leaves the model's own vertical extent alone — that is what makes it
    // a turntable rather than a tumble.
    expect(scene(90).fullBounds.min[1]).toBeCloseTo(scene(0).fullBounds.min[1], 6)
    expect(scene(90).fullBounds.max[1]).toBeCloseTo(scene(0).fullBounds.max[1], 6)
  })

  it('actually changes the rasterised image', () => {
    const straight = renderAt(0)
    const turned = renderAt(90)
    expect(straight.coverage).toBeGreaterThan(0)
    expect(Array.from(turned.rgba)).not.toEqual(Array.from(straight.rgba))
    // Both still frame the model rather than losing it off the edge.
    expect(turned.coverage).toBeGreaterThan(0.05)
  })

  it('pitches about the camera’s right axis, which moves the horizon', () => {
    const level = renderAt(0, 0)
    const raised = renderAt(0, 40)
    expect(Array.from(raised.rgba)).not.toEqual(Array.from(level.rgba))
    expect(raised.coverage).toBeGreaterThan(0.05)
  })
})

describe('scene assembly', () => {
  it('reports the definitions it could not resolve and draws the rest', () => {
    const partial = buildScene(
      published,
      (definitionId) => (definitionId === '3001' ? boxMesh() : null),
      { camera: { yaw: 0, pitch: 0, roll: 0 }, palette },
    )
    expect(partial.missingDefinitionIds).toEqual(['3020'])
    expect(partial.parts).toHaveLength(3)
  })

  it('keeps framing bounds over the whole model while drawing a subset', () => {
    const all = buildScene(published, geometry, { camera: { yaw: 0, pitch: 0, roll: 0 }, palette })
    const first = buildScene(published, geometry, {
      camera: { yaw: 0, pitch: 0, roll: 0 },
      palette,
      include: new Set(['part_001']),
    })
    expect(first.parts).toHaveLength(1)
    // `fullBounds` is what the scrubber frames from, so it must not shrink.
    expect(first.fullBounds).toEqual(all.fullBounds)
    expect(first.bounds.max[0]).toBeLessThan(all.bounds.max[0])
  })

  it('marks only the highlighted parts as new', () => {
    const built = buildScene(published, geometry, {
      camera: { yaw: 0, pitch: 0, roll: 0 },
      palette,
      highlight: new Set(['part_002']),
    })
    expect(built.parts.filter((part) => part.isNew)).toHaveLength(1)
    // With no highlight set, everything is at full saturation.
    expect(
      buildScene(published, geometry, { camera: { yaw: 0, pitch: 0, roll: 0 }, palette }).parts.every(
        (part) => part.isNew,
      ),
    ).toBe(true)
  })

  it('pushes parts outward when exploded, and leaves the centre alone', () => {
    const assembled = buildScene(published, geometry, { camera: { yaw: 0, pitch: 0, roll: 0 }, palette })
    const exploded = buildScene(published, geometry, { camera: { yaw: 0, pitch: 0, roll: 0 }, palette, explode: 1 })
    const span = (built: ReturnType<typeof buildScene>) => built.fullBounds.max[0] - built.fullBounds.min[0]
    expect(span(exploded)).toBeGreaterThan(span(assembled))
    // Clamped, so a hostile value cannot scatter the model to infinity.
    expect(span(buildScene(published, geometry, { camera: { yaw: 0, pitch: 0, roll: 0 }, palette, explode: 999 }))).toBe(
      span(buildScene(published, geometry, { camera: { yaw: 0, pitch: 0, roll: 0 }, palette, explode: 3 })),
    )
  })

  it('returns a usable empty scene when nothing can be drawn', () => {
    const empty = buildScene(published, () => null, { camera: { yaw: 0, pitch: 0, roll: 0 }, palette })
    expect(empty.parts).toEqual([])
    expect(empty.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 1] })
  })
})

describe('framing', () => {
  it('re-centres as it zooms rather than dragging the model into a corner', () => {
    const bounds = { min: [-40, -40, -40] as const, max: [40, 40, 40] as const }
    const base = frameForCard(bounds, 200, 100, { padding: 0.1, zoom: 1, offsetX: 0, offsetY: 0 }, 1)
    const zoomed = frameForCard(bounds, 200, 100, { padding: 0.1, zoom: 2, offsetX: 0, offsetY: 0 }, 1)
    expect(zoomed.scale).toBeCloseTo(base.scale * 2, 9)
    // A symmetric box centred on the origin stays centred at any zoom.
    expect(zoomed.offsetU).toBeCloseTo(base.offsetU, 6)
    expect(zoomed.offsetV).toBeCloseTo(base.offsetV, 6)
  })

  it('pans by a fraction of the frame', () => {
    const bounds = { min: [-40, -40, -40] as const, max: [40, 40, 40] as const }
    const centred = frameForCard(bounds, 200, 100, { padding: 0.1, zoom: 1, offsetX: 0, offsetY: 0 }, 1)
    const panned = frameForCard(bounds, 200, 100, { padding: 0.1, zoom: 1, offsetX: 0.25, offsetY: -0.5 }, 1)
    expect(panned.offsetU - centred.offsetU).toBeCloseTo(50, 6)
    expect(panned.offsetV - centred.offsetV).toBeCloseTo(50, 6)
  })
})
