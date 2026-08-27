import { describe, expect, it } from 'vitest'
import { compileMesh } from '../../tools/ldraw-mesh.mjs'
import { compileThumbnail, encodePng, renderThumbnail } from '../../tools/thumbnail.mjs'
import { decodeMesh } from './mesh'

/**
 * The thumbnail stage is a software rasterizer, so the properties worth pinning
 * are that it produces a valid PNG, that it is deterministic (asset hashes depend
 * on it), and that it stays colour-independent so one asset serves all 322 LDraw
 * colours.
 */

const library = (files: Record<string, string>) => (reference: string) => {
  const text = files[reference.replace(/\\/g, '/').toLowerCase()]
  return text === undefined ? null : { text, key: reference }
}

/** A unit box, enough to exercise projection, shading and coverage. */
const BOX = [
  '0 Box',
  '0 BFC CERTIFY CCW',
  '4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10',
  '4 16 -10 -20 -10 -10 -20 10 10 -20 10 10 -20 -10',
  '4 16 -10 0 -10 -10 -20 -10 10 -20 -10 10 0 -10',
  '4 16 10 0 10 10 -20 10 -10 -20 10 -10 0 10',
  '4 16 -10 0 10 -10 -20 10 -10 -20 -10 -10 0 -10',
  '4 16 10 0 -10 10 -20 -10 10 -20 10 10 0 10',
].join('\n')

const meshOf = (source: string, extra: Record<string, string> = {}) => {
  const compiled = compileMesh('p.dat', library({ 'p.dat': source, ...extra }), { parseCache: new Map() })!
  return decodeMesh(new Uint8Array(compiled.buffer).buffer)
}

const readPng = (buffer: Buffer) => {
  expect([...buffer.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks: Array<{ type: string; length: number }> = []
  let cursor = 8
  while (cursor < buffer.length) {
    const length = buffer.readUInt32BE(cursor)
    chunks.push({ type: buffer.subarray(cursor + 4, cursor + 8).toString('ascii'), length })
    cursor += 12 + length
  }
  return { chunks, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bitDepth: buffer[24], colourType: buffer[25] }
}

describe('thumbnail renderer', () => {
  it('emits a well-formed truecolour-with-alpha PNG', () => {
    const result = compileThumbnail(meshOf(BOX), { size: 64 })!
    const png = readPng(result.buffer)
    expect(png.chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect({ width: png.width, height: png.height, bitDepth: png.bitDepth, colourType: png.colourType }).toEqual({
      width: 64,
      height: 64,
      bitDepth: 8,
      colourType: 6,
    })
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic, so asset hashes are stable across builds', () => {
    const a = compileThumbnail(meshOf(BOX), { size: 64 })!
    const b = compileThumbnail(meshOf(BOX), { size: 64 })!
    expect(a.hash).toBe(b.hash)
    expect(a.buffer.equals(b.buffer)).toBe(true)
  })

  it('covers a substantial part of the frame without filling it', () => {
    const rendered = renderThumbnail(meshOf(BOX), { size: 64 })!
    let covered = 0
    for (let pixel = 0; pixel < 64 * 64; pixel += 1) {
      if (rendered.rgba[pixel * 4 + 3] > 128) covered += 1
    }
    const ratio = covered / (64 * 64)
    // The part is framed with padding, so it neither fills the canvas nor
    // disappears into it.
    expect(ratio).toBeGreaterThan(0.2)
    expect(ratio).toBeLessThan(0.85)
  })

  it('stays colour-independent: shading in RGB, coverage in alpha', () => {
    const rendered = renderThumbnail(meshOf(BOX), { size: 64 })!
    let opaqueGrey = 0
    let opaque = 0
    for (let pixel = 0; pixel < 64 * 64; pixel += 1) {
      const [r, g, b, a] = [
        rendered.rgba[pixel * 4],
        rendered.rgba[pixel * 4 + 1],
        rendered.rgba[pixel * 4 + 2],
        rendered.rgba[pixel * 4 + 3],
      ]
      if (a < 250) continue
      opaque += 1
      // A part with no baked colours must be pure greyscale, so the runtime can
      // tint it with any LDraw colour.
      if (r === g && g === b) opaqueGrey += 1
    }
    expect(opaque).toBeGreaterThan(100)
    expect(opaqueGrey).toBe(opaque)
  })

  it('shades faces differently, so form is readable', () => {
    const rendered = renderThumbnail(meshOf(BOX), { size: 64 })!
    const levels = new Set<number>()
    for (let pixel = 0; pixel < 64 * 64; pixel += 1) {
      if (rendered.rgba[pixel * 4 + 3] > 250) levels.add(rendered.rgba[pixel * 4])
    }
    // A cube seen from three-quarters shows at least three distinct faces.
    expect(levels.size).toBeGreaterThanOrEqual(3)
  })

  it('darkens a slice with a baked colour so it reads as dark material', () => {
    // Colour 0 is black; a slice painted with it must not render as light grey.
    const withBlack = meshOf(
      [
        '0 Part',
        '0 BFC CERTIFY CCW',
        '4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10',
        '4 0 -10 -20 -10 10 -20 -10 10 -20 10 -10 -20 10',
      ].join('\n'),
    )
    const rendered = renderThumbnail(withBlack, { size: 64 })!
    let darkest = 255
    for (let pixel = 0; pixel < 64 * 64; pixel += 1) {
      if (rendered.rgba[pixel * 4 + 3] > 250) darkest = Math.min(darkest, rendered.rgba[pixel * 4])
    }
    expect(darkest).toBeLessThan(90)
  })

  it('returns null for geometry with no triangles', () => {
    expect(renderThumbnail({ positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), slices: [] } as never)).toBeNull()
  })

  it('encodes an arbitrary buffer at the declared size', () => {
    const rgba = Buffer.alloc(4 * 4 * 4, 200)
    const png = readPng(encodePng(rgba, 4))
    expect({ width: png.width, height: png.height }).toEqual({ width: 4, height: 4 })
  })
})
