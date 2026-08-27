import { catalog, getColor } from './catalog'
import type { ModelDocument } from './types'

export interface BomLine {
  definitionId: string
  ldrawId: string
  bricklinkId: string
  name: string
  colorCode: number
  colorName: string
  quantity: number
}

export function buildBom(document: ModelDocument): BomLine[] {
  const grouped = new Map<string, BomLine>()
  for (const part of Object.values(document.parts)) {
    const definition = catalog.get(part.definitionId)
    if (!definition) continue
    const key = `${part.definitionId}:${part.color}`
    const existing = grouped.get(key)
    if (existing) existing.quantity += 1
    else grouped.set(key, {
      definitionId: part.definitionId,
      ldrawId: definition.ldrawId,
      bricklinkId: definition.identity.bricklinkIds[0] ?? definition.identity.rebrickableId ?? definition.canonicalId,
      name: definition.name,
      colorCode: part.color,
      colorName: getColor(part.color).name,
      quantity: 1,
    })
  }
  return Array.from(grouped.values()).sort((a, b) => a.definitionId.localeCompare(b.definitionId, undefined, { numeric: true }) || a.colorCode - b.colorCode)
}

const csv = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`

export function exportBomCsv(document: ModelDocument): string {
  const header = ['Quantity', 'LDraw ID', 'BrickLink ID', 'Part name', 'LDraw color', 'Color name']
  const rows = buildBom(document).map((line) => [line.quantity, line.ldrawId, line.bricklinkId, line.name, line.colorCode, line.colorName])
  return `${[header, ...rows].map((row) => row.map(csv).join(',')).join('\n')}\n`
}
