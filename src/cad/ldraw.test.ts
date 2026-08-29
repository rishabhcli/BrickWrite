import { describe, expect, it } from 'vitest'
import { exportLDraw, exportMpd, parseLDraw, describeLDrawImport } from './ldraw'
import { basisFromAxisAngle, basisFromEulerDegrees, canonicalTransform, IDENTITY_BASIS, type Mat3 } from './math'
import { createEmptyDocument, createShowcaseDocument } from './sample'
import type { ModelDocument, PartInstance, Transform } from './types'

const place = (document: ModelDocument, transform: Transform, definitionId = '3001'): PartInstance => {
  const part: PartInstance = {
    id: 'test',
    definitionId,
    color: 72,
    transform,
    subassemblyId: 'hull',
    stepId: 'step_1',
    provenance: 'human',
    protected: false,
  }
  document.parts.test = part
  document.subassemblies.hull.partIds.push('test')
  document.steps[0].partIds.push('test')
  return part
}

describe('LDraw interoperability', () => {
  it('writes the stored basis straight into the type-1 line', () => {
    const document = createEmptyDocument()
    place(document, { position: [20, -24, -40], basis: basisFromEulerDegrees([0, 90, 0]) })
    // No coordinate conversion and no decomposition: the nine matrix values are
    // exactly what the document holds.
    expect(exportLDraw(document)).toContain('1 72 20 -24 -40 0 0 1 0 1 0 -1 0 0 3001.dat')
  })

  it('round-trips an arbitrary off-axis basis exactly', () => {
    // The case Euler storage could not preserve: a rotation that is not a
    // multiple of 90° about any single axis.
    const basis = basisFromAxisAngle([0.3, 0.8, 0.5], 0.9137)
    const document = createEmptyDocument()
    place(document, { position: [13.5, -37.25, 61.75], basis })

    const imported = parseLDraw(exportLDraw(document), createEmptyDocument())
    const restored = Object.values(imported.document.parts)[0]
    expect(imported.report.placed).toBe(1)
    restored.transform.position.forEach((value, axis) => expect(value).toBeCloseTo([13.5, -37.25, 61.75][axis], 6))
    restored.transform.basis.forEach((value, index) => expect(value).toBeCloseTo(basis[index], 6))
  })

  it('preserves a mirrored reference matrix', () => {
    const mirrored: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1]
    const document = createEmptyDocument()
    place(document, { position: [0, 0, 0], basis: mirrored })
    const imported = parseLDraw(exportLDraw(document), createEmptyDocument())
    expect(Object.values(imported.document.parts)[0].transform.basis).toEqual(mirrored)
  })

  it('composes nested submodel transforms on import', () => {
    const source = [
      '0 FILE main.ldr',
      // Submodel placed 40 LDU along x and rotated a quarter turn about y.
      '1 16 40 0 0 0 0 1 0 1 0 -1 0 0 sub.ldr',
      '0 NOFILE',
      '0 FILE sub.ldr',
      '1 15 0 0 20 1 0 0 0 1 0 0 0 1 3005.dat',
      '0 NOFILE',
    ].join('\n')
    const imported = parseLDraw(source, createEmptyDocument())
    const part = Object.values(imported.document.parts)[0]
    expect(imported.report.placed).toBe(1)
    // The child's local +z offset becomes a document-space -x offset.
    expect(part.transform.position[0]).toBeCloseTo(60, 6)
    expect(part.transform.position[2]).toBeCloseTo(0, 6)
    expect(part.transform.basis[2]).toBeCloseTo(1, 6)
  })

  it('round-trips the showcase through MPD submodels without losing parts', () => {
    const showcase = createShowcaseDocument()
    const imported = parseLDraw(exportMpd(showcase), createEmptyDocument())
    expect(imported.report.placed).toBe(Object.keys(showcase.parts).length)
    expect(imported.report.unknownParts).toEqual([])
    expect(imported.report.submodels).toBe(
      Object.values(showcase.subassemblies).filter((subassembly) => subassembly.partIds.length).length,
    )
    const describe = (part: PartInstance) =>
      `${part.definitionId}/${part.color}/${canonicalTransform(part.transform)}`
    expect(Object.values(imported.document.parts).map(describe).sort()).toEqual(
      Object.values(showcase.parts).map(describe).sort(),
    )
  })

  it('reports references it cannot place instead of dropping them silently', () => {
    const source = [
      '0 FILE main.ldr',
      '1 15 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '1 15 0 -24 0 1 0 0 0 1 0 0 0 1 999999.dat',
      '0 NOFILE',
    ].join('\n')
    const imported = parseLDraw(source, createEmptyDocument())
    expect(imported.report.placed).toBe(1)
    expect(imported.report.unknownParts).toEqual(['999999'])
  })

  it('reports unrecognised meta commands instead of dropping them silently', () => {
    const source = [
      '0 FILE main.ldr',
      '0 GROUP hull',
      '0 !LEOCAD GROUP_BEGIN hull',
      '0 !LPUB ASSEMBLY',
      '1 15 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '0 NOFILE',
    ].join('\n')
    const imported = parseLDraw(source, createEmptyDocument())
    expect(imported.report.placed).toBe(1)
    expect(imported.report.ignoredMeta.count).toBe(3)
    expect(imported.report.ignoredMeta.samples).toEqual(expect.arrayContaining(['GROUP', '!LEOCAD', '!LPUB']))
    expect(describeLDrawImport(imported.report).detail).toMatch(/Ignored 3 unrecognised meta lines/)
  })

  it('reports hovering and colliding parts instead of silently accepting them', () => {
    const source = [
      '0 FILE main.ldr',
      '1 72 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '1 72 0 -200 0 1 0 0 0 1 0 0 0 1 3001.dat',
      '0 NOFILE',
    ].join('\n')
    const imported = parseLDraw(source, createEmptyDocument())
    expect(imported.report.placed).toBe(2)
    expect(imported.report.floatingPartCount).toBeGreaterThan(0)
    expect(describeLDrawImport(imported.report).detail).toMatch(/hover/i)
  })

  it('leaves an identity placement as the identity basis', () => {
    const document = createEmptyDocument()
    place(document, { position: [0, 0, 0], basis: IDENTITY_BASIS })
    const imported = parseLDraw(exportLDraw(document), createEmptyDocument())
    expect(Object.values(imported.document.parts)[0].transform.basis).toEqual(IDENTITY_BASIS)
  })
})
