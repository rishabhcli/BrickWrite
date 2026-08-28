/**
 * Deterministic PNG and APNG encoding.
 *
 * Share cards have to be byte-identical for the same revision and preset — that
 * is the property the determinism gate checks, and it is what lets a card be
 * served with an immutable cache header and addressed by the SHA-256 of its own
 * bytes. Neither `canvas.toDataURL` nor `zlib.deflateSync` gives that: the
 * first depends on the browser's PNG writer, the second on the zlib build.
 *
 * So the encoder is written here, end to end, with no dependencies:
 *
 *   - a fixed-Huffman DEFLATE with a bounded greedy matcher, so the compressed
 *     bytes are a pure function of the input;
 *   - adaptive PNG scanline filtering by the standard minimum-absolute-sum
 *     heuristic, which is what makes a flat studio background nearly free;
 *   - the same code path in the browser, in Node and in a Cloudflare Worker.
 *
 * The cost is a few percent of compression against zlib level 9. The benefit is
 * that "the same model produces the same file" is a fact rather than a hope.
 */

// ---------------------------------------------------------------------------
// Bit writer
// ---------------------------------------------------------------------------

class BitWriter {
  private buffer: Uint8Array
  private length = 0
  private bits = 0
  private bitCount = 0

  constructor(capacity: number) {
    this.buffer = new Uint8Array(Math.max(64, capacity))
  }

  private ensure(extra: number) {
    if (this.length + extra <= this.buffer.length) return
    const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + extra))
    grown.set(this.buffer.subarray(0, this.length))
    this.buffer = grown
  }

  /** Appends `count` bits of `value`, least-significant bit first. */
  writeBits(value: number, count: number) {
    this.bits |= (value & ((1 << count) - 1)) << this.bitCount
    this.bitCount += count
    while (this.bitCount >= 8) {
      this.ensure(1)
      this.buffer[this.length++] = this.bits & 0xff
      this.bits >>>= 8
      this.bitCount -= 8
    }
  }

  /** Huffman codes are defined most-significant bit first; DEFLATE is not. */
  writeCode(code: number, length: number) {
    let reversed = 0
    for (let index = 0; index < length; index += 1) reversed = (reversed << 1) | ((code >> index) & 1)
    this.writeBits(reversed, length)
  }

  finish(): Uint8Array {
    if (this.bitCount > 0) {
      this.ensure(1)
      this.buffer[this.length++] = this.bits & 0xff
      this.bits = 0
      this.bitCount = 0
    }
    return this.buffer.subarray(0, this.length)
  }
}

// ---------------------------------------------------------------------------
// Fixed-Huffman DEFLATE (RFC 1951)
// ---------------------------------------------------------------------------

/** Length codes 257–285: base length and extra-bit count. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
/** Distance codes 0–29. */
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
]
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]

/** Fixed literal/length code table from RFC 1951 §3.2.6. */
function fixedLiteralCode(symbol: number): { code: number; length: number } {
  if (symbol <= 143) return { code: 0b00110000 + symbol, length: 8 }
  if (symbol <= 255) return { code: 0b110010000 + (symbol - 144), length: 9 }
  if (symbol <= 279) return { code: symbol - 256, length: 7 }
  return { code: 0b11000000 + (symbol - 280), length: 8 }
}

const LITERAL_CODES = new Uint16Array(288)
const LITERAL_LENGTHS = new Uint8Array(288)
for (let symbol = 0; symbol < 288; symbol += 1) {
  const { code, length } = fixedLiteralCode(symbol)
  LITERAL_CODES[symbol] = code
  LITERAL_LENGTHS[symbol] = length
}

const WINDOW = 32768
const MIN_MATCH = 3
const MAX_MATCH = 258
/**
 * How far back the matcher walks a hash chain.
 *
 * A hard cap is what keeps the encoder both fast and deterministic: the result
 * depends only on the input, never on how long a search was allowed to run.
 */
const MAX_CHAIN = 64

function lengthCodeFor(length: number): number {
  for (let index = LENGTH_BASE.length - 1; index >= 0; index -= 1) {
    if (length >= LENGTH_BASE[index]) return index
  }
  return 0
}

function distanceCodeFor(distance: number): number {
  for (let index = DISTANCE_BASE.length - 1; index >= 0; index -= 1) {
    if (distance >= DISTANCE_BASE[index]) return index
  }
  return 0
}

/**
 * Raw DEFLATE stream, one fixed-Huffman block.
 *
 * A single block keeps the output a straightforward function of the input; the
 * block-splitting heuristics that a production zlib uses would buy a little
 * ratio at the cost of the determinism this exists for.
 */
