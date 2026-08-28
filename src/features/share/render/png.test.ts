import { inflateSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { deflateRaw, encodeApng, encodePng, readChunkTypes, readPngHeader, zlibDeflate } from './png'

/**
 * The encoder is the foundation of every determinism claim in this workstream,
 * so it is checked against Node's zlib — an independent decoder — rather than
 * against itself. A round trip that only used our own inflater would prove
 * nothing.
 */

const gradient = (width: number, height: number) => {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4
      rgba[pixel] = (x * 7) & 0xff
      rgba[pixel + 1] = (y * 5) & 0xff
      rgba[pixel + 2] = ((x + y) * 3) & 0xff
      rgba[pixel + 3] = 255
    }
  }
  return { rgba, width, height }
}

const flat = (width: number, height: number, value = 32) => ({
  rgba: new Uint8ClampedArray(width * height * 4).fill(value),
  width,
  height,
})

describe('deflate', () => {
  it('produces a stream Node can inflate, byte for byte', () => {
    for (const source of [
      new Uint8Array(0),
      Uint8Array.from([0]),
      Uint8Array.from({ length: 300 }, (_, index) => index & 0xff),
      new Uint8Array(5000).fill(7),
      Uint8Array.from({ length: 20_000 }, (_, index) => (index * 31) & 0xff),
    ]) {
      expect(Uint8Array.from(inflateRawSync(deflateRaw(source)))).toEqual(source)
      expect(Uint8Array.from(inflateSync(zlibDeflate(source)))).toEqual(source)
    }
  })

  it('handles long runs, which is what a flat card background is', () => {
    const source = new Uint8Array(200_000).fill(0)
    const compressed = zlibDeflate(source)
    expect(Uint8Array.from(inflateSync(compressed))).toEqual(source)
    // A quarter-megabyte of one byte must not cost a quarter megabyte.
    expect(compressed.length).toBeLessThan(2000)
  })

  it('is deterministic', () => {
    const source = Uint8Array.from({ length: 9000 }, (_, index) => (index * 17 + (index >> 5)) & 0xff)
    expect(zlibDeflate(source)).toEqual(zlibDeflate(source))
  })
})

describe('png', () => {
  it('writes a truecolour-with-alpha PNG whose pixels survive a round trip', () => {
    const image = gradient(23, 17)
    const png = encodePng(image)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(readChunkTypes(png)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(readPngHeader(png)).toEqual({ width: 23, height: 17, bitDepth: 8, colourType: 6 })
    expect(decodePng(png)).toEqual(Uint8Array.from(image.rgba))
  })

  it('round-trips a fully transparent buffer, so a transparent export is real', () => {
    const image = { rgba: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16 }
    expect(decodePng(encodePng(image))).toEqual(Uint8Array.from(image.rgba))
  })

  it('is byte-identical for identical input', () => {
    expect(encodePng(gradient(40, 30))).toEqual(encodePng(gradient(40, 30)))
  })

  it('rejects a buffer that does not match its declared size', () => {
    expect(() => encodePng({ rgba: new Uint8ClampedArray(8), width: 4, height: 4 })).toThrow(/needs 64/)
  })
})

describe('apng', () => {
  it('emits animation control chunks in the order the specification requires', () => {
    const png = encodeApng([flat(8, 8, 10), flat(8, 8, 20), flat(8, 8, 30)], 40)
    expect(readChunkTypes(png)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND'])
    // The first frame is a plain IDAT, so a decoder that ignores APNG still
    // shows a real image rather than nothing.
    expect(decodePng(png)).toEqual(Uint8Array.from(flat(8, 8, 10).rgba))
  })

  it('records the frame count and a rational delay', () => {
    const png = encodeApng([flat(4, 4), flat(4, 4)], 42)
    const { actl, firstFctl } = readAnimationChunks(png)
    expect(actl.frames).toBe(2)
    expect(firstFctl).toMatchObject({ sequence: 0, width: 4, height: 4, delayNum: 42, delayDen: 1000 })
  })

  it('refuses frames of differing size rather than emitting a broken file', () => {
    expect(() => encodeApng([flat(4, 4), flat(5, 4)], 40)).toThrow(/dimensions/)
  })
})

// ---------------------------------------------------------------------------
// Minimal reference decoder, used only by these tests.
// ---------------------------------------------------------------------------

function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const found: Array<{ type: string; data: Uint8Array }> = []
  let cursor = 8
  while (cursor + 8 <= png.length) {
    const length = view.getUint32(cursor)
    const type = String.fromCharCode(png[cursor + 4], png[cursor + 5], png[cursor + 6], png[cursor + 7])
    found.push({ type, data: png.subarray(cursor + 8, cursor + 8 + length) })
    cursor += 12 + length
  }
  return found
}

function readAnimationChunks(png: Uint8Array) {
  const found = chunks(png)
  const actlData = found.find((entry) => entry.type === 'acTL')!.data
  const fctlData = found.find((entry) => entry.type === 'fcTL')!.data
  const actlView = new DataView(actlData.buffer, actlData.byteOffset, actlData.byteLength)
  const fctlView = new DataView(fctlData.buffer, fctlData.byteOffset, fctlData.byteLength)
  return {
    actl: { frames: actlView.getUint32(0), plays: actlView.getUint32(4) },
    firstFctl: {
      sequence: fctlView.getUint32(0),
      width: fctlView.getUint32(4),
      height: fctlView.getUint32(8),
      delayNum: fctlView.getUint16(20),
      delayDen: fctlView.getUint16(22),
    },
  }
}

/** Unfilters the first frame back to RGBA. */
function decodePng(png: Uint8Array): Uint8Array {
  const header = readPngHeader(png)
  const idat = chunks(png).filter((entry) => entry.type === 'IDAT')
  const raw = Uint8Array.from(inflateSync(Buffer.concat(idat.map((entry) => Buffer.from(entry.data)))))
  const stride = header.width * 4
  const out = new Uint8Array(header.height * stride)
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    for (let index = 0; index < stride; index += 1) {
      const value = raw[y * (stride + 1) + 1 + index]
      const left = index >= 4 ? out[y * stride + index - 4] : 0
      const up = y > 0 ? out[(y - 1) * stride + index] : 0
      const upLeft = y > 0 && index >= 4 ? out[(y - 1) * stride + index - 4] : 0
      const restored =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + up
              : filter === 3
                ? value + ((left + up) >> 1)
                : value + paethPredictor(left, up, upLeft)
      out[y * stride + index] = restored & 0xff
    }
  }
  return out
}

function paethPredictor(a: number, b: number, c: number) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
