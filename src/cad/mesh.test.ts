import { describe, expect, it } from 'vitest'
// The offline compiler is exercised directly so the packed container format and
// the runtime decoder can never drift apart.
import { compileMesh, parseLDrawSource } from '../../tools/ldraw-mesh.mjs'
import { decodeMesh, MAIN_COLOUR } from './mesh'

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
})