export function deflateRaw(input: Uint8Array): Uint8Array {
  const writer = new BitWriter(Math.max(64, input.length >> 1))
  writer.writeBits(1, 1) // BFINAL
  writer.writeBits(1, 2) // BTYPE = fixed Huffman

  const head = new Int32Array(1 << 15).fill(-1)
  const previous = new Int32Array(input.length).fill(-1)
  const mask = (1 << 15) - 1
  const hashAt = (position: number) =>
    position + 2 < input.length
      ? ((input[position] << 10) ^ (input[position + 1] << 5) ^ input[position + 2]) & mask
      : -1

  let position = 0
  while (position < input.length) {
    const key = hashAt(position)
    let bestLength = 0
    let bestDistance = 0

    if (key >= 0) {
      let candidate = head[key]
      let chain = 0
      const limit = Math.min(MAX_MATCH, input.length - position)
      while (candidate >= 0 && chain < MAX_CHAIN) {
        const distance = position - candidate
        if (distance > WINDOW) break
        // Cheap rejection first: if the byte that would extend the current best
        // does not match, this candidate cannot beat it.
        if (input[candidate + bestLength] === input[position + bestLength]) {
          let length = 0
          while (length < limit && input[candidate + length] === input[position + length]) length += 1
          if (length > bestLength) {
            bestLength = length
            bestDistance = distance
            if (length === limit) break
          }
        }
        candidate = previous[candidate]
        chain += 1
      }
    }

    if (bestLength >= MIN_MATCH) {
      const lengthCode = lengthCodeFor(bestLength)
      writer.writeCode(LITERAL_CODES[257 + lengthCode], LITERAL_LENGTHS[257 + lengthCode])
      if (LENGTH_EXTRA[lengthCode]) writer.writeBits(bestLength - LENGTH_BASE[lengthCode], LENGTH_EXTRA[lengthCode])
      const distanceCode = distanceCodeFor(bestDistance)
      // Distance codes use a flat 5-bit code in the fixed table.
      writer.writeCode(distanceCode, 5)
      if (DISTANCE_EXTRA[distanceCode]) {
        writer.writeBits(bestDistance - DISTANCE_BASE[distanceCode], DISTANCE_EXTRA[distanceCode])
      }
      // Insert every position the match covers, so later matches can still find
      // the interior of a run.
      for (let step = 0; step < bestLength; step += 1) {
        const insertAt = position + step
        const insertKey = hashAt(insertAt)
        if (insertKey >= 0) {
          previous[insertAt] = head[insertKey]
          head[insertKey] = insertAt
        }
      }
      position += bestLength
      continue
    }

    writer.writeCode(LITERAL_CODES[input[position]], LITERAL_LENGTHS[input[position]])
    if (key >= 0) {
      previous[position] = head[key]
      head[key] = position
    }
    position += 1
  }

  writer.writeCode(LITERAL_CODES[256], LITERAL_LENGTHS[256]) // end of block
  return writer.finish()
}

function adler32(input: Uint8Array): number {
  let a = 1
  let b = 0
  // 5552 is the largest run that cannot overflow the 32-bit accumulators.
  for (let start = 0; start < input.length; start += 5552) {
    const end = Math.min(start + 5552, input.length)
    for (let index = start; index < end; index += 1) {
      a += input[index]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

/** zlib container (RFC 1950) around one raw DEFLATE block. */
export function zlibDeflate(input: Uint8Array): Uint8Array {
  const body = deflateRaw(input)
  const out = new Uint8Array(body.length + 6)
  out[0] = 0x78 // CM=8, CINFO=7 (32K window)
  out[1] = 0x01 // FCHECK so (0x78<<8 | 0x01) % 31 === 0; FLEVEL=0
  out.set(body, 2)
  const checksum = adler32(input)
  out[out.length - 4] = (checksum >>> 24) & 0xff
  out[out.length - 3] = (checksum >>> 16) & 0xff
  out[out.length - 2] = (checksum >>> 8) & 0xff
  out[out.length - 1] = checksum & 0xff
  return out
}

// ---------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < input.length; index += 1) crc = CRC_TABLE[(crc ^ input[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const ASCII = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0))

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(ASCII(type), 4)
  out.set(data, 8)
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)))
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function ihdr(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13)
  const view = new DataView(data.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  data[8] = 8 // bit depth
  data[9] = 6 // truecolour with alpha
  data[10] = 0 // deflate
  data[11] = 0 // adaptive filtering
  data[12] = 0 // no interlace
  return data
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Adaptive per-scanline filtering.
 *
 * Every scanline is filtered five ways and the one with the smallest sum of
 * absolute signed byte values wins — the heuristic from the PNG specification.
 * On a card with a flat background this is the difference between a 3 MB file
 * and a 60 KB one, and because the choice is a pure function of the pixels it
 * costs nothing in determinism.
 */
function filterScanlines(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const out = new Uint8Array(height * (stride + 1))
  const candidate = new Uint8Array(stride)
  const best = new Uint8Array(stride)
  let previousRow = new Uint8Array(stride)
  const currentRow = new Uint8Array(stride)

  for (let y = 0; y < height; y += 1) {
    currentRow.set(rgba.subarray(y * stride, y * stride + stride))
    let bestFilter = 0
    let bestScore = Infinity

    for (let filter = 0; filter < 5; filter += 1) {
      let score = 0
      for (let index = 0; index < stride; index += 1) {
        const raw = currentRow[index]
        const left = index >= 4 ? currentRow[index - 4] : 0
        const up = previousRow[index]
        const upLeft = index >= 4 ? previousRow[index - 4] : 0
        const value =
          filter === 0
            ? raw
            : filter === 1
              ? raw - left
              : filter === 2
                ? raw - up
                : filter === 3
                  ? raw - ((left + up) >> 1)
                  : raw - paeth(left, up, upLeft)
        const byte = value & 0xff
        candidate[index] = byte
        // Signed magnitude: bytes near zero in either direction compress best.
        score += byte < 128 ? byte : 256 - byte
      }
      if (score < bestScore) {
        bestScore = score
        bestFilter = filter
        best.set(candidate)
      }
    }

    out[y * (stride + 1)] = bestFilter
    out.set(best, y * (stride + 1) + 1)
    previousRow = Uint8Array.prototype.slice.call(currentRow)
  }
  return out
}

export interface PngImage {
  readonly rgba: Uint8ClampedArray | Uint8Array
  readonly width: number
  readonly height: number
}

/** Encodes one RGBA buffer as a PNG. */
export function encodePng(image: PngImage): Uint8Array {
  assertBufferSize(image)
  const compressed = zlibDeflate(filterScanlines(image.rgba, image.width, image.height))
  return concat([
    SIGNATURE,
    chunk('IHDR', ihdr(image.width, image.height)),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ])
}

function assertBufferSize(image: PngImage) {
  const expected = image.width * image.height * 4
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1) {
    throw new Error(`PNG dimensions must be positive integers, received ${image.width}x${image.height}.`)
  }
  if (image.rgba.length !== expected) {
    throw new Error(`PNG buffer is ${image.rgba.length} bytes; ${image.width}x${image.height} RGBA needs ${expected}.`)
  }
}

