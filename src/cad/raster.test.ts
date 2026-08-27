import { describe, expect, it } from 'vitest'
import { IDENTITY_BASIS, basisFromEulerDegrees } from './math'
import { frameScene, renderScene, rgbFromHex, type RasterPart } from './raster'

/**
 * The rasterizer is the only renderer whose output can be asserted, so the
 * properties that make a printed page readable are checked here rather than
 * eyeballed in a screenshot.
 */

/** Axis-aligned box centred on the origin, as 12 triangles. */
function box(size: number, height = size, depth = size) {
  const x = size / 2
  const y = height / 2
  const z = depth / 2
  const corners = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ]
  const faces = [
    [0, 1, 2], [0, 2, 3], // -z
    [5, 4, 7], [5, 7, 6], // +z
    [4, 0, 3], [4, 3, 7], // -x
    [1, 5, 6], [1, 6, 2], // +x
    [4, 5, 1], [4, 1, 0], // -y
    [3, 2, 6], [3, 6, 7], // +y
  ]
  return {
    positions: new Float32Array(corners.flat()),
    indices: new Uint32Array(faces.flat()),
    slices: [],
  }
}

const part = (overrides: Partial<RasterPart> = {}): RasterPart => ({
  ...box(20),
  transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
  rgb: [0.8, 0.15, 0.12],
  isNew: true,
  ...overrides,
})

const bounds = { min: [-40, -40, -40] as const, max: [40, 40, 40] as const }

/** Mean of one channel over covered pixels only. */
function meanChannel(rgba: Uint8ClampedArray, channel: number) {
  let total = 0
  let count = 0
  for (let pixel = 0; pixel < rgba.length; pixel += 4) {
    if (rgba[pixel + 3] < 250) continue
    total += rgba[pixel + channel]
    count += 1
  }
  return count ? total / count : 0
}

