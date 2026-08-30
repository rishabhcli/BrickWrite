import { STUD_LDU } from '../../cad/catalog'
import { getPartBounds } from '../../cad/geometry'
import { createId } from '../../cad/ids'
import type { CadOperation, ModelDocument, PartInstance, Subassembly } from '../../cad/types'

/** An editor-local snapshot: copy never mutates the model or overwrites system text. */
export interface PartClipboard {
  documentId: string
  parts: PartInstance[]
  subassemblies: Subassembly[]
  cut: boolean
}

export function captureParts(document: ModelDocument, ids: readonly string[], cut = false): PartClipboard | null {
  const parts = [...new Set(ids)].map((id) => document.parts[id]).filter(Boolean)
  if (!parts.length) return null
  if (parts.length > 1000) throw new Error('Copy at most 1,000 parts at a time.')
  const groups = new Set(parts.map((part) => part.subassemblyId))
  return structuredClone({
    documentId: document.id,
    parts,
    cut,
    subassemblies: Object.values(document.subassemblies).filter((group) => groups.has(group.id)),
  })
}

export function planPaste(
  document: ModelDocument,
  clipboard: PartClipboard,
): {
  operations: CadOperation[]
  selection: string[]
} {
  const operations: CadOperation[] = []
  const selection: string[] = []
  const existing = Object.values(document.parts)
  const copiedBounds = clipboard.parts.map(getPartBounds)
  const minX = Math.min(...copiedBounds.map((bounds) => bounds.min[0]))
  const maxY = Math.max(...copiedBounds.map((bounds) => bounds.max[1]))
  const minZ = Math.min(...copiedBounds.map((bounds) => bounds.min[2]))
  const restoreCut =
    clipboard.cut && document.id === clipboard.documentId && clipboard.parts.every((part) => !document.parts[part.id])
  // A clear lane beside the whole model, not a fixed offset that collides on paste #2.
  const right = existing.length ? Math.max(...existing.map((part) => getPartBounds(part).max[0])) + STUD_LDU : 0
  const delta = restoreCut
    ? [0, 0, 0]
    : [
        Math.ceil((right - minX) / STUD_LDU) * STUD_LDU,
        -maxY,
        existing.length ? 0 : -Math.round(minZ / STUD_LDU) * STUD_LDU,
      ]
  const groups = new Map<string, string>()
  for (const source of clipboard.subassemblies) {
    if (document.id === clipboard.documentId && document.subassemblies[source.id]) {
      groups.set(source.id, source.id)
    } else {
      const id = createId('pasted_module')
      groups.set(source.id, id)
      operations.push({ type: 'subassembly.add', subassembly: { ...source, id, locked: false, partIds: [] } })
    }
  }
  const fallback = Object.keys(document.subassemblies)[0]
  const stepId = document.steps.at(-1)?.id
  if (!stepId || (!fallback && !groups.size)) throw new Error('Create a build step and module before pasting.')
  for (const source of clipboard.parts) {
    const id = createId('pasted_part')
    selection.push(id)
    operations.push({
      type: 'part.add',
      part: {
        ...structuredClone(source),
        id,
        protected: false,
        provenance: 'human',
        subassemblyId: groups.get(source.subassemblyId) ?? fallback,
        stepId:
          document.id === clipboard.documentId && document.steps.some((step) => step.id === source.stepId)
            ? source.stepId
            : stepId,
        transform: {
          ...source.transform,
          position: [
            source.transform.position[0] + delta[0],
            source.transform.position[1] + delta[1],
            source.transform.position[2] + delta[2],
          ],
        },
      },
    })
  }
  return { operations, selection }
}