/**
 * Encodes a sequence of equally-sized frames as an APNG.
 *
 * APNG rather than GIF: the turntable and the build sequence both carry soft
 * anti-aliased edges over a transparent or gradient background, and GIF's
 * 256-colour palette with 1-bit alpha would visibly wreck both. APNG is a PNG,
 * so it keeps `image/png`, keeps 8-bit alpha, and degrades to the first frame
 * as a still image in any decoder that does not know the extension chunks.
 */
export function encodeApng(frames: readonly PngImage[], delayMs: number, plays = 0): Uint8Array {
  if (!frames.length) throw new Error('An animation needs at least one frame.')
  const { width, height } = frames[0]
  for (const frame of frames) {
    assertBufferSize(frame)
    if (frame.width !== width || frame.height !== height) {
      throw new Error('Every APNG frame must share the first frame’s dimensions.')
    }
  }

  const actl = new Uint8Array(8)
  const actlView = new DataView(actl.buffer)
  actlView.setUint32(0, frames.length)
  actlView.setUint32(4, plays)

  const parts: Uint8Array[] = [SIGNATURE, chunk('IHDR', ihdr(width, height)), chunk('acTL', actl)]
  let sequence = 0

  for (let index = 0; index < frames.length; index += 1) {
    const fctl = new Uint8Array(26)
    const view = new DataView(fctl.buffer)
    view.setUint32(0, sequence++)
    view.setUint32(4, width)
    view.setUint32(8, height)
    view.setUint32(12, 0) // x offset
    view.setUint32(16, 0) // y offset
    // Delay as an exact rational so the frame rate does not drift with rounding.
    view.setUint16(20, delayMs)
    view.setUint16(22, 1000)
    fctl[24] = 0 // dispose: leave the frame in place
    fctl[25] = 0 // blend: replace, since every frame is full-size and opaque-ish
    parts.push(chunk('fcTL', fctl))

    const compressed = zlibDeflate(filterScanlines(frames[index].rgba, width, height))
    if (index === 0) {
      // The first frame is the plain IDAT, which is what a non-APNG decoder
      // shows.
      parts.push(chunk('IDAT', compressed))
      continue
    }
    const fdat = new Uint8Array(compressed.length + 4)
    new DataView(fdat.buffer).setUint32(0, sequence++)
    fdat.set(compressed, 4)
    parts.push(chunk('fdAT', fdat))
  }

  parts.push(chunk('IEND', new Uint8Array(0)))
  return concat(parts)
}

/** Chunk types in file order — used by the tests to assert a valid container. */
export function readChunkTypes(png: Uint8Array): string[] {
  const types: string[] = []
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let cursor = 8
  while (cursor + 8 <= png.length) {
    const length = view.getUint32(cursor)
    types.push(String.fromCharCode(png[cursor + 4], png[cursor + 5], png[cursor + 6], png[cursor + 7]))
    cursor += 12 + length
  }
  return types
}

/** Reads back the IHDR fields, so a test can assert real dimensions. */
export function readPngHeader(png: Uint8Array): { width: number; height: number; bitDepth: number; colourType: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20), bitDepth: png[24], colourType: png[25] }
}
