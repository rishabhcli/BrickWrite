import { catalog } from './catalog'
import { cleanBasis, composeTransform, IDENTITY_TRANSFORM, type Mat3, type RigidTransform } from './math'
import type { ModelDocument, PartInstance, Transform } from './types'

/**
 * LDraw serialization.
 *
 * A type-1 line is `1 <colour> x y z a b c d e f g h i <file>`, where the nine
 * values are a row-major 3×3. The kernel stores exactly that: LDU positions and
 * an orthonormal row-major basis in LDraw's own frame. Export is therefore a
 * direct write and import a direct read — no Euler decomposition, so arbitrary
 * rotations, off-axis SNOT placements and mirrored matrices round-trip exactly
 * rather than approximately.
 */

const clean = (value: number) => {
  const normalized = Math.abs(value) < 1e-10 ? 0 : value
  return Number(normalized.toFixed(6)).toString()
}

const safeName = (value: string) => value.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'model'

function partLine(part: PartInstance): string {
  const matrix = cleanBasis(part.transform.basis)
  const [x, y, z] = part.transform.position
  const ldrawId = catalog.get(part.definitionId)?.ldrawId ?? `${part.definitionId}.dat`
  return `1 ${part.color} ${clean(x)} ${clean(y)} ${clean(z)} ${matrix.map(clean).join(' ')} ${ldrawId}`
}

const header = (document: ModelDocument, title: string, filename: string) => [
  `0 FILE ${filename}`,
  `0 ${title}`,
  '0 Name: Brickwright export',
  '0 Author: Brickwright human + agent document',
  `0 !BRICKWRIGHT REVISION ${document.revision}`,
  `0 !BRICKWRIGHT CATALOG ${document.catalogVersion}`,
  '0 BFC CERTIFY CCW',
]

/**
 * Flat `.ldr` export with `0 STEP` boundaries preserved from the build steps.
 */
export function exportLDraw(document: ModelDocument): string {
  const lines = header(document, document.name, `${safeName(document.name)}.ldr`)
  const emitted = new Set<string>()
  const sortedSteps = [...document.steps].sort((a, b) => a.index - b.index)

  sortedSteps.forEach((step, index) => {
    if (index > 0) lines.push('0 STEP')
    lines.push(`0 !BRICKWRIGHT STEP ${step.index} ${step.name}`)
    for (const partId of step.partIds) {
      const part = document.parts[partId]
      if (!part) continue
      lines.push(partLine(part), `0 !BRICKWRIGHT INSTANCE ${part.id} SUBASSEMBLY ${part.subassemblyId}${part.protected ? ' PROTECTED' : ''}`)
      emitted.add(part.id)
    }
  })

  const remaining = Object.values(document.parts).filter((part) => !emitted.has(part.id))
  if (remaining.length) {
    lines.push('0 STEP')
    for (const part of remaining) {
      lines.push(partLine(part), `0 !BRICKWRIGHT INSTANCE ${part.id} SUBASSEMBLY ${part.subassemblyId}${part.protected ? ' PROTECTED' : ''}`)
    }
  }

  lines.push('0 NOFILE')
  return `${lines.join('\n')}\n`
}

/**
 * Multi-part `.mpd` export: one submodel per subassembly, referenced from the
 * main file. Part transforms are absolute in the document, so each submodel is
 * referenced at the identity transform and the round trip stays exact.
 */
export function exportMpd(document: ModelDocument): string {
  const mainName = `${safeName(document.name)}.ldr`
  const subassemblies = Object.values(document.subassemblies).filter((subassembly) => subassembly.partIds.length)
  const orphans = Object.values(document.parts).filter((part) => !document.subassemblies[part.subassemblyId])

  const main = header(document, document.name, mainName)
  for (const subassembly of subassemblies) {
    main.push(
      `0 !BRICKWRIGHT SUBASSEMBLY ${subassembly.id}${subassembly.locked ? ' LOCKED' : ''}`,
      `1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${safeName(subassembly.name)}.ldr`,
    )
  }
  for (const part of orphans) main.push(partLine(part))
  main.push('0 NOFILE')

  const blocks = [main.join('\n')]
  for (const subassembly of subassemblies) {
    const lines = [
      `0 FILE ${safeName(subassembly.name)}.ldr`,
      `0 ${subassembly.name}`,
      '0 BFC CERTIFY CCW',
    ]
    const steps = [...document.steps].sort((a, b) => a.index - b.index)
    let wroteStep = false
    for (const step of steps) {
      const members = step.partIds.map((id) => document.parts[id]).filter((part) => part?.subassemblyId === subassembly.id)
      if (!members.length) continue
      if (wroteStep) lines.push('0 STEP')
      wroteStep = true
      for (const part of members) lines.push(partLine(part))
    }
    const stepless = subassembly.partIds
      .map((id) => document.parts[id])
      .filter((part) => part && !steps.some((step) => step.partIds.includes(part.id)))
    for (const part of stepless) lines.push(partLine(part))
    lines.push('0 NOFILE')
    blocks.push(lines.join('\n'))
  }

  return `${blocks.join('\n')}\n`
}

export interface ImportReport {
  placed: number
  submodels: number
  steps: number
  unknownParts: string[]
  withoutGeometry: string[]
}

interface SourceFile {
  name: string
  lines: string[]
}

