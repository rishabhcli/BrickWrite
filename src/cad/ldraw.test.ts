import { describe, expect, it } from 'vitest'
import { exportLDraw, exportMpd, matrixToEuler, parseLDraw } from './ldraw'
import { createEmptyDocument, createShowcaseDocument } from './sample'

describe('LDraw interoperability', () => {
  it('writes type-1 lines directly, with no coordinate conversion', () => {
    const document = createEmptyDocument()
    document.parts.test = {
      id: 'test',
      definitionId: '3001',
      color: 72,
      transform: { position: [20, -24, -40], rotation: [0, 90, 0] },
      subassemblyId: 'hull',
      stepId: 'step_1',
      provenance: 'human',
      protected: false,
    }
    document.subassemblies.hull.partIds.push('test')
    document.steps[0].partIds.push('test')

    const output = exportLDraw(document)
    // The kernel stores LDraw's own frame, so the position appears verbatim
    // and the rotation is the row-major 3x3 LDraw already expects.
    expect(output).toContain('1 72 20 -24 -40 0 0 1 0 1 0 -1 0 0 3001.dat')
  })

  it('round-trips position and rotation through export and import', () => {
    const document = createEmptyDocument()
    document.parts.test = {
      id: 'test',
      definitionId: '3001',
      color: 72,
      transform: { position: [20, -24, -40], rotation: [0, 90, 0] },
      subassemblyId: 'hull',
      stepId: 'step_1',
      provenance: 'human',
      protected: false,
    }
    document.subassemblies.hull.partIds.push('test')
    document.steps[0].partIds.push('test')

    const imported = parseLDraw(exportLDraw(document), createEmptyDocument())
    const part = Object.values(imported.document.parts)[0]
    expect(part).toMatchObject({ definitionId: '3001', color: 72 })
    expect(part.transform.position).toEqual([20, -24, -40])
    expect(part.transform.rotation).toEqual([0, 90, 0])
    expect(imported.report.placed).toBe(1)
  })

  it('recovers Euler angles from every quarter-turn matrix', () => {
    expect(matrixToEuler([1, 0, 0, 0, 1, 0, 0, 0, 1])).toEqual([0, 0, 0])
    expect(matrixToEuler([0, 0, 1, 0, 1, 0, -1, 0, 0])).toEqual([0, 90, 0])
    expect(matrixToEuler([-1, 0, 0, 0, 1, 0, 0, 0, -1])).toEqual([0, 180, 0])
  })

  it('round-trips the showcase through MPD submodels without losing parts', () => {
    const showcase = createShowcaseDocument()
    const imported = parseLDraw(exportMpd(showcase), createEmptyDocument())
    expect(imported.report.placed).toBe(Object.keys(showcase.parts).length)
    expect(imported.report.unknownParts).toEqual([])
    expect(imported.report.submodels).toBe(
      Object.values(showcase.subassemblies).filter((subassembly) => subassembly.partIds.length).length,
    )
    // Every original transform must survive the trip exactly.
    const originals = Object.values(showcase.parts).map((part) => JSON.stringify([part.definitionId, part.color, part.transform])).sort()
    const restored = Object.values(imported.document.parts).map((part) => JSON.stringify([part.definitionId, part.color, part.transform])).sort()
    expect(restored).toEqual(originals)
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
})
