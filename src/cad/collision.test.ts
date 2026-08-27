import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { compileMesh } from '../../tools/ldraw-mesh.mjs'
import { clearCollisionGeometryCache, findCollisions, geometryFromArrays, type GeometryProvider } from './collision'
import { getPartBounds } from './geometry'
import { decodeMesh } from './mesh'
import { basisFromEulerDegrees, IDENTITY_BASIS, type Mat3 } from './math'
import { createEmptyDocument } from './sample'
import type { ModelDocument, PartInstance } from './types'

/**
 * Collision needs real triangles, from one of two sources.
 *
 * With the LDraw library present the suite compiles them straight from source
 * with the offline compiler, which also exercises the compiler. Without it —
 * CI, and any fresh clone, since `.sources` is gitignored — it decodes the
 * committed `.bwmesh` pack instead, which is what actually ships to users.
 *
 * The fallback matters more than it looks: this suite was previously skipped
 * outright whenever the library was absent, so the triangle confirmation that
 * the whole buildability claim rests on had no CI coverage at all.
 */
const LDRAW_ROOT = path.resolve('.sources/ldraw')
const HAVE_LIBRARY = existsSync(path.join(LDRAW_ROOT, 'LDConfig.ldr'))

const PUBLIC_ROOT = path.resolve('public')

