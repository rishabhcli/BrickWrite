import { describe, expect, it } from 'vitest'
import { captureWarnings, checkCaptureSet, hashDataUrl, hashPixels, type CaptureMetadata } from './capture'

const metadata = (overrides: Partial<CaptureMetadata> = {}): CaptureMetadata => ({
  documentRevision: 12,
  renderMode: 'beauty',
  cameraView: 'isometric',
  width: 1600,
  height: 1000,
  pixelHash: 'deadbeefdeadbeef',
  settled: true,
  visiblePartCount: 42,
  ...overrides,
})

describe('pixel digests', () => {
  it('is stable for identical buffers', () => {
    const a = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7) % 251)
    const b = Uint8Array.from({ length: 4096 }, (_, index) => (index * 7) % 251)
    expect(hashPixels(a)).toBe(hashPixels(b))
  })

  it('changes when a single byte changes', () => {
    const a = new Uint8Array(4096).fill(3)
    const b = new Uint8Array(4096).fill(3)
    b[2048] = 4
    expect(hashPixels(a)).not.toBe(hashPixels(b))
  })

  it('notices a byte moving, not just changing', () => {
    // A digest that only summed bytes would call these identical, and two
    // captures of a model rearranged in place would collide.
    const a = new Uint8Array(64)
    const b = new Uint8Array(64)
    a[10] = 9
    b[20] = 9
    expect(hashPixels(a)).not.toBe(hashPixels(b))
  })

  it('is sixteen hex characters, so collisions are not a practical concern', () => {
    // A 32-bit digest over a two-megapixel image collides often enough to
    // matter when the question is "did anything change".
    expect(hashPixels(new Uint8Array(16))).toMatch(/^[0-9a-f]{16}$/)
  })

  it('subsamples deterministically when a stride is given', () => {
    const pixels = Uint8Array.from({ length: 8192 }, (_, index) => index % 256)
    expect(hashPixels(pixels, 7)).toBe(hashPixels(pixels, 7))
    expect(hashPixels(pixels, 7)).not.toBe(hashPixels(pixels, 1))
  })

  it('digests a data URL by its payload, not its header', () => {
    const payload = 'AAECAwQFBgc='
    expect(hashDataUrl(`data:image/png;base64,${payload}`)).toBe(hashDataUrl(payload))
  })
})

describe('capture warnings', () => {
  it('is silent when the capture is trustworthy', () => {
    expect(captureWarnings(metadata(), 12)).toEqual([])
  })

  it('says so when the frame was not settled', () => {
    // An agent told "here is your picture, and the renderer was mid-animation"
    // can act sensibly; an agent told nothing cannot.
    expect(captureWarnings(metadata({ settled: false }))).toHaveLength(1)
  })

  it('says so when the document moved under the capture', () => {
    expect(captureWarnings(metadata({ documentRevision: 13 }), 12)[0]).toMatch(/revision 12 to 13/)
  })

  it('says so when the drawing buffer was empty', () => {
    expect(captureWarnings(metadata({ width: 0 }))[0]).toMatch(/drawing buffer/)
  })
})

describe('capture set integrity', () => {
  it('accepts a set where each mode has its own stable hash', () => {
    expect(
      checkCaptureSet([
        { mode: 'beauty', revision: 3, hash: 'aaaa' },
        { mode: 'beauty', revision: 3, hash: 'aaaa' },
        { mode: 'silhouette', revision: 3, hash: 'bbbb' },
        { mode: 'violations', revision: 3, hash: 'cccc' },
      ]),
    ).toEqual([])
  })

  it('rejects a mode that hashes differently twice at the same revision', () => {
    const failures = checkCaptureSet([
      { mode: 'beauty', revision: 3, hash: 'aaaa' },
      { mode: 'beauty', revision: 3, hash: 'zzzz' },
    ])
    expect(failures[0]).toMatch(/not reproducible/)
  })

  it('lets the violations view match beauty on a model with no collisions', () => {
    // The case the old fixture dodged by giving `violations` its own hash. On a
    // clean model the overlay has nothing to draw, so being pixel-identical to
    // beauty is correct — requiring it to differ would require the diagnostic to
    // invent something. This is the rule the acceptance run had worked out and
    // this function contradicted.
    expect(
      checkCaptureSet(
        [
          { mode: 'beauty', revision: 5, hash: 'aaaa' },
          { mode: 'silhouette', revision: 5, hash: 'bbbb' },
          { mode: 'violations', revision: 5, hash: 'aaaa' },
        ],
        { collisions: 0 },
      ),
    ).toEqual([])
  })

  it('rejects a violations view that matches beauty when there are collisions', () => {
    // The same coincidence is a real failure in the other direction: something
    // to draw, and nothing drawn.
    const failures = checkCaptureSet(
      [
        { mode: 'beauty', revision: 5, hash: 'aaaa' },
        { mode: 'violations', revision: 5, hash: 'aaaa' },
      ],
      { collisions: 3 },
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/3 collisions; the overlay is not drawing/)
  })

  it('still holds every other mode to being distinguishable on a clean model', () => {
    // Holding `violations` out must not excuse the rest.
    const failures = checkCaptureSet(
      [
        { mode: 'beauty', revision: 5, hash: 'aaaa' },
        { mode: 'connections', revision: 5, hash: 'aaaa' },
        { mode: 'violations', revision: 5, hash: 'aaaa' },
      ],
      { collisions: 0 },
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/indistinguishable/)
  })

  it('rejects two modes that cannot be told apart', () => {
    // A hash that collided across modes would let an agent conclude that
    // switching to the collision view showed it nothing new.
    const failures = checkCaptureSet([
      { mode: 'beauty', revision: 3, hash: 'aaaa' },
      { mode: 'silhouette', revision: 3, hash: 'aaaa' },
    ])
    expect(failures[0]).toMatch(/indistinguishable/)
  })

  it('lets the same mode differ across revisions, which is the point', () => {
    expect(
      checkCaptureSet([
        { mode: 'beauty', revision: 3, hash: 'aaaa' },
        { mode: 'beauty', revision: 4, hash: 'bbbb' },
      ]),
    ).toEqual([])
  })
})