/** Splits an `.mpd` into its `0 FILE` blocks; a plain `.ldr` yields one block. */
function splitFiles(source: string): SourceFile[] {
  const files: SourceFile[] = []
  let current: SourceFile = { name: 'main', lines: [] }
  for (const raw of source.split(/\r?\n/)) {
    const fileMatch = raw.trim().match(/^0\s+FILE\s+(.+)$/i)
    if (fileMatch) {
      if (current.lines.length) files.push(current)
      current = { name: fileMatch[1].trim().toLowerCase(), lines: [] }
      continue
    }
    if (/^0\s+NOFILE\b/i.test(raw.trim())) continue
    current.lines.push(raw)
  }
  if (current.lines.length) files.push(current)
  return files
}

/**
 * Imports `.ldr` / `.mpd` into the CAD document.
 *
 * Submodels are flattened into subassemblies: Brickwright stores absolute part
 * transforms, so a nested reference composes its parent's transform on the way
 * down. Parts the compiled catalog cannot place are reported, never silently
 * dropped, so the operator knows exactly what did not survive the import.
 */
export function parseLDraw(source: string, baseDocument: ModelDocument): { document: ModelDocument; report: ImportReport } {
  const files = splitFiles(source)
  const byName = new Map(files.map((file) => [file.name, file]))
  const next = structuredClone(baseDocument)
  next.parts = {}
  next.connections = {}
  next.subassemblies = {}
  next.steps = []

  const report: ImportReport = { placed: 0, submodels: 0, steps: 0, unknownParts: [], withoutGeometry: [] }
  const unknown = new Set<string>()
  const noGeometry = new Set<string>()
  let sequence = 0
  let stepIndex = 0

  const ensureStep = () => {
    if (!next.steps.length) {
      stepIndex = 1
      next.steps.push({ id: 'step_1', index: 1, name: 'Imported step 1', partIds: [] })
    }
    return next.steps[next.steps.length - 1]
  }

  const submodelNames = new Set<string>()
  const ensureSubassembly = (id: string, name: string) => {
    if (!next.subassemblies[id]) {
      next.subassemblies[id] = { id, name, partIds: [], locked: false, accent: '#87f7ff' }
    }
    return next.subassemblies[id]
  }

  const visit = (file: SourceFile, parent: RigidTransform, subassemblyId: string, depth: number) => {
    if (depth > 16) return
    for (const raw of file.lines) {
      const line = raw.trim()
      if (/^0\s+STEP\b/i.test(line)) {
        if (depth === 0) {
          stepIndex += 1
          next.steps.push({ id: `step_${stepIndex}`, index: stepIndex, name: `Imported step ${stepIndex}`, partIds: [] })
        }
        continue
      }
      if (!line.startsWith('1 ')) continue
      const tokens = line.split(/\s+/)
      if (tokens.length < 15) continue
      const values = tokens.slice(2, 14).map(Number)
      if (values.some(Number.isNaN)) continue

      const local: RigidTransform = {
        position: values.slice(0, 3) as unknown as Mat3 as unknown as RigidTransform['position'],
        basis: values.slice(3, 12) as unknown as Mat3,
      }
      const composed = composeTransform(parent, local)
      const reference = tokens.slice(14).join(' ').replace(/\\/g, '/').trim().toLowerCase()

      const submodel = byName.get(reference)
      if (submodel && submodel !== file) {
        const childId = `sub_${reference.replace(/\.(ldr|dat|mpd)$/i, '').replace(/[^a-z0-9_-]+/g, '_')}`
        ensureSubassembly(childId, reference.replace(/\.(ldr|dat|mpd)$/i, ''))
        submodelNames.add(reference)
        visit(submodel, composed, childId, depth + 1)
        continue
      }

      const definitionId = (reference.split('/').pop() ?? '').replace(/\.dat$/i, '')
      const definition = catalog.get(definitionId)
      if (!definition) {
        if (catalog.describe(definitionId)) noGeometry.add(definitionId)
        else unknown.add(definitionId)
        continue
      }

      sequence += 1
      const id = `imported_${String(sequence).padStart(4, '0')}`
      const transform: Transform = composed
      const step = ensureStep()
      const target = ensureSubassembly(subassemblyId, subassemblyId === 'imported' ? 'Imported model' : subassemblyId)
      next.parts[id] = {
        id,
        definitionId,
        color: Number(tokens[1]),
        transform,
        subassemblyId,
        stepId: step.id,
        provenance: 'human',
        protected: false,
      }
      target.partIds.push(id)
      step.partIds.push(id)
      report.placed += 1
    }
  }

  ensureSubassembly('imported', 'Imported model')
  ensureStep()
  visit(files[0] ?? { name: 'main', lines: [] }, IDENTITY_TRANSFORM, 'imported', 0)

  // Drop step and subassembly shells that received nothing.
  next.steps = next.steps.filter((step) => step.partIds.length)
  if (!next.steps.length) next.steps = [{ id: 'step_1', index: 1, name: 'Imported step 1', partIds: [] }]
  for (const key of Object.keys(next.subassemblies)) {
    if (!next.subassemblies[key].partIds.length) delete next.subassemblies[key]
  }
  if (!Object.keys(next.subassemblies).length) {
    next.subassemblies.imported = { id: 'imported', name: 'Imported model', partIds: [], locked: false, accent: '#87f7ff' }
  }

  report.submodels = submodelNames.size
  report.steps = next.steps.length
  report.unknownParts = Array.from(unknown).sort()
  report.withoutGeometry = Array.from(noGeometry).sort()

  next.revision = baseDocument.revision + 1
  next.updatedAt = new Date().toISOString()
  next.name = 'Imported LDraw model'
  return { document: next, report }
}

export function downloadText(filename: string, contents: string, type = 'text/plain') {
  const blob = new Blob([contents], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
