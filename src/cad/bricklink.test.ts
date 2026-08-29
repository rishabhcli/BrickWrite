import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBom } from './bom'
import { buildBrickLinkLines, describeBrickLinkExport, escapeXml, exportBrickLinkXml, BRICKLINK_REMARKS_MAX } from './bricklink'
import { catalog } from './catalog'
import { createBlankDocument, createShowcaseDocument } from './sample'
import type { ModelDocument, PartInstance } from './types'
import { IDENTITY_BASIS } from './math'

const place = (document: ModelDocument, id: string, definitionId: string, color: number): PartInstance => {
  const part: PartInstance = {
    id,
    definitionId,
    color,
    transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
    subassemblyId: Object.keys(document.subassemblies)[0] ?? 'main',
    stepId: document.steps[0]?.id ?? 'step_1',
    provenance: 'human',
    protected: false,
  }
  document.parts[id] = part
  return part
}

function withoutVerifiedBrickLink(definitionId: string) {
  const found = catalog.get(definitionId)
  if (!found) throw new Error(`${definitionId} is not in the fixture catalog.`)
  const original = catalog.get.bind(catalog)
  vi.spyOn(catalog, 'get').mockImplementation((id) => {
    const record = original(id)
    if (!record || (id !== definitionId && id !== found.canonicalId && record.canonicalId !== found.canonicalId)) {
      return record
    }
    return { ...record, identity: { ...record.identity, bricklinkIds: [], rebrickableId: null } }
  })
}

describe('BrickLink wanted-list export', () => {
  afterEach(() => vi.restoreAllMocks())
  it('emits one ITEM per BOM line', () => {
    const document = createShowcaseDocument()
    const xml = exportBrickLinkXml(document).xml
    const items = xml.match(/<ITEM>/g) ?? []
    expect(items).toHaveLength(buildBom(document).length)
  })

  it('MINQTY sums to the document part count', () => {
    const document = createShowcaseDocument()
    const { report } = exportBrickLinkXml(document)
    expect(report.totalPieces).toBe(Object.keys(document.parts).length)
    expect(report.totalPieces).toBe(buildBom(document).reduce((sum, line) => sum + line.quantity, 0))
  })

  it('emits a well-formed document', () => {
    const { xml } = exportBrickLinkXml(createShowcaseDocument())
    expect(xml.startsWith('<INVENTORY>')).toBe(true)
    expect(xml.trim().endsWith('</INVENTORY>')).toBe(true)
    expect(xml).toContain('<ITEMTYPE>P</ITEMTYPE>')
  })

  it('matches the literal item block for a known part', () => {
    const document = createBlankDocument('Rock & <Roll>')
    place(document, 'a', '3001', 72)
    const line = buildBrickLinkLines(document)[0]!
    const { xml } = exportBrickLinkXml(document)
    expect(xml).toContain(`<ITEMID>${line.itemId}</ITEMID>`)
    expect(xml).toContain(`<MINQTY>1</MINQTY>`)
    expect(xml).toContain('<CONDITION>N</CONDITION>')
    const remarks =
      line.idSource === 'bricklink'
        ? 'Rock & <Roll> r0'
        : line.idSource === 'rebrickable-fallback'
          ? 'Rock & <Roll> r0; Rebrickable fallback id'
          : 'Rock & <Roll> r0; LDraw fallback id'
    expect(xml).toContain(`<REMARKS>${escapeXml(remarks)}</REMARKS>`)
  })

  it('reports unverified item numbers rather than claiming them', () => {
    const document = createShowcaseDocument()
    const { report, xml: _xml } = exportBrickLinkXml(document)
    const lines = buildBrickLinkLines(document)
    const unverified = lines.filter((line) => line.idSource !== 'bricklink').length
    expect(report.unverifiedIds).toBe(unverified)
    if (unverified === lines.length) expect(report.unverifiedIds).toBe(report.lines)
  })

  it('omits COLOR when unmapped and counts it', () => {
    const document = createBlankDocument('Unmapped colour')
    place(document, 'a', '3001', 999_001)
    const { xml, report } = exportBrickLinkXml(document)
    expect(xml).not.toContain('<COLOR>')
    expect(report.unmappedColors).toBe(1)
  })

  it('escapes XML metacharacters in REMARKS', () => {
    const document = createBlankDocument('Rock & <Roll>')
    place(document, 'a', '3001', 15)
    const { xml } = exportBrickLinkXml(document)
    expect(xml).toContain('Rock &amp; &lt;Roll&gt;')
    expect(xml).not.toContain('Rock & <Roll>')
  })

  it('emits a valid empty inventory', () => {
    const { xml, report } = exportBrickLinkXml(createBlankDocument('Empty'))
    expect(xml).toBe('<INVENTORY></INVENTORY>\n')
    expect(report.lines).toBe(0)
    expect(report.totalPieces).toBe(0)
  })

  it('tags fallback identifiers in REMARKS so the wanted list itself discloses them', () => {
    const document = createBlankDocument('Fallback')
    place(document, 'a', '3001', 15)
    withoutVerifiedBrickLink('3001')
    const { xml, report } = exportBrickLinkXml(document)
    expect(report.unverifiedIds).toBe(1)
    expect(xml).toContain('LDraw fallback id')
    expect(describeBrickLinkExport(report)?.detail).toMatch(/verified BrickLink item number/)
  })

  it('mentions unverified ids and unmapped colours in one report', () => {
    const document = createBlankDocument('Both')
    place(document, 'a', '3001', 999_001)
    withoutVerifiedBrickLink('3001')
    const copy = describeBrickLinkExport(exportBrickLinkXml(document).report)
    expect(copy?.detail).toMatch(/verified BrickLink item number/)
    expect(copy?.detail).toMatch(/no BrickLink colour mapping/)
  })

  it('keeps REMARKS within BrickLink\'s practical length, with the fallback tag last', () => {
    const document = createBlankDocument(`${'Very long project name '.repeat(12)}`)
    place(document, 'a', '3001', 15)
    withoutVerifiedBrickLink('3001')
    const remarks = exportBrickLinkXml(document).xml.match(/<REMARKS>([^<]*)<\/REMARKS>/)?.[1] ?? ''
    const decoded = remarks.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    expect(decoded.length).toBeLessThanOrEqual(BRICKLINK_REMARKS_MAX)
    expect(decoded.endsWith('LDraw fallback id')).toBe(true)
  })

  it('stays silent when every line is a verified BrickLink id with a mapped colour', () => {
    expect(
      describeBrickLinkExport({ lines: 2, unverifiedIds: 0, unmappedColors: 0, totalPieces: 4 }),
    ).toBeNull()
  })
})
