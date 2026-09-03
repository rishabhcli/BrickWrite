import { catalog } from './catalog'
import { deriveConnectionEdges } from './snapping'
import type { BuildStep, ModelDocument, PartInstance, Subassembly } from './types'

export { createShowcaseDocument } from './showcase'

/**
 * The assembly and step scaffold `createEmptyDocument` carries.
 *
 * These ids are a fixture contract: kernel, refinement and WebMCP tests place
 * parts into 'chassis', 'hull', 'cockpit' and 'deck' on top of an empty
 * document, so they outlived the rover that named them.
 */
const SUBASSEMBLIES: Array<Omit<Subassembly, 'partIds'>> = [
  { id: 'chassis', name: 'Chassis', locked: false, accent: '#6bbbd6' },
  { id: 'hull', name: 'Hull', locked: false, accent: '#f7b04a' },
  { id: 'cockpit', name: 'Cockpit', locked: true, accent: '#87f7ff' },
  { id: 'deck', name: 'Equipment deck', locked: false, accent: '#8bcf65' },
]

const STEPS: Array<Omit<BuildStep, 'partIds'>> = [
  { id: 'step_1', index: 1, name: 'Chassis floor' },
  { id: 'step_2', index: 2, name: 'Interlock layer' },
  { id: 'step_3', index: 3, name: 'Hull walls' },
  { id: 'step_4', index: 4, name: 'Decks' },
  { id: 'step_5', index: 5, name: 'Cockpit' },
  { id: 'step_6', index: 6, name: 'Surface detail' },
]

/**
 * A part-free document carrying the fixture assembly and step scaffold that
 * kernel tests place parts into.
 *
 * For a project a person actually starts, use `createBlankDocument`.
 */
export function createEmptyDocument(): ModelDocument {
  return assemble([], 'Untitled build', 0)
}

/**
 * A new, genuinely blank project.
 *
 * One unlocked assembly and one step. A blank document that opens
 * pre-populated with somebody else's "Chassis" and "Hull walls" is describing
 * their model, and nothing on screen says which of those names mean anything
 * here.
 */
export function createBlankDocument(name = 'Untitled build'): ModelDocument {
  return assemble([], name, 0, {
    subassemblies: [{ id: 'main', name: 'Main assembly', locked: false, accent: '#6bbbd6' }],
    steps: [{ id: 'step_1', index: 1, name: 'Step 1' }],
  })
}

function assemble(
  parts: PartInstance[],
  name: string,
  revision: number,
  structure?: { subassemblies: Array<Omit<Subassembly, 'partIds'>>; steps: Array<Omit<BuildStep, 'partIds'>> },
): ModelDocument {
  const subassemblies: Record<string, Subassembly> = {}
  for (const definition of structure?.subassemblies ?? SUBASSEMBLIES) {
    subassemblies[definition.id] = { ...definition, partIds: parts.filter((part) => part.subassemblyId === definition.id).map((part) => part.id) }
  }
  const steps: BuildStep[] = (structure?.steps ?? STEPS).map((step) => ({
    ...step,
    partIds: parts.filter((part) => part.stepId === step.id).map((part) => part.id),
  }))
  const timestamp = new Date().toISOString()
  const document: ModelDocument = {
    schemaVersion: 2,
    id: `doc_${name.toLowerCase().replace(/\W+/g, '_')}`,
    name,
    revision,
    catalogVersion: catalog.version,
    createdAt: timestamp,
    updatedAt: timestamp,
    parts: Object.fromEntries(parts.map((part) => [part.id, part])),
    connections: {},
    subassemblies,
    steps,
    notes: [],
    constraints: [],
  }
  // The connection graph belongs to the document, not only to the engine, so a
  // constructed document already knows how it is assembled.
  document.connections = deriveConnectionEdges(document, revision, 'import-inferred')
  return document
}