/** Canonical id to committed geometry asset, read from the shipped manifest. */
const packGeometry = (() => {
  const index = new Map<string, string>()
  try {
    const pointer = JSON.parse(readFileSync(path.join(PUBLIC_ROOT, 'catalog/latest.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(PUBLIC_ROOT, pointer.manifest.path), 'utf8'))
    const parts = JSON.parse(readFileSync(path.join(PUBLIC_ROOT, manifest.files.parts.path), 'utf8'))
    for (const record of parts) {
      if (record.geometryAsset?.file) index.set(record.canonicalId, record.geometryAsset.file)
    }
  } catch {
    // No committed pack: HAVE_PACK stays false and the suite skips, rather than
    // silently exercising the fallback path and appearing to pass.
  }
  return index
})()

const HAVE_PACK = ['3001', '3005', '62360'].every((id) => packGeometry.has(id))

const sourceCache = new Map<string, { text: string; key: string } | null>()
const resolveSource = (reference: string) => {
  const key = reference.replace(/\\/g, '/').toLowerCase()
  if (sourceCache.has(key)) return sourceCache.get(key)!
  for (const prefix of ['p/', 'parts/', '', 'models/']) {
    const absolute = path.join(LDRAW_ROOT, `${prefix}${key}`)
    if (existsSync(absolute)) {
      const value = { text: readFileSync(absolute, 'utf8'), key: absolute }
      sourceCache.set(key, value)
      return value
    }
  }
  sourceCache.set(key, null)
  return null
}

const geometries = new Map<string, THREE.BufferGeometry | null>()
const parseCache = new Map()

/** Raw `.bwmesh` bytes for a part, from source or from the committed pack. */
const meshBytes = (definitionId: string): ArrayBuffer | null => {
  if (HAVE_LIBRARY) {
    const compiled = compileMesh(`parts/${definitionId}.dat`, resolveSource, { parseCache })
    return compiled ? (new Uint8Array(compiled.buffer).buffer as ArrayBuffer) : null
  }
  const file = packGeometry.get(definitionId)
  if (!file) return null
  const bytes = readFileSync(path.join(PUBLIC_ROOT, file))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const provide: GeometryProvider = (definitionId) => {
  if (geometries.has(definitionId)) return geometries.get(definitionId)!
  const buffer = meshBytes(definitionId)
  if (!buffer) {
    geometries.set(definitionId, null)
    return null
  }
  const mesh = decodeMesh(buffer)
  const geometry = geometryFromArrays(mesh.positions, mesh.indices, mesh.normals)
  geometries.set(definitionId, geometry)
  return geometry
}

const part = (id: string, definitionId: string, position: [number, number, number], basis: Mat3 = IDENTITY_BASIS): PartInstance => ({
  id,
  definitionId,
  color: 15,
  transform: { position, basis },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/** Fresh document object per call: derived state is memoized on identity. */
const withParts = (...parts: PartInstance[]): ModelDocument => {
  const base = createEmptyDocument()
  return {
    ...base,
    parts: Object.fromEntries(parts.map((item) => [item.id, item])),
    subassemblies: {
      ...base.subassemblies,
      hull: { ...base.subassemblies.hull, partIds: parts.map((item) => item.id) },
    },
  }
}

describe.skipIf(!HAVE_LIBRARY && !HAVE_PACK)('collision narrow phase', () => {
  beforeAll(() => {
    clearCollisionGeometryCache()
    // Fail loudly if the fixture parts cannot be compiled, rather than silently
    // exercising the fallback path and appearing to pass.
    expect(provide('3001')).not.toBeNull()
    expect(provide('3005')).not.toBeNull()
    expect(provide('62360')).not.toBeNull()
  })

  it('accepts a correctly stacked brick despite real stud overlap', () => {
    // The studs genuinely intersect the brick above by 4 LDU. An unqualified
    // triangle test would flag this; the mating volume is what makes it legal.
    const document = withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [0, -24, 0]))
    expect(findCollisions(document, { provide })).toEqual([])
  })

  it('accepts a half-offset stack, where only some studs engage', () => {
    const document = withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [40, -24, 0]))
    expect(findCollisions(document, { provide })).toEqual([])
  })

  it('rejects two bricks driven into the same space', () => {
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [20, 0, 0]))
    const contacts = findCollisions(document, { provide })
    expect(contacts).toHaveLength(1)
    expect(contacts[0].certainty).toBe('exact')
    expect(contacts[0].pointLdu).toBeDefined()
  })

  it('rejects a brick pushed one plate too deep into its neighbour', () => {
    // 8 LDU of interpenetration: past the stud, so the mating allowance does not
    // cover it, and the triangle test confirms the surfaces really do meet.
    const document = withParts(part('base', '3001', [0, 0, 0]), part('upper', '3001', [0, -16, 0]))
    const contacts = findCollisions(document, { provide })
    expect(contacts).toHaveLength(1)
    expect(contacts[0].certainty).toBe('exact')
    expect(contacts[0].pointLdu).toBeDefined()
  })

  it('clears a box overlap that the geometry does not actually share', () => {
    // This is what the narrow phase buys. A 45°-rotated brick's axis-aligned box
    // is far larger than the brick, so a box-only test reports a solid 12 LDU
    // collision against a neighbour sitting in the empty corner of that box.
    const document = withParts(
      part('rotated', '3001', [0, 0, 0], basisFromEulerDegrees([0, 45, 0])),
      part('neighbour', '3005', [40, 0, 40]),
    )
    const boxes = [getPartBounds(document.parts.rotated), getPartBounds(document.parts.neighbour)]
    const overlap = [0, 1, 2].map(
      (axis) => Math.min(boxes[0].max[axis], boxes[1].max[axis]) - Math.max(boxes[0].min[axis], boxes[1].min[axis]),
    )
    expect(Math.min(...overlap)).toBeGreaterThan(10)

    // Box-only: a confident collision. With geometry: correctly cleared.
    const boxOnly = findCollisions(document)
    expect(boxOnly).toHaveLength(1)
    expect(boxOnly[0].certainty).toBe('unknown')
    expect(findCollisions(document, { provide })).toEqual([])
  })

  it('reports the offending point in document space', () => {
    const document = withParts(part('a', '3005', [0, 0, 0]), part('b', '3005', [8, 0, 0]))
    const contacts = findCollisions(document, { provide })
    expect(contacts).toHaveLength(1)
    const point = contacts[0].pointLdu!
    // Both 1x1 bricks span x in [-10, 10] and [-2, 18]; any contact must be in
    // the shared band.
    expect(point[0]).toBeGreaterThanOrEqual(-3)
    expect(point[0]).toBeLessThanOrEqual(11)
  })

  it('accepts parts that merely touch face to face', () => {
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [80, 0, 0]))
    expect(findCollisions(document, { provide })).toEqual([])
  })

  it('detects interpenetration between rotated parts', () => {
    const document = withParts(
      part('a', '3001', [0, 0, 0]),
      part('b', '3001', [0, 0, 0], basisFromEulerDegrees([0, 90, 0])),
    )
    const contacts = findCollisions(document, { provide })
    expect(contacts).toHaveLength(1)
  })

  it('scopes testing to the parts under consideration', () => {
    const document = withParts(
      part('a', '3001', [0, 0, 0]),
      part('b', '3001', [20, 0, 0]),
      part('c', '3001', [400, 0, 0]),
    )
    expect(findCollisions(document, { provide, onlyPartIds: ['c'] })).toEqual([])
    expect(findCollisions(document, { provide, onlyPartIds: ['a'] })).toHaveLength(1)
  })
})

describe('collision without resident geometry', () => {
  beforeAll(() => clearCollisionGeometryCache())

  it('falls back to the box test and marks the result unknown', () => {
    // No provider at all: the kernel must not claim an exact verdict.
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [20, 0, 0]))
    const contacts = findCollisions(document)
    expect(contacts).toHaveLength(1)
    expect(contacts[0].certainty).toBe('unknown')
    expect(contacts[0].pointLdu).toBeUndefined()
  })

  it('marks a pair unknown when the provider has no geometry for it', () => {
    const document = withParts(part('a', '3001', [0, 0, 0]), part('b', '3001', [20, 0, 0]))
    const contacts = findCollisions(document, { provide: () => null })
    expect(contacts).toHaveLength(1)
    expect(contacts[0].certainty).toBe('unknown')
  })
})
