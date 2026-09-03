import { catalog, originForSurface, surfaceAbove } from '../catalog'
import { basisFromEulerDegrees, cleanBasis } from '../math'
import { deriveConnectionEdges } from '../snapping'
import type { BuildStep, ModelDocument, PartInstance, Subassembly, Vec3 } from '../types'

/**
 * A brick-built survey rover, assembled from real catalog parts at exact LDU
 * transforms: thirty-three pieces, four assemblies, a locked cockpit, an
 * anchored note and three constraints.
 *
 * It opened the editor until the site model replaced it. It stays because it is
 * the document the agent, WebMCP and refinement suites are written against — a
 * model small enough to assert part ids against and structured enough to
 * exercise locking, protection and constraint refusal. Those suites want a
 * fixture with known contents, not whatever the application happens to open on.
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

const WHITE = 15
const BLACK = 0
const GREY = 72
const LIGHT_GREY = 71
const ORANGE = 25
// LDraw 43 is Trans Light Blue: a real production colour for this windscreen.
const TRANS = 43

interface PlaceOptions {
  rotationY?: number
  subassemblyId?: string
  stepId?: string
  protectedPart?: boolean
}

class RoverBuilder {
  readonly parts: PartInstance[] = []
  private sequence = 0

  /**
   * Places one part with its underside resting on `surfaceY`, and returns the
   * stud plane it exposes (or `surfaceY` unchanged for a studless element).
   */
  place(definitionId: string, color: number, x: number, z: number, surfaceY: number, options: PlaceOptions = {}): number {
    const definition = catalog.get(definitionId)
    if (!definition) throw new Error(`Showcase references ${definitionId}, which is not in the compiled catalog pack.`)
    const y = originForSurface(definition, surfaceY)
    this.sequence += 1
    this.parts.push({
      id: `part_${String(this.sequence).padStart(4, '0')}`,
      definitionId,
      color,
      transform: { position: [x, y, z] as Vec3, basis: cleanBasis(basisFromEulerDegrees([0, options.rotationY ?? 0, 0])) },
      subassemblyId: options.subassemblyId ?? 'hull',
      stepId: options.stepId ?? 'step_1',
      provenance: 'human',
      protected: options.protectedPart ?? false,
    })
    return surfaceAbove(definition, y) ?? surfaceY
  }

  /**
   * Places a part at an explicit origin.
   *
   * Needed for parts that mate to another part's connector rather than resting
   * on a surface. A hinge top plate has no anti-studs at all, so deriving its
   * origin from a surface plane is meaningless — it belongs wherever its hinge
   * connector coincides with its counterpart's.
   */
  placeAt(definitionId: string, color: number, x: number, y: number, z: number, options: PlaceOptions = {}): number {
    const definition = catalog.get(definitionId)
    if (!definition) throw new Error(`Showcase references ${definitionId}, which is not in the compiled catalog pack.`)
    this.sequence += 1
    this.parts.push({
      id: `part_${String(this.sequence).padStart(4, '0')}`,
      definitionId,
      color,
      transform: { position: [x, y, z] as Vec3, basis: cleanBasis(basisFromEulerDegrees([0, options.rotationY ?? 0, 0])) },
      subassemblyId: options.subassemblyId ?? 'hull',
      stepId: options.stepId ?? 'step_1',
      provenance: 'human',
      protected: options.protectedPart ?? false,
    })
    return surfaceAbove(definition, y) ?? y
  }

  row(definitionId: string, color: number, xs: number[], zs: number[], surfaceY: number, options: PlaceOptions = {}) {
    let exposed = surfaceY
    for (const x of xs) for (const z of zs) exposed = this.place(definitionId, color, x, z, surfaceY, options)
    return exposed
  }
}

