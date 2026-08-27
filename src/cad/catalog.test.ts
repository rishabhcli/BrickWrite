import { describe, expect, it } from 'vitest'
import { catalog, describeSize, originForSurface, searchCatalog, studPlaneLdu, underPlaneLdu } from './catalog'

describe('compiled catalog', () => {
  it('exposes real LDraw identities with measured dimensions', () => {
    const brick = catalog.get('3001')
    expect(brick).toBeDefined()
    expect(brick).toMatchObject({
      ldrawId: '3001.dat',
      name: 'Brick 2 x 4',
      geometryStatus: 'certified',
      connectionStatus: 'ldcad-authoritative',
    })
    // 4 × 2 studs, one brick tall, plus the 4 LDU stud overhang.
    expect(brick!.dimensions!.bounds).toEqual({ min: [-40, -4, -20], max: [40, 24, 20] })
    expect(describeSize(brick)).toBe('4 × 2 studs · 3.5 plates')
  })

  it('carries authoritative LDCad connectors, including the 2 × 2 centre tube', () => {
    const brick = catalog.get('3003')!
    const families = brick.connectors.map((feature) => `${feature.family}/${feature.gender}`)
    expect(families.filter((entry) => entry === 'stud/male')).toHaveLength(4)
    // Four bottom tubes plus the centre tube that grips a diagonally offset stud.
    expect(families.filter((entry) => entry === 'anti-stud/female')).toHaveLength(5)
    expect(brick.connectors.every((feature) => feature.src === 'ldcad')).toBe(true)
  })

  it('derives stacking planes from connectors rather than nominal heights', () => {
    expect(underPlaneLdu(catalog.get('3001'))).toBe(24)
    expect(studPlaneLdu(catalog.get('3001'))).toBe(0)
    // A tile has an underside but exposes no stud plane.
    expect(underPlaneLdu(catalog.get('3068b'))).toBe(8)
    expect(studPlaneLdu(catalog.get('3068b'))).toBeNull()
    // A curved 2/3-height brick has its origin *at* the underside.
    expect(underPlaneLdu(catalog.get('15068'))).toBe(0)
    expect(originForSurface(catalog.get('3001'), -16)).toBe(-40)
  })

  it('records colour production evidence from the official set catalog', () => {
    const brick = catalog.get('3001')!
    expect(brick.availableColors.length).toBeGreaterThan(20)
    expect(brick.availableColors).toContain(15)
    expect(catalog.color(15).name).toBe('White')
    expect(catalog.hasColor(9999)).toBe(false)
  })

  it('ranks search by textual precision then real-world usage', () => {
    const results = searchCatalog({ text: 'brick 2 x 4', requireGeometry: true, limit: 5 })
    expect(results[0].id).toBe('3001')
    expect(results.every((record) => record.geometryAvailable)).toBe(true)
  })

  it('filters by measured stud envelope and connector family', () => {
    const results = searchCatalog({ maxStuds: { width: 2, depth: 2 }, connectorTypes: ['stud'], limit: 20 })
    expect(results.length).toBeGreaterThan(0)
    for (const record of results) {
      expect(record.dimensions![0]).toBeLessThanOrEqual(2)
      expect(record.dimensions![2]).toBeLessThanOrEqual(2)
      expect(record.connectorFamilies).toContain('stud')
    }
  })

  it('only matches colour filters against parts with recorded evidence', () => {
    const results = searchCatalog({ colors: [15, 72], limit: 50 })
    for (const record of results) {
      const definition = catalog.get(record.id)!
      expect(definition.availableColors).toEqual(expect.arrayContaining([15, 72]))
    }
  })
})

describe('LDraw renames', () => {
  it('resolves a retired part number to its replacement', () => {
    // LDraw retired 3023 in favour of 3023b and left an alias file behind. The
    // old number stays in circulation, so lookups must follow the rename.
    expect(catalog.isAlias('3023')).toBe(true)
    expect(catalog.resolveId('3023')).toBe('3023b')
    expect(catalog.get('3023')?.canonicalId).toBe('3023b')
    expect(catalog.describe('3023')?.id).toBe('3023b')
  })

  it('surfaces the replacement when searching the retired number', () => {
    const results = searchCatalog({ text: '3023', limit: 5 })
    expect(results[0]?.id).toBe('3023b')
  })

  it('leaves live part numbers untouched', () => {
    expect(catalog.isAlias('3001')).toBe(false)
    expect(catalog.resolveId('3001')).toBe('3001')
  })
})

describe('connector taxonomy', () => {
  const families = (id: string) => {
    const counts = new Map<string, number>()
    for (const feature of catalog.get(id)!.connectors) {
      const key = `${feature.family}/${feature.gender}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Object.fromEntries([...counts.entries()].sort())
  }

  it('reads Technic pin holes as pin holes, not anti-studs', () => {
    // A Technic hole is a chamfered bore (R 8 2 · R 6 16 · R 8 2). Classifying it
    // by radius alone lets a System stud appear to mate with it.
    expect(families('32524')).toEqual({ 'generic/male': 1, 'pin-hole/female': 7 })
  })

  it('reads a Technic pin as a pin and its centre slot as a clip', () => {
    expect(families('2780')).toEqual({ 'clip/female': 1, 'pin/male': 1 })
  })

  it('separates keyed axles from round shafts', () => {
    expect(families('3706')).toEqual({ 'axle/male': 1 })
    expect(families('55982')).toEqual({ 'axle-hole/female': 1 })
    expect(families('4032a')).toEqual({ 'anti-stud/female': 5, 'axle-hole/female': 1, 'stud/male': 4 })
  })

  it('pairs hinge halves through a shared LDCad group', () => {
    const base = catalog.get('3937')!.connectors.find((feature) => feature.family === 'hinge')!
    const top = catalog.get('3938')!.connectors.find((feature) => feature.family === 'hinge')!
    expect(base.gender).toBe('female')
    expect(top.gender).toBe('male')
    expect(base.group).toBe(top.group)
  })

  it('keeps the System stud interface intact', () => {
    expect(families('3001')).toEqual({ 'anti-stud/female': 8, 'stud/male': 8 })
  })
})
