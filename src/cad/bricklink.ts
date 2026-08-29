import { buildBom, type BomLine } from './bom'
import { catalog, getColor } from './catalog'
import type { ModelDocument } from './types'

/**
 * BrickLink wanted-list export.
 *
 * The CSV BOM already emits an identifier column labelled "BrickLink ID". This
 * module is the purchasing path that column was pretending to be: one `<ITEM>`
 * per BOM line, with a report that says when the identifier is a Rebrickable
 * or LDraw fallback rather than a verified BrickLink catalog number.
 */

/** Which tier of the identifier fallback actually supplied an id. */
export type BrickLinkIdSource = 'bricklink' | 'rebrickable-fallback' | 'ldraw-fallback'

export interface BrickLinkLine {
  readonly bomLine: BomLine
  readonly itemId: string
  readonly idSource: BrickLinkIdSource
  /** Absent when no LDraw→BrickLink colour mapping exists for this code. */
  readonly colorId: number | null
}

export interface BrickLinkExportReport {
  readonly lines: number
  readonly unverifiedIds: number
  readonly unmappedColors: number
  readonly totalPieces: number
}

const XML_ESCAPE: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&apos;'],
]

export function escapeXml(value: string): string {
  let escaped = value
  for (const [pattern, replacement] of XML_ESCAPE) escaped = escaped.replace(pattern, replacement)
  return escaped
}

function resolveItemId(line: BomLine): { itemId: string; idSource: BrickLinkIdSource } {
  const definition = catalog.get(line.definitionId)
  const bricklinkId = definition?.identity.bricklinkIds[0]
  if (bricklinkId) return { itemId: bricklinkId, idSource: 'bricklink' }
  if (definition?.identity.rebrickableId) {
    return { itemId: definition.identity.rebrickableId, idSource: 'rebrickable-fallback' }
  }
  return { itemId: line.ldrawId.replace(/\.dat$/i, ''), idSource: 'ldraw-fallback' }
}

export function buildBrickLinkLines(document: ModelDocument): BrickLinkLine[] {
  return buildBom(document).map((bomLine) => {
    const { itemId, idSource } = resolveItemId(bomLine)
    const colorId = getColor(bomLine.colorCode).bricklinkId ?? null
    return { bomLine, itemId, idSource, colorId }
  })
}

/** BrickLink wanted-list remarks are short; keep the fallback tag if we truncate. */
export const BRICKLINK_REMARKS_MAX = 80

function remarksFor(document: ModelDocument, line: BrickLinkLine): string {
  const tag =
    line.idSource === 'bricklink'
      ? ''
      : line.idSource === 'rebrickable-fallback'
        ? '; Rebrickable fallback id'
        : '; LDraw fallback id'
  const budget = Math.max(0, BRICKLINK_REMARKS_MAX - tag.length)
  let base = `${document.name} r${document.revision}`
  if (base.length > budget) {
    base = budget <= 1 ? '' : `${base.slice(0, budget - 1)}…`
  }
  return escapeXml(`${base}${tag}`)
}

function itemBlock(line: BrickLinkLine, remarks: string): string {
  const fields = [
    ['ITEMTYPE', 'P'],
    ['ITEMID', escapeXml(line.itemId)],
    ...(line.colorId === null ? [] : [['COLOR', String(line.colorId)]]),
    ['MINQTY', String(line.bomLine.quantity)],
    ['CONDITION', 'N'],
    ['REMARKS', remarks],
  ] as const
  const body = fields.map(([tag, value]) => `    <${tag}>${value}</${tag}>`).join('\n')
  return `  <ITEM>\n${body}\n  </ITEM>`
}

export function describeBrickLinkExport(report: BrickLinkExportReport): { title: string; detail: string } | null {
  if (report.unverifiedIds === 0 && report.unmappedColors === 0) return null
  const bits: string[] = []
  if (report.unverifiedIds === report.lines) {
    bits.push(
      'None carry a verified BrickLink item number — they use LDraw/Rebrickable numbers, which usually but not always match. Check the list on BrickLink before ordering.',
    )
  } else if (report.unverifiedIds > 0) {
    bits.push(
      `${report.unverifiedIds} of ${report.lines} lines use LDraw/Rebrickable numbers rather than verified BrickLink ids. Check those items before ordering.`,
    )
  }
  if (report.unmappedColors > 0) {
    bits.push(
      `${report.unmappedColors} line${report.unmappedColors === 1 ? '' : 's'} have no BrickLink colour mapping and will be treated as any colour.`,
    )
  }
  return {
    title: `Exported ${report.lines} wanted-list line${report.lines === 1 ? '' : 's'}`,
    detail: bits.join(' '),
  }
}

export function exportBrickLinkXml(document: ModelDocument): {
  xml: string
  report: BrickLinkExportReport
} {
  const lines = buildBrickLinkLines(document)
  const items = lines.map((line) => itemBlock(line, remarksFor(document, line)))
  const xml = items.length
    ? `<INVENTORY>\n${items.join('\n')}\n</INVENTORY>\n`
    : '<INVENTORY></INVENTORY>\n'
  return {
    xml,
    report: {
      lines: lines.length,
      unverifiedIds: lines.filter((line) => line.idSource !== 'bricklink').length,
      unmappedColors: lines.filter((line) => line.colorId === null).length,
      totalPieces: lines.reduce((sum, line) => sum + line.bomLine.quantity, 0),
    },
  }
}
