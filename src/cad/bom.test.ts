import { describe, expect, it } from 'vitest'
import { buildBom, exportBomCsv } from './bom'
import { createShowcaseDocument } from './sample'

describe('bill of materials', () => {
  it('aggregates exact part/color combinations and exports portable CSV', () => {
    const document = createShowcaseDocument()
    const bom = buildBom(document)
    expect(bom.reduce((sum, line) => sum + line.quantity, 0)).toBe(Object.keys(document.parts).length)
    expect(new Set(bom.map((line) => `${line.definitionId}:${line.colorCode}`)).size).toBe(bom.length)
    const output = exportBomCsv(document)
    expect(output).toContain('"Quantity","LDraw ID","BrickLink ID"')
    expect(output).toContain('"3001.dat"')
  })
})