describe('scene rasterizer', () => {
  it('draws inside the frame with coverage in alpha', () => {
    const framing = frameScene(bounds, 96, 72, { supersample: 2 })
    const image = renderScene([part()], framing)

    expect(image.width).toBe(96)
    expect(image.height).toBe(72)
    expect(image.coverage).toBeGreaterThan(0.02)

    // Padding means the model never touches the border, which is what keeps a
    // printed page from looking cropped.
    for (let x = 0; x < image.width; x += 1) {
      expect(image.rgba[x * 4 + 3]).toBe(0)
      expect(image.rgba[((image.height - 1) * image.width + x) * 4 + 3]).toBe(0)
    }
    // Fully-interior pixels are opaque, background is not drawn at all.
    const opaque = [...Array(image.width * image.height).keys()].filter((pixel) => image.rgba[pixel * 4 + 3] === 255)
    expect(opaque.length).toBeGreaterThan(100)
  })

  it('keeps the camera fixed as the assembly grows', () => {
    const framing = frameScene(bounds, 160, 120, { supersample: 2 })
    const first = part({ isNew: false })
    const second = part({ transform: { position: [40, 0, 0], basis: IDENTITY_BASIS }, isNew: false })

    const alone = renderScene([first], framing, { outlineNew: false })
    const secondAlone = renderScene([second], framing, { outlineNew: false })
    const together = renderScene([first, second], framing, { outlineNew: false })

    // Where the second part draws nothing it cannot occlude anything, so those
    // pixels must be byte-identical to the earlier page. A framing that drifted
    // between steps — the thing that makes a booklet unreadable — fails here.
    let compared = 0
    for (let pixel = 0; pixel < alone.rgba.length; pixel += 4) {
      if (secondAlone.rgba[pixel + 3] !== 0) continue
      compared += 1
      expect(together.rgba[pixel]).toBe(alone.rgba[pixel])
      expect(together.rgba[pixel + 1]).toBe(alone.rgba[pixel + 1])
      expect(together.rgba[pixel + 2]).toBe(alone.rgba[pixel + 2])
      expect(together.rgba[pixel + 3]).toBe(alone.rgba[pixel + 3])
    }
    expect(compared).toBeGreaterThan(1000)
    expect(together.coverage).toBeGreaterThan(alone.coverage)
  })

  it('washes placed parts and leaves new parts saturated', () => {
    const framing = frameScene(bounds, 80, 64, { supersample: 2 })
    const asNew = renderScene([part({ isNew: true })], framing, { outlineNew: false })
    const asPlaced = renderScene([part({ isNew: false })], framing, { outlineNew: false })

    // The part is red, so washing toward white shows up as a rise in the two
    // channels it barely has.
    expect(meanChannel(asPlaced.rgba, 1)).toBeGreaterThan(meanChannel(asNew.rgba, 1) + 40)
    expect(meanChannel(asPlaced.rgba, 2)).toBeGreaterThan(meanChannel(asNew.rgba, 2) + 40)
    // Coverage is identical: the wash changes colour, not silhouette.
    expect(asPlaced.coverage).toBeCloseTo(asNew.coverage, 5)
  })

  it('outlines new geometry so it reads on a monochrome print', () => {
    const framing = frameScene(bounds, 80, 64, { supersample: 2 })
    const plain = renderScene([part()], framing, { outlineNew: false })
    const outlined = renderScene([part()], framing, { outlineNew: true })

    let darkened = 0
    for (let pixel = 0; pixel < plain.rgba.length; pixel += 4) {
      if (plain.rgba[pixel + 3] === 0) continue
      if (outlined.rgba[pixel] < plain.rgba[pixel] - 10) darkened += 1
    }
    expect(darkened).toBeGreaterThan(20)
    // Only the boundary is touched, never the whole face.
    expect(darkened).toBeLessThan(plain.coverage * plain.width * plain.height * 0.5)
  })

  it('puts the top of the model at the top of the image, LDraw Y-down', () => {
    // In LDraw, *negative* y is up. Framing is symmetric about the origin and the
    // cube sits at y = -40, so a correct up hint puts every drawn pixel in the
    // top half. A sign error here is exactly what made the first part thumbnails
    // show hollow undersides instead of studs.
    const framing = frameScene({ min: [-60, -60, -60], max: [60, 60, 60] }, 96, 96, { supersample: 2 })
    const image = renderScene(
      [part({ ...box(14), transform: { position: [0, -40, 0], basis: IDENTITY_BASIS } })],
      framing,
      { outlineNew: false },
    )

    let topRows = 0
    let bottomRows = 0
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (image.rgba[(y * image.width + x) * 4 + 3] === 0) continue
        if (y < image.height / 2) topRows += 1
        else bottomRows += 1
      }
    }
    expect(topRows).toBeGreaterThan(0)
    expect(bottomRows).toBe(0)
  })

  it('honours baked slice colours over the instance colour', () => {
    const framing = frameScene(bounds, 64, 64, { supersample: 1 })
    const geometry = box(20)
    const inherited = renderScene([part({ ...geometry, rgb: [0.9, 0.9, 0.9] })], framing, { outlineNew: false })
    const baked = renderScene(
      [
        part({
          ...geometry,
          // Every triangle in one slice, painted black rather than the instance's white.
          slices: [{ colour: 0, start: 0, count: geometry.indices.length }],
          rgb: [0.9, 0.9, 0.9],
        }),
      ],
      framing,
      { outlineNew: false, palette: () => [0.05, 0.05, 0.05] },
    )
    expect(meanChannel(baked.rgba, 0)).toBeLessThan(meanChannel(inherited.rgba, 0) - 80)
  })

  it('renders a rotated part differently from an unrotated one', () => {
    const framing = frameScene(bounds, 72, 72, { supersample: 2 })
    const flat = renderScene([part({ ...box(40, 8, 20) })], framing, { outlineNew: false })
    const turned = renderScene(
      [part({ ...box(40, 8, 20), transform: { position: [0, 0, 0], basis: basisFromEulerDegrees([0, 90, 0]) } })],
      framing,
      { outlineNew: false },
    )
    let differing = 0
    for (let pixel = 0; pixel < flat.rgba.length; pixel += 4) {
      if (flat.rgba[pixel + 3] !== turned.rgba[pixel + 3]) differing += 1
    }
    expect(differing).toBeGreaterThan(50)
  })

  it('parses hex colours, including short form and rubbish', () => {
    expect(rgbFromHex('#ffffff')).toEqual([1, 1, 1])
    expect(rgbFromHex('000000')).toEqual([0, 0, 0])
    expect(rgbFromHex('#f00')).toEqual([1, 0, 0])
    expect(rgbFromHex('#zzzzzz')[0]).toBeGreaterThan(0)
  })
})