export function createRoverDocument(): ModelDocument {
  const build = new RoverBuilder()

  // Layer 1 — chassis floor. Three 4×8 plates give an 8 × 12 stud footprint.
  const chassis = { subassemblyId: 'chassis', stepId: 'step_1' }
  const afterChassis = build.row('3035', BLACK, [0], [-80, 0, 80], 0, chassis)

  // Layer 2 — interlock. The two long plates deliberately straddle the layer-1
  // seams at z = ±40; without them the floor would be three separate slabs that
  // merely touch, which the connectivity check would correctly report.
  const lock = { subassemblyId: 'chassis', stepId: 'step_2' }
  build.row('3035', GREY, [0], [-40, 40], afterChassis, lock)
  const afterLock = build.row('3020', GREY, [-40, 40], [-100, 100], afterChassis, lock)

  // Layer 3 — hull walls, two studs thick down each side, with a bulkhead
  // closing the cockpit bay.
  const hull = { subassemblyId: 'hull', stepId: 'step_3' }
  const afterHull = build.row('3001', WHITE, [-60, 60], [-80, 0, 80], afterLock, { ...hull, rotationY: 90 })
  build.place('3010', ORANGE, 0, -110, afterLock, hull)
  build.place('3010', ORANGE, 0, 110, afterLock, hull)
  build.place('3010', WHITE, 0, 30, afterLock, hull)

  // Layer 4 — equipment deck over the rear bay.
  const deck = { subassemblyId: 'deck', stepId: 'step_4' }
  const afterDeck = build.row('3020', GREY, [-40, 40], [60, 100], afterHull, deck)

  // Layer 5 — cockpit. Locked, so the agent has to design around it. The
  // windscreen spans the nose; its rear edge stops clear of the bulkhead studs.
  const cockpit = { subassemblyId: 'cockpit', stepId: 'step_5', protectedPart: true }
  build.place('62360', TRANS, 0, -50, afterHull, cockpit)
  build.place('3004', GREY, -60, 10, afterHull, cockpit)
  build.place('3004', GREY, 60, 10, afterHull, cockpit)

  // Layer 6 — a hinged rear hatch, so the model contains a real mechanism and
  // not only rigid stud connections. The two halves mate through the LDCad
  // `hgBrC` hinge group and share an origin.
  const hatch = { subassemblyId: 'deck', stepId: 'step_6' }
  const hingeOrigin = originForSurface(catalog.get('3937'), afterDeck)
  build.place('3937', LIGHT_GREY, 0, 90, afterDeck, hatch)
  // The top plate shares the base's origin: that is where their hinge
  // connectors coincide. White rather than the rover's orange accent because
  // 3938 has no observed official-set appearance in orange, and the colour
  // evidence check is there to be respected.
  build.placeAt('3938', WHITE, 0, hingeOrigin, 90, hatch)

  // Layer 6 — surface detail: smooth deck tiles, grille intakes and nose tiles.
  // Tiles expose no stud plane, which the kernel reads from their connectors.
  const detail = { subassemblyId: 'deck', stepId: 'step_6' }
  build.row('87079', LIGHT_GREY, [-40, 40], [60], afterDeck, detail)
  build.row('2412b', BLACK, [-40, 40], [110], afterDeck, detail)
  build.row('3070b', ORANGE, [-70, 70], [-110], afterHull, { subassemblyId: 'hull', stepId: 'step_6' })

  return assemble(build.parts, 'Survey rover', 1)
}

/**
 * A part-free document that still carries the showcase's assembly and step
 * scaffold. Fixtures build on it, so its subassembly and step ids are the ones
 * tests place parts into.
 *
 * For a project a person actually starts, use `createBlankDocument`.
 */
function assemble(
  parts: PartInstance[],
  name: string,
  revision: number,
): ModelDocument {
  const subassemblies: Record<string, Subassembly> = {}
  for (const definition of SUBASSEMBLIES) {
    subassemblies[definition.id] = { ...definition, partIds: parts.filter((part) => part.subassemblyId === definition.id).map((part) => part.id) }
  }
  const steps: BuildStep[] = STEPS.map((step) => ({
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
    notes: [
          {
            id: 'note_1',
            anchorPartIds: parts.filter((part) => part.subassemblyId === 'cockpit').map((part) => part.id),
            text: 'Cockpit geometry is final. Build around it.',
            status: 'open',
            author: 'human',
            revisionCreated: 1,
          },
        ],
    constraints: [
          { id: 'c_size', kind: 'dimensions', label: 'Envelope ≤ 10 × 14 studs', value: { width: 10, depth: 14 }, hard: true },
          { id: 'c_count', kind: 'piece-count', label: 'Piece budget', value: 320, hard: true },
          { id: 'c_lock', kind: 'locked-region', label: 'Cockpit locked', value: 'cockpit', hard: true },
        ],
  }
  // The connection graph belongs to the document, not only to the engine, so a
  // constructed document already knows how it is assembled.
  document.connections = deriveConnectionEdges(document, revision, 'import-inferred')
  return document
}
