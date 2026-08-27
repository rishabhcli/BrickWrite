import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// The compiler is driven in-process so CI asserts its semantics, not just that
// the CLI exits zero.
import { compileCatalog, type CompiledCatalogManifest } from '../../tools/catalog-compiler.mjs'
import type { PartDefinition } from './types'

const FIXTURES = path.resolve('tools/fixtures')

describe('catalog compiler', () => {
  let out: string
  let manifest: CompiledCatalogManifest
  let parts: PartDefinition[]
  let colors: Array<{ code: number; name: string; alpha: number }>

  beforeAll(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'brickwright-compile-'))
    manifest = await compileCatalog({
      ldraw: path.join(FIXTURES, 'ldraw'),
      shadow: path.join(FIXTURES, 'shadow'),
      rebrickable: path.join(FIXTURES, 'rebrickable'),
      out,
      version: 'fixture',
      quiet: true,
    })
    const read = async (file: string) => JSON.parse(await readFile(path.join(out, 'catalog', 'fixture', file), 'utf8'))
    parts = await read('parts.json')
    colors = await read('colors.json')
  })

  afterAll(async () => {
    await rm(out, { recursive: true, force: true })
  })

  it('compiles the LDraw colour table from LDConfig.ldr', () => {
    expect(colors.map((color) => color.code)).toEqual([0, 4, 15, 47, 71, 72])
    // ALPHA 128 must survive as fractional opacity so transparency renders.
    expect(colors.find((color) => color.code === 47)?.alpha).toBeCloseTo(128 / 255, 3)
    expect(colors.find((color) => color.code === 71)?.name).toBe('Light Bluish Grey')
  })

  it('folds British and American grey spellings when crosswalking colours', () => {
    // LDraw writes "Light_Bluish_Grey", Rebrickable "Light Bluish Gray". Without
    // folding them the two most common structural colours lose all evidence.
    const brick = parts.find((part) => part.canonicalId === '3001')!
    expect(brick.availableColors).toEqual([0, 71])
    expect(brick.provenance.colors).toBe('Rebrickable:inventory_parts')
    // A colour with no LDraw counterpart is reported, never guessed.
    expect(manifest.coverage.unmatchedRebrickableColors).toBe(1)
  })

  it('resolves LDCad snap grids into individual connectors', () => {
    const brick = parts.find((part) => part.canonicalId === '3001')!
    // A 2 x 4 brick: an 8-stud grid on top and an 8-tube grid underneath.
    expect(brick.connectors.filter((feature) => feature.family === 'stud')).toHaveLength(8)
    expect(brick.connectors.filter((feature) => feature.family === 'anti-stud')).toHaveLength(8)
    expect(brick.connectionStatus).toBe('ldcad-authoritative')
    expect(new Set(brick.connectors.map((feature) => feature.id)).size).toBe(brick.connectors.length)
  })

  it('measures geometry from the compiled mesh, not a nominal size', () => {
    const brick = parts.find((part) => part.canonicalId === '3001')!
    expect(brick.geometryStatus).toBe('certified')
    expect(brick.dimensions!.bounds).toEqual({ min: [-20, 0, -40], max: [20, 24, 40] })
    expect(brick.geometryAsset!.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(brick.geometryAsset!.file).toBe(`assets/geometry/${brick.geometryAsset!.hash.slice(7)}.bwmesh`)
  })

  it('publishes hashed files and measured coverage', () => {
    expect(manifest.counts).toMatchObject({ parts: 1, packParts: 1, connectors: 16, colors: 6 })
    for (const file of Object.values(manifest.files)) {
      expect(file.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(file.bytes).toBeGreaterThan(0)
    }
    expect(manifest.coverage.unresolvedReferences).toEqual([])
    expect(manifest.coverage.ldrawLicenses).toEqual({ 'CC-BY-4.0': 1 })
  })

  it('is deterministic across runs', async () => {
    const second = await mkdtemp(path.join(tmpdir(), 'brickwright-compile-'))
    try {
      const repeat = await compileCatalog({
        ldraw: path.join(FIXTURES, 'ldraw'),
        shadow: path.join(FIXTURES, 'shadow'),
        rebrickable: path.join(FIXTURES, 'rebrickable'),
        out: second,
        version: 'fixture',
        quiet: true,
      })
      // Identical inputs must produce identical content hashes, which is what
      // makes the hashed asset names safe to cache forever.
      expect(repeat.files).toEqual(manifest.files)
    } finally {
      await rm(second, { recursive: true, force: true })
    }
  })
})
