import { describe, expect, it, vi } from 'vitest'
// The offline compiler is exercised directly so the packed container format and
// the runtime decoder can never drift apart.
import { compileMesh, parseLDrawSource } from '../../tools/ldraw-mesh.mjs'
import { decodeMesh, GeometryCache, MAIN_COLOUR } from './mesh'
import type { PartDefinition } from './types'

/** Builds a resolver over an in-memory LDraw library. */
const library = (files: Record<string, string>) => (reference: string) => {
  const text = files[reference.replace(/\\/g, '/').toLowerCase()]
  return text === undefined ? null : { text, key: reference }
}

const compile = (files: Record<string, string>, root: string) => {
  const result = compileMesh(root, library(files), { parseCache: new Map() })
  expect(result).not.toBeNull()
  return { ...result!, mesh: decodeMesh(new Uint8Array(result!.buffer).buffer) }
}

describe('LDraw geometry compiler', () => {
  it('parses line types and records BFC state per instruction', () => {
    const parsed = parseLDrawSource([
      '0 Test',
      '0 BFC CERTIFY CW',
      '3 16 0 0 0 1 0 0 0 1 0',
      '0 BFC INVERTNEXT',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 child.dat',
      '2 24 0 0 0 1 0 0',
      '4 16 0 0 0 1 0 0 1 1 0 0 1 0',
    ].join('\n'))
    expect(parsed.certified).toBe(true)
    expect(parsed.instructions.map((item) => item.kind)).toEqual([3, 1, 2, 4])
    expect(parsed.instructions[0]).toMatchObject({ kind: 3, ccw: false })
    expect(parsed.instructions[1]).toMatchObject({ kind: 1, invert: true, ref: 'child.dat' })
  })

  it('splits quads into two triangles and measures exact bounds', () => {
    const { mesh, stats } = compile(
      {
        'unit.dat': ['0 Unit quad', '0 BFC CERTIFY CCW', '4 16 -10 0 -20 10 0 -20 10 0 20 -10 0 20'].join('\n'),
      },
      'unit.dat',
    )
    expect(stats.triangles).toBe(2)
    expect(mesh.bounds).toEqual({ min: [-10, 0, -20], max: [10, 0, 20] })
    expect(mesh.slices).toEqual([{ colour: MAIN_COLOUR, start: 0, count: 6 }])
  })

  it('flattens sub-file transforms into world space', () => {
    const { mesh } = compile(
      {
        // The child is placed twice, offset and rotated 90° about Y.
        'parent.dat': [
          '0 Parent',
          '0 BFC CERTIFY CCW',
          '1 16 100 0 0 1 0 0 0 1 0 0 0 1 child.dat',
          '1 16 0 0 0 0 0 1 0 1 0 -1 0 0 child.dat',
        ].join('\n'),
        'child.dat': ['0 Child', '0 BFC CERTIFY CCW', '3 16 0 0 0 10 0 0 0 0 10'].join('\n'),
      },
      'parent.dat',
    )
    // First instance spans x 100..110; the rotated instance turns the child's
    // +x extent into -z, so the union is x 0..110, z -10..10.
    expect(mesh.bounds.min).toEqual([0, 0, -10])
    expect(mesh.bounds.max).toEqual([110, 0, 10])
  })

  it('inherits colour 16 and bakes explicit colours as separate slices', () => {
    const { mesh } = compile(
      {
        'part.dat': [
          '0 Part',
          '0 BFC CERTIFY CCW',
          '3 16 0 0 0 10 0 0 0 0 10',
          '3 0 20 0 0 30 0 0 20 0 10',
          '1 16 0 0 0 1 0 0 0 1 0 0 0 1 inherit.dat',
        ].join('\n'),
        // A colour-16 face inside a colour-16 reference stays inheritable.
        'inherit.dat': ['0 Inherit', '0 BFC CERTIFY CCW', '3 16 40 0 0 50 0 0 40 0 10'].join('\n'),
      },
      'part.dat',
    )
    const colours = mesh.slices.map((slice) => slice.colour).sort((a, b) => a - b)
    expect(colours).toEqual([0, MAIN_COLOUR])
    const main = mesh.slices.find((slice) => slice.colour === MAIN_COLOUR)!
    const baked = mesh.slices.find((slice) => slice.colour === 0)!
    // Two inheritable faces, one hard-coded black face.
    expect(main.count).toBe(6)
    expect(baked.count).toBe(3)
  })

  it('flips winding for a negative-determinant placement', () => {
    const face = ['0 BFC CERTIFY CCW', '3 16 0 0 0 10 0 0 0 0 10'].join('\n')
    const upright = compile({ 'p.dat': ['0 P', '0 BFC CERTIFY CCW', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 f.dat'].join('\n'), 'f.dat': face }, 'p.dat')
    const mirrored = compile({ 'p.dat': ['0 P', '0 BFC CERTIFY CCW', '1 16 0 0 0 -1 0 0 0 1 0 0 0 1 f.dat'].join('\n'), 'f.dat': face }, 'p.dat')
    // Mirroring must not invert the surface normal: the compiler compensates by
    // reversing the vertex order.
    const normalOf = (mesh: ReturnType<typeof decodeMesh>) => [mesh.normals[0], mesh.normals[1], mesh.normals[2]]
    const expected = normalOf(upright.mesh)
    normalOf(mirrored.mesh).forEach((component, axis) => expect(component).toBeCloseTo(expected[axis], 6))
    expect(expected[1]).toBeCloseTo(-1, 6)
  })

  it('honours SNAP-free INVERTNEXT on a single reference only', () => {
    const parsed = parseLDrawSource([
      '0 BFC CERTIFY CCW',
      '0 BFC INVERTNEXT',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.dat',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.dat',
    ].join('\n'))
    expect(parsed.instructions[0]).toMatchObject({ ref: 'a.dat', invert: true })
    expect(parsed.instructions[1]).toMatchObject({ ref: 'b.dat', invert: false })
  })

  it('captures type-2 edges and reports unresolved references honestly', () => {
    const result = compileMesh(
      'p.dat',
      library({
        'p.dat': [
          '0 BFC CERTIFY CCW',
          '3 16 0 0 0 10 0 0 0 0 10',
          '2 24 0 0 0 10 0 0',
          '1 16 0 0 0 1 0 0 0 1 0 0 0 1 nope.dat',
        ].join('\n'),
      }),
      { parseCache: new Map() },
    )
    expect(result!.stats.edgeSegments).toBe(1)
    expect(result!.missing).toEqual(['nope.dat'])
  })

  it('produces a content-addressed buffer the runtime can decode', () => {
    const files = { 'p.dat': ['0 BFC CERTIFY CCW', '4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10'].join('\n') }
    const first = compileMesh('p.dat', library(files), { parseCache: new Map() })!
    const second = compileMesh('p.dat', library(files), { parseCache: new Map() })!
    // Deterministic output is what makes hashed asset names safe to cache forever.
    expect(first.hash).toBe(second.hash)
    const decoded = decodeMesh(new Uint8Array(first.buffer).buffer)
    expect(decoded.indices).toHaveLength(6)
    expect(decoded.positions).toHaveLength(decoded.normals.length)
    expect(() => decodeMesh(new Uint8Array(16).buffer)).toThrow(/Not a Brickwright mesh/)
  })

  it('rejects truncated or count-forged containers before creating typed views', () => {
    const result = compileMesh(
      'p.dat',
      library({ 'p.dat': ['0 BFC CERTIFY CCW', '3 16 0 0 0 10 0 0 0 0 10'].join('\n') }),
      { parseCache: new Map() },
    )!
    const valid = Uint8Array.from(result.buffer).buffer
    expect(() => decodeMesh(valid.slice(0, valid.byteLength - 4))).toThrow(/layout mismatch/i)

    const forged = valid.slice(0)
    new DataView(forged).setUint32(32, 0xffff_ffff, true)
    expect(() => decodeMesh(forged)).toThrow(/layout mismatch/i)
  })

  it('rejects an index that points outside the declared vertex buffer', () => {
    const result = compileMesh(
      'p.dat',
      library({ 'p.dat': ['0 BFC CERTIFY CCW', '3 16 0 0 0 10 0 0 0 0 10'].join('\n') }),
      { parseCache: new Map() },
    )!
    const forged = Uint8Array.from(result.buffer).buffer
    const view = new DataView(forged)
    const vertexCount = view.getUint32(32, true)
    const sliceCount = view.getUint32(44, true)
    const indexOffset = 52 + sliceCount * 12 + vertexCount * 24
    view.setUint32(indexOffset, vertexCount, true)
    expect(() => decodeMesh(forged)).toThrow(/exceeds its .* vertices/i)
  })
})

/**
 * The cache is bounded, and bounding it must not blank the viewport.
 *
 * An unbounded cache leaks on both sides — decoded buffers on the heap, and the
 * uploaded copies on the GPU, since dropping a `BufferGeometry` without
 * disposing it frees neither. Eviction fixes that and introduces a worse
 * failure if it is careless: disposing geometry something is still drawing
 * empties it. These tests hold both ends — that it does evict, and that it
 * refuses to evict what a caller has said it is using.
 */
describe('the bounded geometry cache', () => {
  const CUBE = (size: number) =>
    [
      '0 Cube',
      '0 BFC CERTIFY CCW',
      ...Array.from({ length: size }, (_, index) => {
        const y = index * 4
        return `4 16 -10 ${y} -20 10 ${y} -20 10 ${y} 20 -10 ${y} 20`
      }),
    ].join('\n')

  /** A part definition backed by a real compiled buffer, served by a stub fetch. */
  const compiled = (id: string, quads: number) => {
    const name = `${id}.dat`
    const result = compileMesh(name, library({ [name]: CUBE(quads) }), { parseCache: new Map() })!
    const buffer = new Uint8Array(result.buffer)
    const definition = {
      canonicalId: id,
      geometryAsset: {
        hash: `sha256:${result.hash}`,
        file: `${id}.bwmesh`,
        bytes: buffer.byteLength,
        vertices: result.stats.vertices,
        triangles: result.stats.triangles,
        edgeSegments: result.stats.edgeSegments,
        slices: result.stats.slices,
      },
    } as unknown as PartDefinition
    return { definition, buffer }
  }

  const serve = (parts: Array<{ definition: PartDefinition; buffer: Uint8Array }>) => {
    const byFile = new Map(parts.map((part) => [part.definition.geometryAsset!.file, part.buffer]))
    return vi.fn(async (url: string) => {
      const found = byFile.get(String(url).split('/').pop() ?? '')
      if (!found) return { ok: false, status: 404, statusText: 'Not Found' } as unknown as Response
      const copy = found.slice()
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      } as unknown as Response
    })
  }

  it('measures decoded bytes and drops the least recently used when over budget', async () => {
    const parts = [compiled('a', 24), compiled('b', 24), compiled('c', 24)]
    vi.stubGlobal('fetch', serve(parts))
    try {
      const one = compiled('probe', 24)
      vi.stubGlobal('fetch', serve([...parts, one]))
      // Budget set to hold two of these three, so loading the third must evict.
      const sizing = new GeometryCache('')
      await sizing.load(one.definition)
      const each = sizing.residentBytes
      expect(each).toBeGreaterThan(0)

      const cache = new GeometryCache('', each * 2 + 1)
      await cache.load(parts[0].definition)
      await cache.load(parts[1].definition)
      // Touch the first so the *second* becomes the least recently used.
      expect(cache.get(parts[0].definition)).not.toBeNull()
      expect(cache.residentCount).toBe(2)

      await cache.load(parts[2].definition)
      expect(cache.residentCount).toBe(2)
      expect(cache.residentBytes).toBeLessThanOrEqual(each * 2 + 1)
      // The untouched one went; the touched one and the newest stayed.
      expect(cache.getStatus(parts[1].definition)).toBe('unavailable')
      expect(cache.getStatus(parts[0].definition)).toBe('ready')
      expect(cache.getStatus(parts[2].definition)).toBe('ready')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never evicts geometry a caller is still holding', async () => {
    const parts = [compiled('d', 24), compiled('e', 24), compiled('f', 24), compiled('j', 24)]
    vi.stubGlobal('fetch', serve(parts))
    try {
      const sizing = new GeometryCache('')
      await sizing.load(parts[0].definition)
      const each = sizing.residentBytes

      const cache = new GeometryCache('', each * 2 + 1)
      // Retained *before* it is resident, which is the ordinary case: a renderer
      // retains on mount and the fetch lands afterwards.
      const release = cache.retain(parts[0].definition)
      await cache.load(parts[0].definition)
      const surface = cache.get(parts[0].definition)!.surface
      await cache.load(parts[1].definition)
      await cache.load(parts[2].definition)

      // It is now the least recently used of the three, and it is the one that
      // survives: the sweep took the unretained neighbour instead. Its buffers
      // are intact, which is the assertion that matters — a disposed geometry
      // renders nothing.
      expect(cache.getStatus(parts[0].definition)).toBe('ready')
      expect(cache.getStatus(parts[1].definition)).toBe('unavailable')
      expect(surface.getAttribute('position')).toBeTruthy()

      // Released, it becomes the first thing the next sweep reaches for.
      release()
      await cache.load(parts[3].definition)
      expect(cache.getStatus(parts[0].definition)).toBe('unavailable')
      expect(cache.getStatus(parts[3].definition)).toBe('ready')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('counts holders, so the last release is the one that frees it', async () => {
    const parts = [compiled('g', 24), compiled('h', 24)]
    vi.stubGlobal('fetch', serve(parts))
    try {
      const sizing = new GeometryCache('')
      await sizing.load(parts[0].definition)
      const cache = new GeometryCache('', 1)
      const first = cache.retain(parts[0].definition)
      const second = cache.retain(parts[0].definition)
      await cache.load(parts[0].definition)
      first()
      expect(cache.sweep()).toBe(0)
      // Releasing twice from the same handle must not decrement someone else's
      // hold — the balance is per handle, not per asset.
      first()
      expect(cache.sweep()).toBe(0)
      second()
      expect(cache.sweep()).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('disposes what it drops, so the GPU copy goes with the heap one', async () => {
    const part = compiled('i', 24)
    vi.stubGlobal('fetch', serve([part]))
    try {
      const cache = new GeometryCache('', 1)
      await cache.load(part.definition)
      const geometry = cache.get(part.definition)
      // A budget of one byte means the arrival is swept immediately; nothing is
      // holding it, so `get` reports it gone and starts a fresh fetch.
      expect(geometry).toBeNull()
      expect(cache.residentBytes).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
