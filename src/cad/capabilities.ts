import { MechanismGeometryError, planCrane, planLattice, planSnotHull, planClockFaces } from './assembly'
import { articulate, findArticulatedJoints } from './articulation'
import {
  AssemblyError,
  MAX_GENERATED_PARTS,
  planBrickField,
  planEnclosure,
  planHingedFlap,
  planWall,
  type AssemblyPlan,
  chooseElement,
  type BrickFamily,
  type Opening,
} from './assembly'
import { captureModule, describeModule, documentModules, findModule, ModuleError, stampModule } from './modules'
import { catalog, PLATE_LDU, STUD_LDU, studPlaneLdu, underPlaneLdu } from './catalog'
import { boundsOfMany, getPartBounds, nearbyParts, snapLdu } from './geometry'
import { createId } from './ids'
import { composeTransform, invertTransform } from './math'
import { canMirror, mirrorPlaneFor, mirrorTransform, type MirrorAxis } from './mirror'
import { computeBuildOrder } from './instructions'
import { searchMateBetween } from './placement'
import type { Actor, CadOperation, ModelDocument, PartInstance, Vec3 } from './types'
import { floatingPartIds, unclutchedRestCode, unclutchedRestPartIds, airbornePartIds } from './validation'

/**
 * The advanced capability catalog shared by the human command deck and WebMCP.
 *
 * This is deliberately product-level metadata rather than tool-only metadata:
 * every mutating capability below has both a human surface and an agent surface,
 * and both call `planSharedMutation` before entering the same CadEngine.
 */
export const SHARED_CAPABILITIES = [
  { id: 'export_ldraw', kind: 'read', group: 'deliver', title: 'Export LDraw', summary: 'Read the exact flat LDraw representation.', input: {} },
  { id: 'export_mpd', kind: 'read', group: 'deliver', title: 'Export MPD', summary: 'Read the hierarchical multi-part document.', input: {} },
  { id: 'export_bom', kind: 'read', group: 'deliver', title: 'Export parts manifest', summary: 'Read the aggregated bill of materials.', input: {} },
  { id: 'catalog_coverage', kind: 'read', group: 'inspect', title: 'Catalog coverage', summary: 'Inspect measured identity, geometry and connection coverage.', input: {} },
  { id: 'selection_connected', kind: 'read', group: 'inspect', title: 'Connected selection', summary: 'Inspect the complete connected component around selected or named parts.', input: { partIds: 'string[], optional' } },
  { id: 'statics', kind: 'read', group: 'inspect', title: 'Static analysis', summary: 'Measure mass and centre of mass, the footprint the model balances on, and any load hanging from too few studs.', input: { clutchGramsPerStud: 'number, default 100' } },
  { id: 'weak_attachments', kind: 'read', group: 'inspect', title: 'Weak attachments', summary: 'Find parts held by only one neighbouring part.', input: {} },
  { id: 'list_joints', kind: 'read', group: 'mechanism', title: 'List joints', summary: 'Inspect drivable joints in the current scope.', input: { partIds: 'string[], optional' } },
  { id: 'compute_build_order', kind: 'read', group: 'sequence', title: 'Preview build order', summary: 'Derive and verify an attachment-aware build sequence.', input: { maxPartsPerStep: 'integer, optional' } },
  { id: 'duplicate_selection', kind: 'mutate', group: 'transform', title: 'Duplicate precisely', summary: 'Copy parts by a measured direction or an exact LDraw-unit offset.', input: { partIds: 'string[], optional', offsetLdu: '[x,y,z], optional', along: '"x" | "z" | "on-top", optional' } },
  { id: 'mirror_selection', kind: 'mutate', group: 'transform', title: 'Mirror selection', summary: 'Reflect selected transforms across an exact plane on any axis, or about the selection centre. Emits only buildable poses and names parts a reflection cannot carry faithfully.', input: { partIds: 'string[], optional', axis: '"x" | "y" | "z", default "x"', axisLdu: 'number, default 0', about: '"world" | "selection", default world' } },
  { id: 'linear_array', kind: 'mutate', group: 'transform', title: 'Linear array', summary: 'Create deterministic repeated copies along a measured direction or an exact vector.', input: { partIds: 'string[], optional', copies: 'integer 1-24', offsetLdu: '[x,y,z], optional', along: '"x" | "z" | "on-top", optional' } },
  { id: 'build_wall', kind: 'mutate', group: 'assemble', title: 'Lay a wall', summary: 'Generate a bonded brick wall in one transaction, with staggered courses and optional openings.', input: { lengthStuds: 'integer 1-256', courses: 'integer 1-64', axis: '"x" | "z", default "x"', color: 'LDraw colour, optional', family: '"brick" | "plate" | "tile", default "brick"', depthStuds: '1 or 2, default 1', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional', openings: '[{ atStud, widthStuds, fromCourse, toCourse }], optional' } },
  { id: 'build_enclosure', kind: 'mutate', group: 'assemble', title: 'Lay a storey', summary: 'Generate four interlocking walls and an optional floor: one storey of a building, in one transaction.', input: { widthStuds: 'integer', depthStuds: 'integer', courses: 'integer 1-64', color: 'LDraw colour, optional', family: '"brick" | "plate", default "brick"', wallDepthStuds: '1 or 2, default 1', floor: 'boolean, default false', floorLayers: '1 or 2, default 2 (2 is cross-bonded and rigid)', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional', openings: '[{ atStud, widthStuds, fromCourse, toCourse }], optional' } },
  { id: 'build_field', kind: 'mutate', group: 'assemble', title: 'Lay a floor', summary: 'Tile a rectangular footprint with staggered rows, optionally cross-bonded into a rigid slab.', input: { widthStuds: 'integer', depthStuds: 'integer', layers: '1 or 2, default 1', color: 'LDraw colour, optional', family: '"plate" | "tile" | "brick", default "plate"', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional' } },
  { id: 'build_structure', kind: 'mutate', group: 'assemble', title: 'Raise a building', summary: 'Compose a whole multi-storey building in one transaction: deck, storeys with real windows, a ground-floor door, colour banding and a parapet.', input: { widthStuds: 'integer', depthStuds: 'integer', storeys: 'integer 1-24', coursesPerStorey: 'integer 2-12, default 4', color: 'LDraw colour', bandColor: 'LDraw colour, optional', windowsPerSide: 'integer 0-8, default 2', windowWidthStuds: '2 or 4, default 2', door: 'boolean, default true', trimColor: 'LDraw colour for window and door frames, default White', glassColor: 'LDraw colour for glazing, default Trans-Clear', deckLayers: '1 or 2, default 2 (2 is cross-bonded and rigid)', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional' } },
  { id: 'build_hinged_flap', kind: 'mutate', group: 'assemble', title: 'Hinge a flap', summary: 'Build a flap that actually opens: a hinge line and a plate panel that the kernel can drive as a revolute joint.', input: { widthStuds: 'even integer ≥ 2', reachStuds: 'integer ≥ 1', color: 'LDraw colour, optional', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional' } },
  { id: 'capture_module', kind: 'mutate', group: 'assemble', title: 'Capture a module', summary: 'Save the selection as a reusable named sub-build, rebased onto its own origin.', input: { name: 'string', partIds: 'string[], optional' } },
  { id: 'stamp_module', kind: 'mutate', group: 'assemble', title: 'Stamp a module', summary: 'Place copies of a captured module at an exact pose, or onto an existing part id. Prefer anchorPartId so the pose is measured.', input: { module: 'module id or name', atLdu: '[x,y,z], optional when anchorPartId is set', anchorPartId: 'existing part id, optional', quarterTurns: 'integer, optional', copies: 'integer 1-64, default 1', spacingLdu: '[x,y,z], optional', color: 'LDraw colour, optional' } },
  { id: 'remove_module', kind: 'mutate', group: 'assemble', title: 'Remove a module', summary: 'Delete a captured module. Parts already stamped from it are untouched.', input: { module: 'module id or name' } },
  { id: 'stack_selection', kind: 'mutate', group: 'assemble', title: 'Stack storeys', summary: 'Repeat the selection upward by its own measured height — a tower from one floor.', input: { copies: 'integer 1-32', partIds: 'string[], optional', gapLdu: 'number, default 0' } },
  { id: 'connect_parts', kind: 'mutate', group: 'mechanism', title: 'Connect parts', summary: 'Use the deterministic 6-DOF solver to mate two placed parts.', input: { movingPartId: 'string', targetPartId: 'string' } },
  { id: 'articulate_joint', kind: 'mutate', group: 'mechanism', title: 'Drive joint', summary: 'Rotate or slide a persisted articulated joint and its rigid island.', input: { edgeId: 'string', partIds: 'string[], optional', rotateDegrees: 'number, optional', slideLdu: 'number, optional' } },
  { id: 'create_subassembly', kind: 'mutate', group: 'structure', title: 'Create subassembly', summary: 'Create a named assembly and optionally move the selection into it.', input: { name: 'string', partIds: 'string[], optional', accent: '#rrggbb, optional' } },
  { id: 'assign_subassembly', kind: 'mutate', group: 'structure', title: 'Assign subassembly', summary: 'Move selected or named parts into an existing assembly.', input: { subassemblyId: 'string', partIds: 'string[], optional' } },
  { id: 'rename_subassembly', kind: 'mutate', group: 'structure', title: 'Rename subassembly', summary: 'Rename an existing unlocked assembly.', input: { subassemblyId: 'string', name: 'string' } },
  { id: 'lock_subassembly', kind: 'mutate', group: 'structure', title: 'Lock subassembly', summary: 'Change the kernel-enforced agent lock on an assembly.', input: { subassemblyId: 'string', locked: 'boolean' } },
  { id: 'add_builder_note', kind: 'mutate', group: 'collaborate', title: 'Add spatial note', summary: 'Anchor human or agent feedback to exact parts.', input: { text: 'string', partIds: 'string[], optional' } },
  { id: 'respond_to_note', kind: 'mutate', group: 'collaborate', title: 'Respond to note', summary: 'Reply to and optionally resolve a builder note.', input: { noteId: 'string', response: 'string', resolved: 'boolean, optional' } },
  { id: 'set_dimension_limit', kind: 'mutate', group: 'constraints', title: 'Set size envelope', summary: 'Create or update a kernel-enforced maximum build envelope.', input: { widthStuds: 'positive number', depthStuds: 'positive number', heightStuds: 'positive number, optional', hard: 'boolean, default true' } },
  { id: 'set_piece_budget', kind: 'mutate', group: 'constraints', title: 'Set piece budget', summary: 'Create or update a maximum piece-count design constraint.', input: { maxParts: 'integer 1-100000', hard: 'boolean, default true' } },
  { id: 'set_palette', kind: 'mutate', group: 'constraints', title: 'Set allowed palette', summary: 'Restrict the build to explicit LDraw colour codes.', input: { colors: 'integer[] 1-64', hard: 'boolean, default true' } },
  { id: 'remove_constraint', kind: 'mutate', group: 'constraints', title: 'Remove constraint', summary: 'Remove a named design constraint through shared history.', input: { constraintId: 'string' } },
  { id: 'apply_build_order', kind: 'mutate', group: 'sequence', title: 'Generate build order', summary: 'Replace the timeline with a verified attachment-aware sequence.', input: { maxPartsPerStep: 'integer, optional' } },
  { id: 'rename_document', kind: 'mutate', group: 'project', title: 'Rename project', summary: 'Rename the revisioned CAD document through the command bus.', input: { name: 'string' } },
  // === CAD-MECHANISM-OWNED (Sol-1) ===
  { id: 'build_crane', kind: 'mutate', group: 'mechanism', title: 'Build a crane', summary: 'Four-course mast and a bonded boom on a real luffing hinge; no winch or load rating.', input: { boomStuds: 'integer 2-64', color: 'LDraw colour, optional', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional' } },
  { id: 'build_lattice', kind: 'mutate', group: 'mechanism', title: 'Build an orthogonal lattice', summary: 'Stud columns between bonded decks. Dimensions minus one must be multiples of bayStuds. No diagonal trusses.', input: { widthStuds: 'integer 3-32', depthStuds: 'integer 3-32', heightCourses: 'integer 1-16', bayStuds: 'integer 2-16', color: 'LDraw colour, optional', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional' } },
  { id: 'build_snot_hull', kind: 'mutate', group: 'mechanism', title: 'Build a sideways-stud hull', summary: 'Open deck and side-stud rim with genuinely clutched plate skins. Dimensions exclude the exterior skins.', input: { widthStuds: 'integer 3-32', depthStuds: 'integer 3-32', layers: 'integer 1-2', color: 'LDraw colour, optional', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional' } },
  { id: 'build_clock_faces', kind: 'mutate', group: 'mechanism', title: 'Build four clock hands', summary: 'Four open square-frame faces with one articulated hand each. Nominal sweep diameter; no dials, gearing or timekeeping.', input: { diameterStuds: 'integer 4-16', color: 'LDraw colour, optional', originLdu: '[x,y,z], optional', anchorPartId: 'existing part id, optional' } },
  // === AGENT-ML-OWNED (Opus) ===
  { id: 'generate_from_brief', kind: 'mutate', group: 'assemble', title: 'Generate from a brief', summary: 'Compile a sentence into a design brief and run the generation pipeline: a whole bonded model, massed, framed, packed and detailed, as one transaction. Deterministic here; the model-backed path is the generation_run tool.', input: { prompt: 'string', candidateCount: 'integer 1-6, default 1', useModel: 'boolean, default false — true is refused here, use generation_run', partBudget: 'integer 1-4000, optional', envelopeStuds: '[w,h,d], optional' } },
  { id: 'generate_region', kind: 'mutate', group: 'assemble', title: 'Generate into a region', summary: 'Generate a sub-build into a measured envelope on an existing part — a wing, a ramp, another storey — leaving every part already placed byte-identical.', input: { prompt: 'string', anchorPartId: 'existing part id, optional', envelopeStuds: '[w,h,d], optional', partBudget: 'integer 1-4000, optional' } },
] as const

export type SharedCapability = (typeof SHARED_CAPABILITIES)[number]
export type SharedCapabilityId = SharedCapability['id']
export type SharedMutationId = Extract<SharedCapability, { kind: 'mutate' }>['id']

export const SHARED_MUTATION_CAPABILITIES = SHARED_CAPABILITIES.filter(
  (capability): capability is Extract<SharedCapability, { kind: 'mutate' }> => capability.kind === 'mutate',
)

export function sharedCapability(id: string): SharedCapability | undefined {
  return SHARED_CAPABILITIES.find((capability) => capability.id === id)
}

export class SharedCapabilityError extends Error {
  constructor(
    readonly code: 'GEOMETRY_UNAVAILABLE' | 'INVALID_OPERATION' | 'PART_NOT_FOUND' | 'NO_COMPATIBLE_CONNECTOR' | 'CONNECTOR_OCCUPIED' | 'COLLISION' | 'DISCONNECTED' | 'RESOURCE_LIMIT',
    message: string,
    readonly repair: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SharedCapabilityError'
  }
}

function previewAddedParts(document: ModelDocument, operations: readonly CadOperation[]): ModelDocument {
  const parts = { ...document.parts }
  for (const operation of operations) {
    if (operation.type === 'part.add') parts[operation.part.id] = operation.part
  }
  return { ...document, parts }
}

/** Copies that hover or rest unclutched are refused here, before they become a wave. */
function refuseIllegalAdds(document: ModelDocument, operations: readonly CadOperation[]): void {
  const addedIds = operations.filter((operation) => operation.type === 'part.add').map((operation) => operation.part.id)
  if (!addedIds.length) return
  const preview = previewAddedParts(document, operations)
  const floating = new Set(floatingPartIds(preview))
  const airborne = new Set(airbornePartIds(preview))
  const hovering = addedIds.filter((id) => floating.has(id) || airborne.has(id))
  if (hovering.length) {
    throw new SharedCapabilityError(
      'DISCONNECTED',
      `The new parts would leave ${hovering[0]} floating with no clutch and no ground under ${hovering.length === 1 ? 'it' : 'them'}.`,
      // Read by both audiences. This is the text a person sees in a toast when
      // Clone or Array refuses, so it cannot be four sentences of tool names:
      // it used to end "Mate an already-placed hovering brick with
      // connect_parts. Prefer anchorPartId or along over invented XYZ", which
      // tells somebody who just pressed a button nothing they can act on. The
      // steering an agent needs — offset on the ground, do not lift in Y, mate
      // rather than hover — survives without naming a tool to do it with.
      'Offset along the ground so copies rest or clutch, rather than lifting them in Y. A part that already hovers has to be mated onto something placed.',
      { partIds: hovering },
    )
  }
  const rest = unclutchedRestPartIds(preview)
  const sitting = addedIds.filter((id) => rest.includes(id))
  if (sitting.length) {
    const code = unclutchedRestCode(preview, sitting[0]!)
    throw new SharedCapabilityError(
      code,
      `The new parts would rest ${sitting[0]} on another part without clutching.`,
      code === 'CONNECTOR_OCCUPIED'
        ? 'Every exclusive connector on that face is occupied. Offset onto the ground, or onto a face with free studs.'
        : 'That surface cannot clutch this part. Offset onto the ground, or onto a face with free studs.',
      { partIds: sitting },
    )
  }
}

function originOnParts(parts: readonly PartInstance[]): Vec3 {
  const boxes = parts.map(getPartBounds)
  let y = Infinity
  for (const part of parts) {
    const definition = catalog.get(part.definitionId)
    const studs = definition ? studPlaneLdu(definition) : null
    const plane = studs !== null ? part.transform.position[1] + studs : getPartBounds(part).min[1]
    y = Math.min(y, plane)
  }
  const extent = boundsOfMany(boxes)
  return [snapLdu(extent.min[0]), y, snapLdu(extent.min[2])]
}

function stampOriginOnAnchor(anchor: PartInstance): Vec3 {
  return originOnParts([anchor])
}

/** Rigidly seat a stamp onto an existing part using the same solver as connect_parts. */
function seatStampOnAnchor(document: ModelDocument, parts: readonly PartInstance[], anchor: PartInstance): PartInstance[] {
  const first = parts[0]
  if (!first) return [...parts]
  const probe: ModelDocument = { ...document, parts: { ...document.parts, [first.id]: first } }
  const mate = searchMateBetween(first, anchor, probe)
  if (!mate.transform) return [...parts]
  const delta = composeTransform(mate.transform, invertTransform(first.transform))
  return parts.map((part) => ({ ...part, transform: composeTransform(delta, part.transform) }))
}

function seatAddedOperations(
  document: ModelDocument,
  operations: readonly CadOperation[],
  anchor: PartInstance,
): CadOperation[] {
  const added = operations
    .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
    .map((operation) => operation.part)
  if (!added.length) return [...operations]
  const seated = seatStampOnAnchor(document, added, anchor)
  const byId = new Map(seated.map((part) => [part.id, part]))
  return operations.map((operation) => {
    if (operation.type !== 'part.add') return operation
    const next = byId.get(operation.part.id)
    return next ? { ...operation, part: next } : operation
  })
}

function measuredAlongOffset(document: ModelDocument, partIds: readonly string[], along: 'x' | 'z' | 'on-top'): Vec3 {
  if (along === 'on-top') {
    let lowestUnderside = -Infinity
    let highestStudPlane = Infinity
    for (const id of partIds) {
      const part = document.parts[id]
      const definition = catalog.get(part.definitionId)
      if (!definition?.dimensions) continue
      lowestUnderside = Math.max(lowestUnderside, part.transform.position[1] + underPlaneLdu(definition))
      const studs = studPlaneLdu(definition)
      if (studs !== null) highestStudPlane = Math.min(highestStudPlane, part.transform.position[1] + studs)
    }
    const measured = lowestUnderside - highestStudPlane
    const pitch = Math.round(measured / PLATE_LDU) * PLATE_LDU
    if (!Number.isFinite(pitch) || pitch <= 0) {
      throw new SharedCapabilityError(
        'INVALID_OPERATION',
        'The selection exposes no studs to copy onto, so its height cannot be measured.',
        'Select parts whose top course has studs, or pass offsetLdu.',
      )
    }
    return [0, -pitch, 0]
  }
  const boxes = partIds.map((id) => getPartBounds(document.parts[id]))
  const index = along === 'x' ? 0 : 2
  const extent = boundsOfMany(boxes)
  const size = extent.max[index] - extent.min[index]
  const snapped = Math.max(STUD_LDU, Math.round(size / STUD_LDU) * STUD_LDU)
  return along === 'x' ? [snapped, 0, 0] : [0, 0, snapped]
}

function copyOffset(context: SharedMutationContext, args: Record<string, unknown>, partIds: readonly string[]): Vec3 {
  const along = args.along === 'x' || args.along === 'z' || args.along === 'on-top' ? args.along : null
  if (along) return measuredAlongOffset(context.document, partIds, along)
  return vector(args.offsetLdu, [STUD_LDU, 0, 0], 'offsetLdu')
}

function connectFailureDetails(document: ModelDocument, movingPartId: string, targetPartId: string): Record<string, unknown> {
  const nearby = nearbyParts(document, movingPartId, 8).filter((entry) => entry.id !== targetPartId)
  return {
    movingPartId,
    targetPartId,
    nearbyPartId: nearby[0]?.id,
    nearbyPartIds: nearby.slice(0, 4).map((entry) => entry.id),
  }
}

function connectRepair(code: 'COLLISION' | 'CONNECTOR_OCCUPIED' | 'NO_COMPATIBLE_CONNECTOR', details: Record<string, unknown>): string {
  const next = typeof details.nearbyPartId === 'string' ? details.nearbyPartId : null
  const moving = String(details.movingPartId)
  if (next) {
    return `Call preflight_capability connect_parts with movingPartId ${moving} and targetPartId ${next}. Do not invent XYZ.`
  }
  if (code === 'COLLISION') return 'Pick a different target, or move the colliding part clear of the overlap.'
  if (code === 'CONNECTOR_OCCUPIED') return 'Pick a target whose approaches.on-top is true, or rest the moving part on the ground.'
  return 'Inspect both part definitions and choose a compatible, unoccupied target. Call selection_geometry and read nearby.'
}

export interface SharedMutationContext {
  readonly document: ModelDocument
  readonly selection: readonly string[]
  readonly actor: Actor
}

export interface SharedMutationPlan {
  readonly capability: SharedMutationId
  readonly label: string
  readonly operations: readonly CadOperation[]
  readonly nextSelection?: readonly string[]
  readonly summary: string
  /**
   * Measured facts about what the plan did, for capabilities where a sentence
   * is not enough — a generated wall reports its bill, its course count and
   * every course it could not fully bond, so the caller is told what it got
   * rather than that something happened.
   */
  readonly report?: Record<string, unknown>
}

const MAX_PART_SCOPE = 500
const MAX_ARRAY_COPIES = 24

function finite(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const result = Number(value)
  if (!Number.isFinite(result)) {
    throw new SharedCapabilityError('INVALID_OPERATION', `${label} must be a finite number.`, `Send ${label} as a finite number.`)
  }
  return result
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const result = Math.trunc(finite(value, fallback, label))
  if (result < min || result > max) {
    throw new SharedCapabilityError('RESOURCE_LIMIT', `${label} must be between ${min} and ${max}.`, `Choose ${label} in the supported range.`)
  }
  return result
}

function vector(value: unknown, fallback: Vec3, label: string): Vec3 {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(Number(entry)))) {
    throw new SharedCapabilityError('INVALID_OPERATION', `${label} must contain exactly three finite numbers.`, `Send ${label} as [x,y,z] in LDraw units.`)
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])]
}

function text(value: unknown, label: string, max: number): string {
  const result = String(value ?? '').trim()
  if (!result || result.length > max) {
    throw new SharedCapabilityError('INVALID_OPERATION', `${label} must contain 1–${max} characters.`, `Send a concise non-empty ${label.toLowerCase()}.`)
  }
  return result
}

function positive(value: unknown, fallback: number, label: string): number {
  const result = finite(value, fallback, label)
  if (result <= 0) {
    throw new SharedCapabilityError('INVALID_OPERATION', `${label} must be greater than zero.`, `Send ${label} as a positive number.`)
  }
  return result
}

function scopedPartIds(context: SharedMutationContext, args: Record<string, unknown>, required = true): string[] {
  const requested = Array.isArray(args.partIds) ? args.partIds.map(String) : [...context.selection]
  const ids = [...new Set(requested)]
  if (required && !ids.length) {
    throw new SharedCapabilityError('INVALID_OPERATION', 'This capability needs at least one part.', 'Select parts in the editor or pass explicit partIds.')
  }
  if (ids.length > MAX_PART_SCOPE) {
    throw new SharedCapabilityError('RESOURCE_LIMIT', `The part scope contains ${ids.length} parts.`, `Use at most ${MAX_PART_SCOPE} parts per command.`)
  }
  const missing = ids.filter((id) => !context.document.parts[id])
  if (missing.length) {
    throw new SharedCapabilityError('PART_NOT_FOUND', `Part ${missing[0]} is not present at revision ${context.document.revision}.`, 'Reread the model and use current part ids.', { missing })
  }
  return ids
}


/**
 * Where a generated assembly starts, when the caller does not say.
 *
 * Defaulting to the origin would drop a storey through whatever is already
 * built. Defaulting to the stud plane of the selection is what a person means
 * by "now put a floor on that". An agent copies `anchorPartId` instead of XYZ.
 */
export function assemblyPlacement(
  context: SharedMutationContext,
  args: Record<string, unknown>,
): { origin: Vec3; anchor: PartInstance | null } {
  const anchorPartId = typeof args.anchorPartId === 'string' && args.anchorPartId ? args.anchorPartId : ''
  if (anchorPartId) {
    const anchor = context.document.parts[anchorPartId]
    if (!anchor) {
      throw new SharedCapabilityError(
        'PART_NOT_FOUND',
        `Part ${anchorPartId} is not present at revision ${context.document.revision}.`,
        'Pass an id from scene_query. Do not invent a part id or XYZ.',
      )
    }
    return { origin: stampOriginOnAnchor(anchor), anchor }
  }
  if (args.originLdu !== undefined) return { origin: vector(args.originLdu, [0, 0, 0], 'originLdu'), anchor: null }
  const scope = context.selection.filter((id) => context.document.parts[id])
  if (!scope.length) return { origin: [0, 0, 0], anchor: null }
  const parts = scope.map((id) => context.document.parts[id])
  return { origin: originOnParts(parts), anchor: parts[0] ?? null }
}

function finishAssemblyOperations(
  context: SharedMutationContext,
  operations: readonly CadOperation[],
  anchor: PartInstance | null,
): CadOperation[] {
  const seated = anchor ? seatAddedOperations(context.document, operations, anchor) : [...operations]
  refuseIllegalAdds(context.document, seated)
  return seated
}

function assemblyFamily(value: unknown, fallback: BrickFamily): BrickFamily {
  if (value === undefined) return fallback
  const name = String(value)
  if (name === 'brick' || name === 'plate' || name === 'tile') return name
  throw new SharedCapabilityError('INVALID_OPERATION', `Unknown part family "${name}".`, 'Use family "brick", "plate" or "tile".')
}

function assemblyOpenings(value: unknown): Opening[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new SharedCapabilityError('INVALID_OPERATION', 'openings must be an array.', 'Send openings as [{ atStud, widthStuds, fromCourse, toCourse }].')
  }
  if (value.length > 24) {
    throw new SharedCapabilityError('RESOURCE_LIMIT', `${value.length} openings were requested.`, 'Use at most 24 openings per wall.')
  }
  return value.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>
    return {
      atStud: integer(entry.atStud, 0, 0, 4096, `openings[${index}].atStud`),
      widthStuds: integer(entry.widthStuds, 1, 1, 4096, `openings[${index}].widthStuds`),
      fromCourse: integer(entry.fromCourse, 0, 0, 4096, `openings[${index}].fromCourse`),
      toCourse: integer(entry.toCourse, 0, 0, 4096, `openings[${index}].toCourse`),
    }
  })
}

/**
 * Plans one of the parametric assemblies and wraps its report.
 *
 * The generator's own refusals are translated rather than swallowed: an
 * unbuildable footprint or a family this build has no parts for comes back with
 * the same code-and-repair shape every other capability uses.
 */
function planGeneratedAssembly(
  capability: 'build_wall' | 'build_enclosure' | 'build_field' | 'build_hinged_flap',
  args: Record<string, unknown>,
  context: SharedMutationContext,
): SharedMutationPlan {
  const { origin, anchor } = assemblyPlacement(context, args)
  const color = integer(args.color, 71, 0, 999999, 'color')
  const base = {
    origin,
    color,
    trimColor: args.trimColor === undefined ? undefined : integer(args.trimColor, 15, 0, 999999, 'trimColor'),
    glassColor: args.glassColor === undefined ? undefined : integer(args.glassColor, 47, 0, 999999, 'glassColor'),
    subassemblyId:
      Object.values(context.document.subassemblies).find((item) => !item.locked)?.id
      ?? Object.keys(context.document.subassemblies)[0]
      ?? 'main',
    stepId: context.document.steps.at(-1)?.id ?? 'step_1',
    actor: context.actor,
  }

  let plan: AssemblyPlan
  let label: string
  try {
    if (capability === 'build_wall') {
      const lengthStuds = integer(args.lengthStuds, 8, 1, 256, 'lengthStuds')
      const courses = integer(args.courses, 3, 1, 64, 'courses')
      const axis = args.axis === 'z' ? 'z' : 'x'
      plan = planWall({
        ...base,
        axis,
        lengthStuds,
        courses,
        family: assemblyFamily(args.family, 'brick'),
        depthStuds: integer(args.depthStuds, 1, 1, 2, 'depthStuds'),
        openings: assemblyOpenings(args.openings),
      })
      label = `Lay a ${lengthStuds} × ${courses} wall`
    } else if (capability === 'build_enclosure') {
      const widthStuds = integer(args.widthStuds, 12, 1, 256, 'widthStuds')
      const footprintDepthStuds = integer(args.depthStuds, 12, 1, 256, 'depthStuds')
      const courses = integer(args.courses, 4, 1, 64, 'courses')
      plan = planEnclosure({
        ...base,
        widthStuds,
        footprintDepthStuds,
        courses,
        family: assemblyFamily(args.family, 'brick'),
        depthStuds: integer(args.wallDepthStuds, 1, 1, 2, 'wallDepthStuds'),
        floor: args.floor === true,
        floorLayers: integer(args.floorLayers, 2, 1, 2, 'floorLayers'),
        openings: assemblyOpenings(args.openings),
      })
      label = `Lay a ${widthStuds} × ${footprintDepthStuds} storey, ${courses} courses`
    } else if (capability === 'build_hinged_flap') {
      const widthStuds = integer(args.widthStuds, 4, 2, 128, 'widthStuds')
      const reachStuds = integer(args.reachStuds, 4, 1, 128, 'reachStuds')
      plan = planHingedFlap({ ...base, widthStuds, reachStuds })
      label = `Hinge a ${widthStuds} × ${reachStuds} flap`
    } else {
      const widthStuds = integer(args.widthStuds, 12, 1, 256, 'widthStuds')
      const footprintDepthStuds = integer(args.depthStuds, 12, 1, 256, 'depthStuds')
      plan = planBrickField({
        ...base,
        widthStuds,
        footprintDepthStuds,
        layers: integer(args.layers, 1, 1, 2, 'layers'),
        family: assemblyFamily(args.family, 'plate'),
      })
      label = `Lay a ${widthStuds} × ${footprintDepthStuds} floor`
    }
  } catch (cause) {
    if (cause instanceof AssemblyError) {
      throw new SharedCapabilityError(
        cause.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_OPERATION',
        cause.message,
        cause.repair,
      )
    }
    throw cause
  }

  if (!plan.partCount) {
    throw new SharedCapabilityError(
      'INVALID_OPERATION',
      'That specification produced no parts.',
      'Check the footprint, course count and opening spans; an opening wider than the wall leaves nothing to lay.',
    )
  }

  const bonded = plan.unbondedCourses === 0
  const operations = finishAssemblyOperations(context, plan.operations, anchor)
  return {
    capability,
    label,
    operations,
    nextSelection: operations
      .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
      .map((operation) => operation.part.id),
    summary:
      `${plan.partCount} parts in ${plan.courses} course${plan.courses === 1 ? '' : 's'}, `
      + `${bonded ? 'every course staggered against the one below' : `${plan.unbondedCourses} course(s) could not be fully staggered`}`
      + `. Largest run: ${plan.bill[0]?.name ?? 'none'} × ${plan.bill[0]?.count ?? 0}.`,
    report: {
      parts: plan.partCount,
      courses: plan.courses,
      runningBond: bonded,
      unbondedCourses: plan.unbondedCourses,
      bill: plan.bill,
      notes: plan.notes,
      warnings: plan.warnings,
      origin,
      ...(anchor ? { anchorPartId: anchor.id } : {}),
    },
  }
}

const defaultSubassembly = (context: SharedMutationContext): string =>
  Object.values(context.document.subassemblies).find((item) => !item.locked)?.id
  ?? Object.keys(context.document.subassemblies)[0]
  ?? 'main'

function requireModule(context: SharedMutationContext, args: Record<string, unknown>) {
  const key = text(args.module ?? args.moduleId, 'Module', 120)
  const module = findModule(context.document, key)
  if (!module) {
    const available = documentModules(context.document).map((entry) => entry.name)
    throw new SharedCapabilityError(
      'INVALID_OPERATION',
      `No module named “${key}” is captured in this document.`,
      available.length ? `Captured modules: ${available.join(', ')}.` : 'Capture one first with capture_module.',
      { available },
    )
  }
  return module
}

/**
 * Composes a whole building in one transaction.
 *
 * The generators below it each solve one thing; this is the layer that knows
 * what a building *is* — a deck, storeys with windows in them, a door at the
 * ground, a band of contrast where the storeys meet, and a parapet on top. It
 * exists because the alternative is the caller re-deriving that arrangement
 * every time, which is both tedious and the point at which a model stops
 * looking considered.
 */
function planStructure(args: Record<string, unknown>, context: SharedMutationContext): SharedMutationPlan {
  const width = integer(args.widthStuds, 20, 6, 128, 'widthStuds')
  const depth = integer(args.depthStuds, 16, 6, 128, 'depthStuds')
  const storeys = integer(args.storeys, 3, 1, 24, 'storeys')
  const coursesPerStorey = integer(args.coursesPerStorey, 4, 2, 12, 'coursesPerStorey')
  const color = integer(args.color, 71, 0, 999999, 'color')
  const bandColor = args.bandColor === undefined ? null : integer(args.bandColor, 71, 0, 999999, 'bandColor')
  const windowsPerSide = integer(args.windowsPerSide, 2, 0, 8, 'windowsPerSide')
  const windowWidth = integer(args.windowWidthStuds, 2, 1, 8, 'windowWidthStuds')
  const wantDoor = args.door !== false
  const { origin, anchor } = assemblyPlacement(context, args)

  const base = {
    color,
    trimColor: args.trimColor === undefined ? undefined : integer(args.trimColor, 15, 0, 999999, 'trimColor'),
    glassColor: args.glassColor === undefined ? undefined : integer(args.glassColor, 47, 0, 999999, 'glassColor'),
    subassemblyId: defaultSubassembly(context),
    stepId: context.document.steps.at(-1)?.id ?? 'step_1',
    actor: context.actor,
  }

  const operations: CadOperation[] = []
  const bill = new Map<string, { definitionId: string; name: string; count: number }>()
  const notes: string[] = []
  const warnings: string[] = []
  let unbonded = 0
  let windows = 0
  let doors = 0

  const absorb = (plan: AssemblyPlan) => {
    operations.push(...plan.operations)
    for (const entry of plan.bill) {
      const existing = bill.get(entry.definitionId)
      if (existing) existing.count += entry.count
      else bill.set(entry.definitionId, { ...entry })
    }
    unbonded += plan.unbondedCourses
    for (const warning of plan.warnings) warnings.push(warning)
  }

  // A running cursor, not an index times a pitch. LDraw is Y-down, so each
  // element consumes height by moving the cursor *negative*, and every layer
  // starts exactly where the last one ended. Computing storey N's origin from a
  // fixed pitch is what put the contrast band and the deck above it in the same
  // 24 LDU and got the whole building refused for collisions.
  // Two layers, cross-bonded. A single-layer deck is held only where the walls
  // stand on it, so whether its middle stays attached depends on whether the
  // available plate lengths happen to reach the perimeter — which is not a
  // property a building should be left to luck on.
  const deckLayers = integer(args.deckLayers, 2, 1, 2, 'deckLayers')
  const DECK_LDU = deckLayers * 8
  const BAND_LDU = 24
  let cursor = origin[1]
  const storeyLdu = coursesPerStorey * 24 + DECK_LDU + (bandColor !== null ? BAND_LDU : 0)
  try {
    for (let storey = 0; storey < storeys; storey += 1) {
      const openings = facadeOpenings(width, coursesPerStorey, windowsPerSide, windowWidth, storey === 0 && wantDoor)
      windows += openings.filter((opening) => opening.element === 'window').length
      doors += openings.filter((opening) => opening.element === 'door').length
      if (storey === 0 && wantDoor && !openings.some((opening) => opening.element === 'door')) {
        notes.push(`No door frame ${4} studs wide fits a ${coursesPerStorey}-course storey in this build, so the entrance is an open doorway with a lintel above it.`)
      }
      absorb(planEnclosure({
        ...base,
        origin: [origin[0], cursor, origin[2]],
        widthStuds: width,
        footprintDepthStuds: depth,
        courses: coursesPerStorey,
        floor: true,
        floorLayers: deckLayers,
        openings,
      }))
      cursor -= DECK_LDU + coursesPerStorey * 24

      // A band of contrast where the storeys meet is what stops a tall building
      // reading as one extruded box.
      if (bandColor !== null) {
        absorb(planEnclosure({
          ...base,
          color: bandColor,
          origin: [origin[0], cursor, origin[2]],
          widthStuds: width,
          footprintDepthStuds: depth,
          courses: 1,
          floor: false,
        }))
        cursor -= BAND_LDU
      }
    }

    // A roof deck and a parapet, instead of leaving an open box.
    absorb(planEnclosure({
      ...base,
      color: bandColor ?? color,
      origin: [origin[0], cursor, origin[2]],
      widthStuds: width,
      footprintDepthStuds: depth,
      courses: 1,
      floor: true,
      floorLayers: 2,
      family: 'brick',
    }))
  } catch (cause) {
    if (cause instanceof AssemblyError) {
      throw new SharedCapabilityError(
        cause.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_OPERATION',
        cause.message,
        cause.repair,
      )
    }
    throw cause
  }

  if (operations.length > MAX_GENERATED_PARTS) {
    throw new SharedCapabilityError(
      'RESOURCE_LIMIT',
      `That building would place ${operations.length} parts.`,
      `Raise it in sections; the ceiling is ${MAX_GENERATED_PARTS} parts per command.`,
    )
  }

  notes.push(`${storeys} storey(s) of ${coursesPerStorey} courses, each on its own deck, capped with a parapet.`)
  if (bandColor !== null) notes.push('A contrasting band separates the storeys.')

  const seated = finishAssemblyOperations(context, operations, anchor)
  return {
    capability: 'build_structure',
    label: `Raise a ${width} × ${depth} building, ${storeys} storey${storeys === 1 ? '' : 's'}`,
    operations: seated,
    nextSelection: seated
      .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
      .map((operation) => operation.part.id),
    summary:
      `${seated.length} parts across ${storeys} storey${storeys === 1 ? '' : 's'}, `
      + `${windows} window${windows === 1 ? '' : 's'}${doors ? ` and ${doors} door${doors === 1 ? '' : 's'}` : ''} seated, `
      + `${unbonded === 0 ? 'every course staggered' : `${unbonded} course(s) not fully staggered`}.`,
    report: {
      parts: seated.length,
      storeys,
      coursesPerStorey,
      storeyPitchLdu: storeyLdu,
      deckLayers,
      windows,
      doors,
      runningBond: unbonded === 0,
      unbondedCourses: unbonded,
      bill: [...bill.values()].sort((a, b) => b.count - a.count || a.definitionId.localeCompare(b.definitionId)),
      notes,
      warnings,
      origin,
      ...(anchor ? { anchorPartId: anchor.id } : {}),
    },
  }
}

/**
 * Evenly spaced window openings across a facade, with a door at the middle of
 * the ground floor when one is wanted.
 *
 * Windows sit one course off the deck so they read as windows rather than as
 * holes at floor level, and the door is placed first so a window is never cut
 * through it.
 */
function facadeOpenings(
  width: number,
  courses: number,
  windowsPerSide: number,
  windowWidth: number,
  withDoor: boolean,
): Opening[] {
  const openings: Opening[] = []
  const doorWidth = 4
  const doorAt = Math.max(0, Math.floor((width - doorWidth) / 2))
  if (withDoor && width >= doorWidth + 4 && courses >= 3) {
    // A door frame that does not fit the storey is not a door frame. Where the
    // compiled pack has no frame short enough, the opening is cut one course
    // shy of the top so the wall above it is a lintel rather than a bare gap,
    // and the plan says a frame could not be seated.
    const frame = chooseElement('door', doorWidth, courses)
    openings.push(
      frame
        ? { atStud: doorAt, widthStuds: doorWidth, fromCourse: 0, toCourse: courses - 1, element: 'door' }
        : { atStud: doorAt, widthStuds: doorWidth, fromCourse: 0, toCourse: Math.max(0, courses - 2) },
    )
  }
  if (windowsPerSide > 0 && courses >= 3) {
    const slot = width / (windowsPerSide + 1)
    for (let index = 1; index <= windowsPerSide; index += 1) {
      const at = Math.round(index * slot - windowWidth / 2)
      if (at < 1 || at + windowWidth > width - 1) continue
      // Never cut a window through the doorway.
      if (withDoor && at < doorAt + doorWidth && at + windowWidth > doorAt) continue
      openings.push({ atStud: at, widthStuds: windowWidth, fromCourse: 1, toCourse: Math.min(courses - 1, 3), element: 'window' })
    }
  }
  return openings
}

/**
 * Turns one advanced command into stable CadOperations.
 *
 * The planner is pure apart from cryptographically strong id allocation. It
 * never mutates the engine; callers may commit immediately or preflight the
 * returned operations, and the kernel remains the final authority.
 */
export function planSharedMutation(
  capability: SharedMutationId,
  rawArgs: Record<string, unknown> | undefined,
  context: SharedMutationContext,
): SharedMutationPlan {
  const args = rawArgs ?? {}

  switch (capability) {
    case 'duplicate_selection': {
      const partIds = scopedPartIds(context, args)
      const offset = copyOffset(context, args, partIds)
      const operations = partIds.map((partId): CadOperation => {
        const source = context.document.parts[partId]
        return {
          type: 'part.add',
          part: {
            ...structuredClone(source),
            id: createId(`${context.actor}_copy`),
            transform: {
              ...source.transform,
              position: [
                source.transform.position[0] + offset[0],
                source.transform.position[1] + offset[1],
                source.transform.position[2] + offset[2],
              ],
            },
            protected: false,
          },
        }
      })
      const nextSelection = operations.map((operation) => operation.type === 'part.add' ? operation.part.id : '')
      refuseIllegalAdds(context.document, operations)
      return { capability, label: `Duplicate ${partIds.length} part${partIds.length === 1 ? '' : 's'}`, operations, nextSelection, summary: `${partIds.length} exact cop${partIds.length === 1 ? 'y' : 'ies'} at [${offset.join(', ')}] LDU.` }
    }

    case 'mirror_selection': {
      const partIds = scopedPartIds(context, args)
      const axisName = args.axis === 'y' ? 'y' : args.axis === 'z' ? 'z' : 'x'
      const mirrorAxis: MirrorAxis = axisName === 'x' ? 0 : axisName === 'y' ? 1 : 2
      const about = args.about === 'selection' ? 'selection' : 'world'
      let plane = finite(args.axisLdu, 0, 'axisLdu')
      if (about === 'selection') {
        const extent = boundsOfMany(partIds.map((id) => getPartBounds(context.document.parts[id])))
        plane = mirrorPlaneFor(extent, mirrorAxis)
      }
      // Every emitted basis keeps a positive determinant, so a mirror can only
      // ever produce placements of parts that are actually manufactured. Where a
      // part's connectors are not symmetric about the plane, that pose is a real
      // placement but not a faithful reflection — it wants the opposite-hand
      // part, which this build has no table to name. Reported, never silently
      // swapped and never blocking: the count is preserved and the operator is
      // told exactly which parts need a hand change.
      const unfaithful = partIds.filter((partId) => !canMirror(context.document, partId, mirrorAxis))
      return {
        capability,
        label: `Mirror ${partIds.length} part${partIds.length === 1 ? '' : 's'}`,
        operations: partIds.map((partId) => ({ type: 'part.transform', partId, transform: mirrorTransform(context.document.parts[partId].transform, mirrorAxis, plane) })),
        nextSelection: partIds,
        summary:
          `${partIds.length} part${partIds.length === 1 ? '' : 's'} reflected across ${axisName}=${plane} LDU.`
          + (unfaithful.length
            ? ` ${unfaithful.length} of them ${unfaithful.length === 1 ? 'is' : 'are'} not symmetric about that plane, so ${unfaithful.length === 1 ? 'its pose is' : 'their poses are'} buildable but not a true mirror of the original shape: ${unfaithful.slice(0, 4).join(', ')}${unfaithful.length > 4 ? ', …' : ''}.`
            : ''),
      }
    }

    case 'linear_array': {
      const partIds = scopedPartIds(context, args)
      const copies = integer(args.copies, 2, 1, MAX_ARRAY_COPIES, 'copies')
      if (partIds.length * copies > MAX_PART_SCOPE) {
        throw new SharedCapabilityError('RESOURCE_LIMIT', `The array would create ${partIds.length * copies} parts.`, `Reduce the selection or copies so the command creates at most ${MAX_PART_SCOPE} parts.`)
      }
      const offset = copyOffset(context, args, partIds)
      const operations: CadOperation[] = []
      const nextSelection: string[] = []
      for (let copy = 1; copy <= copies; copy += 1) {
        for (const partId of partIds) {
          const source = context.document.parts[partId]
          const id = createId(`${context.actor}_array`)
          nextSelection.push(id)
          operations.push({
            type: 'part.add',
            part: {
              ...structuredClone(source),
              id,
              transform: {
                ...source.transform,
                position: [
                  source.transform.position[0] + offset[0] * copy,
                  source.transform.position[1] + offset[1] * copy,
                  source.transform.position[2] + offset[2] * copy,
                ],
              },
              protected: false,
            },
          })
        }
      }
      refuseIllegalAdds(context.document, operations)
      return { capability, label: `Array ${partIds.length} part${partIds.length === 1 ? '' : 's'} × ${copies}`, operations, nextSelection, summary: `${copies} repeated cop${copies === 1 ? 'y' : 'ies'} along [${offset.join(', ')}] LDU.` }
    }

    // Sol-1 mechanism dispatch seam.
    case 'build_crane':
    case 'build_lattice':
    case 'build_snot_hull':
    case 'build_clock_faces':
      return planMechanismAssembly(capability, args, context)

    case 'generate_from_brief':
    case 'generate_region': {
      if (!generationPlanner) {
        throw new SharedCapabilityError(
          'INVALID_OPERATION',
          'The generation pipeline is not loaded in this context.',
          'Call the generation_compile or generation_run tool first — either one loads it — then retry this capability.',
        )
      }
      return generationPlanner(capability, args, context)
    }

    case 'build_wall':
    case 'build_enclosure':
    case 'build_field':
    case 'build_hinged_flap': {
      return planGeneratedAssembly(capability, args, context)
    }

    case 'capture_module': {
      const partIds = scopedPartIds(context, args)
      const name = text(args.name, 'Module name', 80)
      const existing = findModule(context.document, name)
      const module = captureModule(context.document, partIds, name, context.actor, existing?.id ?? createId('module'))
      return {
        capability,
        label: `Capture module “${name}”`,
        operations: [{ type: 'module.define', module }],
        summary: `${describeModule(module)}. ${existing ? 'Replaces the module of the same name.' : 'Stamp it anywhere with stamp_module.'}`,
        report: { moduleId: module.id, name, parts: module.parts.length, sizeLdu: module.sizeLdu, replaced: Boolean(existing) },
      }
    }

    case 'remove_module': {
      const module = requireModule(context, args)
      return {
        capability,
        label: `Remove module “${module.name}”`,
        operations: [{ type: 'module.remove', moduleId: module.id }],
        summary: 'Parts already stamped from it are untouched.',
        report: { moduleId: module.id, name: module.name },
      }
    }

    case 'stamp_module': {
      const module = requireModule(context, args)
      const copies = integer(args.copies, 1, 1, 64, 'copies')
      const anchorPartId = typeof args.anchorPartId === 'string' && args.anchorPartId ? args.anchorPartId : ''
      const anchor = anchorPartId ? context.document.parts[anchorPartId] : undefined
      if (anchorPartId && !anchor) {
        throw new SharedCapabilityError(
          'PART_NOT_FOUND',
          `Part ${anchorPartId} is not present at revision ${context.document.revision}.`,
          'Pass an id from scene_query. Do not invent a part id or XYZ.',
        )
      }
      const atLdu = anchor ? stampOriginOnAnchor(anchor) : vector(args.atLdu, [0, 0, 0], 'atLdu')
      let result
      try {
        result = stampModule(
          module,
          {
            atLdu,
            quarterTurns: integer(args.quarterTurns, 0, -64, 64, 'quarterTurns'),
            copies,
            spacingLdu: args.spacingLdu === undefined ? undefined : vector(args.spacingLdu, [0, 0, 0], 'spacingLdu'),
            color: args.color === undefined ? undefined : integer(args.color, 71, 0, 999999, 'color'),
          },
          {
            subassemblyId: defaultSubassembly(context),
            stepId: context.document.steps.at(-1)?.id ?? 'step_1',
            actor: context.actor,
            nextId: () => createId(`${context.actor}_stamp`),
          },
        )
      } catch (cause) {
        if (cause instanceof ModuleError) {
          throw new SharedCapabilityError(cause.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_OPERATION', cause.message, cause.repair)
        }
        throw cause
      }
      const seated = anchor ? seatStampOnAnchor(context.document, result.parts, anchor) : result.parts
      const operations = seated.map((part): CadOperation => ({ type: 'part.add', part }))
      refuseIllegalAdds(context.document, operations)
      return {
        capability,
        label: `Stamp ${copies} × “${module.name}”`,
        operations,
        nextSelection: seated.map((part) => part.id),
        summary: `${seated.length} parts placed from a ${describeModule(module)} module.`,
        report: { moduleId: module.id, name: module.name, copies, parts: seated.length, footprintLdu: result.footprintLdu, atLdu, ...(anchor ? { anchorPartId: anchor.id } : {}) },
      }
    }

    case 'build_structure': {
      return planStructure(args, context)
    }

    case 'stack_selection': {
      const partIds = scopedPartIds(context, args)
      const copies = integer(args.copies, 1, 1, 32, 'copies')
      const gap = finite(args.gapLdu, 0, 'gapLdu')
      // The pitch is the distance from the lowest underside to the highest
      // *mating plane*, not to the top of the bounding box: studs protrude
      // above the plane the next storey rests on, and counting them adds a
      // phantom plate of height that leaves the stack floating.
      let lowestUnderside = -Infinity
      let highestStudPlane = Infinity
      for (const id of partIds) {
        const part = context.document.parts[id]
        const definition = catalog.get(part.definitionId)
        if (!definition?.dimensions) continue
        lowestUnderside = Math.max(lowestUnderside, part.transform.position[1] + underPlaneLdu(definition))
        const studs = studPlaneLdu(definition)
        if (studs !== null) highestStudPlane = Math.min(highestStudPlane, part.transform.position[1] + studs)
      }
      const measured = Number.isFinite(lowestUnderside) && Number.isFinite(highestStudPlane)
        ? lowestUnderside - highestStudPlane
        : Number.NaN
      if (!Number.isFinite(measured) || measured <= 0) {
        throw new SharedCapabilityError(
          'INVALID_OPERATION',
          'The selection exposes no studs to stack onto, so its height cannot be measured.',
          'Select a storey whose top course has studs, or use linear_array with an explicit offset.',
        )
      }
      const pitch = Math.round((measured + gap) / PLATE_LDU) * PLATE_LDU
      const operations: CadOperation[] = []
      const created: string[] = []
      for (let copy = 1; copy <= copies; copy += 1) {
        for (const partId of partIds) {
          const source = context.document.parts[partId]
          const part = {
            ...structuredClone(source),
            id: createId(`${context.actor}_storey`),
            transform: {
              ...source.transform,
              position: [
                source.transform.position[0],
                source.transform.position[1] - pitch * copy,
                source.transform.position[2],
              ] as Vec3,
            },
            provenance: context.actor,
          }
          created.push(part.id)
          operations.push({ type: 'part.add', part })
        }
      }
      if (operations.length > MAX_GENERATED_PARTS) {
        throw new SharedCapabilityError(
          'RESOURCE_LIMIT',
          `Stacking ${copies} copies of ${partIds.length} parts would place ${operations.length} parts.`,
          `Stack fewer copies; the ceiling is ${MAX_GENERATED_PARTS} parts per command.`,
        )
      }
      refuseIllegalAdds(context.document, operations)
      return {
        capability,
        label: `Stack ${copies} storey${copies === 1 ? '' : 's'}`,
        operations,
        nextSelection: created,
        summary: `${operations.length} parts placed in ${copies} storey${copies === 1 ? '' : 's'}, each ${pitch} LDU above the last.`,
        report: { copies, pitchLdu: pitch, measuredHeightLdu: measured, partsPerStorey: partIds.length, parts: operations.length },
      }
    }

    case 'connect_parts': {
      const fallback = scopedPartIds(context, args, false)
      const movingPartId = String(args.movingPartId ?? fallback[0] ?? '')
      const targetPartId = String(args.targetPartId ?? fallback[1] ?? '')
      const moving = context.document.parts[movingPartId]
      const target = context.document.parts[targetPartId]
      if (!moving || !target || moving.id === target.id) {
        throw new SharedCapabilityError('PART_NOT_FOUND', 'Connect parts needs two different current part ids.', 'Pass movingPartId and targetPartId from the current scene.')
      }
      const mate = searchMateBetween(moving, target, context.document)
      if (!mate.transform) {
        const details = connectFailureDetails(context.document, moving.id, target.id)
        if (mate.blockedByCollision) {
          throw new SharedCapabilityError(
            'COLLISION',
            `Every legal mate of ${moving.id} onto ${target.id} would collide with another part.`,
            connectRepair('COLLISION', details),
            details,
          )
        }
        if (mate.occupancy === 'occupied') {
          throw new SharedCapabilityError(
            'CONNECTOR_OCCUPIED',
            `Every exclusive connector on ${target.id} that could receive ${moving.id} is occupied.`,
            connectRepair('CONNECTOR_OCCUPIED', details),
            details,
          )
        }
        throw new SharedCapabilityError(
          'NO_COMPATIBLE_CONNECTOR',
          `No legal connector mate was found between ${moving.id} and ${target.id}.`,
          connectRepair('NO_COMPATIBLE_CONNECTOR', details),
          details,
        )
      }
      return {
        capability,
        label: `Connect ${moving.definitionId} to ${target.definitionId}`,
        operations: [{ type: 'part.transform', partId: moving.id, transform: mate.transform }],
        nextSelection: [moving.id],
        summary: `Solved a full connector-frame pose for ${moving.id} → ${target.id}.`,
      }
    }

    case 'articulate_joint': {
      const partIds = scopedPartIds(context, args)
      const edgeId = String(args.edgeId ?? '')
      const joint = findArticulatedJoints(context.document, partIds).find((entry) => entry.edgeId === edgeId)
      if (!joint) {
        throw new SharedCapabilityError('INVALID_OPERATION', `No drivable joint ${edgeId || '(missing id)'} exists for this scope.`, 'List current joints, then use one of their edge ids.')
      }
      const request = {
        rotateDegrees: args.rotateDegrees === undefined ? undefined : finite(args.rotateDegrees, 0, 'rotateDegrees'),
        slideLdu: args.slideLdu === undefined ? undefined : finite(args.slideLdu, 0, 'slideLdu'),
      }
      const operations = articulate(context.document, joint, request)
      if (!operations.length) {
        throw new SharedCapabilityError('INVALID_OPERATION', 'The requested amount is outside what this joint permits.', 'Inspect the joint freedom and request a permitted movement.', { freedom: joint.joint })
      }
      return { capability, label: `Articulate ${joint.family}`, operations, nextSelection: joint.movingPartIds, summary: `${joint.label}; moved ${joint.movingPartIds.length} rigidly attached parts.` }
    }

    case 'create_subassembly': {
      const name = text(args.name, 'Subassembly name', 80)
      const partIds = scopedPartIds(context, args, false)
      const accentCandidate = String(args.accent ?? '#e79032')
      const accent = /^#[0-9a-f]{6}$/i.test(accentCandidate) ? accentCandidate : '#e79032'
      const id = createId('subassembly')
      const operations: CadOperation[] = [
        { type: 'subassembly.add', subassembly: { id, name, partIds: [], locked: false, accent } },
        ...partIds.map((partId): CadOperation => ({ type: 'part.assign-subassembly', partId, subassemblyId: id })),
      ]
      return { capability, label: `Create subassembly “${name}”`, operations, nextSelection: partIds, summary: partIds.length ? `Created ${name} with ${partIds.length} selected parts.` : `Created empty subassembly ${name}.` }
    }

    case 'assign_subassembly': {
      const partIds = scopedPartIds(context, args)
      const subassemblyId = String(args.subassemblyId ?? '')
      const subassembly = context.document.subassemblies[subassemblyId]
      if (!subassembly) {
        throw new SharedCapabilityError('INVALID_OPERATION', `Subassembly ${subassemblyId || '(missing id)'} does not exist.`, 'Choose a current subassembly id.')
      }
      return { capability, label: `Assign selection to ${subassembly.name}`, operations: partIds.map((partId) => ({ type: 'part.assign-subassembly', partId, subassemblyId })), nextSelection: partIds, summary: `Assigned ${partIds.length} part${partIds.length === 1 ? '' : 's'} to ${subassembly.name}.` }
    }

    case 'rename_subassembly': {
      const subassemblyId = String(args.subassemblyId ?? '')
      const name = text(args.name, 'Subassembly name', 80)
      if (!context.document.subassemblies[subassemblyId]) {
        throw new SharedCapabilityError('INVALID_OPERATION', `Subassembly ${subassemblyId || '(missing id)'} does not exist.`, 'Choose a current subassembly id.')
      }
      return { capability, label: `Rename subassembly to “${name}”`, operations: [{ type: 'subassembly.rename', subassemblyId, name }], summary: `Subassembly ${subassemblyId} becomes ${name}.` }
    }

    case 'lock_subassembly': {
      const subassemblyId = String(args.subassemblyId ?? '')
      const subassembly = context.document.subassemblies[subassemblyId]
      if (!subassembly) {
        throw new SharedCapabilityError('INVALID_OPERATION', `Subassembly ${subassemblyId || '(missing id)'} does not exist.`, 'Choose a current subassembly id.')
      }
      const locked = args.locked === undefined ? !subassembly.locked : Boolean(args.locked)
      return { capability, label: `${locked ? 'Lock' : 'Unlock'} ${subassembly.name}`, operations: [{ type: 'subassembly.lock', subassemblyId, locked }], summary: `${subassembly.name} will be ${locked ? 'protected from agent mutation' : 'open for collaboration'}.` }
    }

    case 'add_builder_note': {
      const partIds = scopedPartIds(context, args)
      const noteText = text(args.text, 'Builder note', 800)
      return {
        capability,
        label: 'Add spatial builder note',
        operations: [{
          type: 'note.add',
          note: {
            id: createId('note'),
            anchorPartIds: partIds,
            text: noteText,
            status: 'open',
            author: context.actor,
            revisionCreated: context.document.revision,
          },
        }],
        nextSelection: partIds,
        summary: `Anchored a note to ${partIds.length} part${partIds.length === 1 ? '' : 's'}.`,
      }
    }

    case 'respond_to_note': {
      const noteId = String(args.noteId ?? '')
      if (!context.document.notes.some((note) => note.id === noteId)) {
        throw new SharedCapabilityError('INVALID_OPERATION', `Builder note ${noteId || '(missing id)'} does not exist.`, 'Use a current note id.')
      }
      const response = text(args.response, 'Note response', 1200)
      return { capability, label: 'Respond to builder note', operations: [{ type: 'note.respond', noteId, response, resolved: Boolean(args.resolved) }], summary: `${Boolean(args.resolved) ? 'Resolved' : 'Replied to'} note ${noteId}.` }
    }

    case 'set_dimension_limit': {
      const current = context.document.constraints.find((constraint) => constraint.kind === 'dimensions')
      const currentValue = current?.value as { width?: number; depth?: number; height?: number } | undefined
      const width = positive(args.widthStuds, currentValue?.width ?? 32, 'widthStuds')
      const depth = positive(args.depthStuds, currentValue?.depth ?? 32, 'depthStuds')
      const height = args.heightStuds === undefined ? currentValue?.height : positive(args.heightStuds, 1, 'heightStuds')
      const constraint = {
        id: String(args.constraintId ?? current?.id ?? createId('constraint_dimensions')),
        kind: 'dimensions' as const,
        label: args.label === undefined ? (current?.label ?? 'Maximum dimensions') : text(args.label, 'Constraint label', 120),
        value: { width, depth, ...(height === undefined ? {} : { height }) },
        hard: args.hard === undefined ? (current?.hard ?? true) : Boolean(args.hard),
      }
      return { capability, label: 'Set size envelope', operations: [{ type: 'constraint.set', constraint }], summary: `${width} × ${depth}${height ? ` × ${height}` : ''} studs; ${constraint.hard ? 'hard' : 'advisory'}.` }
    }

    case 'set_piece_budget': {
      const current = context.document.constraints.find((constraint) => constraint.kind === 'piece-count')
      const maxParts = integer(args.maxParts, Number(current?.value) || 500, 1, 100_000, 'maxParts')
      const constraint = {
        id: String(args.constraintId ?? current?.id ?? createId('constraint_pieces')),
        kind: 'piece-count' as const,
        label: args.label === undefined ? (current?.label ?? 'Piece budget') : text(args.label, 'Constraint label', 120),
        value: maxParts,
        hard: args.hard === undefined ? (current?.hard ?? true) : Boolean(args.hard),
      }
      return { capability, label: 'Set piece budget', operations: [{ type: 'constraint.set', constraint }], summary: `${maxParts} parts maximum; ${constraint.hard ? 'hard' : 'advisory'}.` }
    }

    case 'set_palette': {
      const current = context.document.constraints.find((constraint) => constraint.kind === 'palette')
      const raw = args.colors ?? current?.value
      const colors = [...new Set(Array.isArray(raw) ? raw.map(Number) : [])]
      if (!colors.length || colors.length > 64 || colors.some((color) => !Number.isInteger(color))) {
        throw new SharedCapabilityError('INVALID_OPERATION', 'colors must contain 1–64 integer LDraw colour codes.', 'Choose colours from the project palette or workspace colour table.')
      }
      const constraint = {
        id: String(args.constraintId ?? current?.id ?? createId('constraint_palette')),
        kind: 'palette' as const,
        label: args.label === undefined ? (current?.label ?? 'Allowed palette') : text(args.label, 'Constraint label', 120),
        value: colors,
        hard: args.hard === undefined ? (current?.hard ?? true) : Boolean(args.hard),
      }
      return { capability, label: 'Set allowed palette', operations: [{ type: 'constraint.set', constraint }], summary: `${colors.length} allowed colour${colors.length === 1 ? '' : 's'}; ${constraint.hard ? 'hard' : 'advisory'}.` }
    }

    case 'remove_constraint': {
      const constraintId = String(args.constraintId ?? '')
      const constraint = context.document.constraints.find((candidate) => candidate.id === constraintId)
      if (!constraint) {
        throw new SharedCapabilityError('INVALID_OPERATION', `Constraint ${constraintId || '(missing id)'} does not exist.`, 'Choose a current constraint id.')
      }
      return { capability, label: `Remove constraint “${constraint.label}”`, operations: [{ type: 'constraint.remove', constraintId }], summary: `${constraint.label} will no longer govern future edits.` }
    }

    case 'apply_build_order': {
      const maxPartsPerStep = args.maxPartsPerStep === undefined ? undefined : integer(args.maxPartsPerStep, 6, 1, 100, 'maxPartsPerStep')
      // `checkInsertability` is off by default because the generation pipeline
      // runs `computeBuildOrder` once per candidate and cannot afford it. This
      // is the other kind of caller: a person asked for a build order and is
      // about to follow it, so the graph answer alone — every part touches
      // something placed earlier — is not the question they asked. It costs a
      // few hundred milliseconds once, on an explicit command.
      const result = computeBuildOrder(context.document, { maxPartsPerStep, checkInsertability: true })
      if (!result.steps.length) {
        throw new SharedCapabilityError('INVALID_OPERATION', 'The model has no parts to sequence.', 'Place parts before generating a build order.')
      }
      const blocked = result.warnings.filter((warning) => warning.code === 'BLOCKED_INSERTION')
      return {
        capability,
        label: 'Generate build order',
        operations: [{ type: 'steps.replace', steps: result.steps }],
        summary:
          `${result.steps.length} verified steps; ${result.unsupportedPartIds.length} independently started island${result.unsupportedPartIds.length === 1 ? '' : 's'}`
          + `${blocked.length ? `; ${blocked.length} step${blocked.length === 1 ? '' : 's'} place a part with no clear approach` : ''}.`,
        // The warnings are the reason the check was paid for. Computing them
        // and returning only a count would leave the caller knowing something
        // is wrong and not which part, which is worse than not checking.
        report: {
          steps: result.steps.length,
          unsupportedPartIds: result.unsupportedPartIds,
          blockedInsertions: blocked.length,
          warnings: result.warnings,
        },
      }
    }

    case 'rename_document': {
      const name = text(args.name, 'Project name', 120)
      return { capability, label: `Rename project to “${name}”`, operations: [{ type: 'document.rename', name }], summary: `The document name becomes ${name}.` }
    }
  }
}

// === AGENT-ML-OWNED (Opus) ===
/**
 * The generation planner, injected rather than imported.
 *
 * `generate_from_brief` and `generate_region` plan by running the generation
 * pipeline, which is a large chunk — massing strategies, the snap realiser, the
 * 26-axis scorer and a silhouette rasteriser. This file is reached statically
 * from the WebMCP adapter and from the agent's tool host, both of which are
 * paid for on first paint, and neither of which should carry the pipeline for a
 * conversation that only reads the scene. So the pipeline registers itself when
 * its own chunk loads, and until then these two capabilities are discoverable
 * through `capability_search` but say plainly that they are not loaded.
 *
 * The alternative — importing `src/generation/phases.ts` here — would put the
 * pipeline in the first chunk without any test noticing, because the lazy-chunk
 * test in `src/webmcp/imports.test.ts` reads static imports with a regex that
 * does not match this file's multi-line import of it.
 */
export type GenerationCapabilityPlanner = (
  capability: 'generate_from_brief' | 'generate_region',
  args: Record<string, unknown>,
  context: SharedMutationContext,
) => SharedMutationPlan

let generationPlanner: GenerationCapabilityPlanner | null = null

export function registerGenerationPlanner(planner: GenerationCapabilityPlanner): void {
  generationPlanner = planner
}

/** Whether the generation chunk has registered itself in this context. */
export const generationPlannerLoaded = (): boolean => generationPlanner !== null

// ---- Sol-1 mechanism planner adapter --------------------------------------
function planMechanismAssembly(
  capability: 'build_crane' | 'build_lattice' | 'build_snot_hull' | 'build_clock_faces',
  args: Record<string, unknown>, context: SharedMutationContext,
): SharedMutationPlan {
  const { origin, anchor } = assemblyPlacement(context, args)
  const base = {
    originLdu: origin, color: integer(args.color, 71, 0, 999999, 'color'), actor: context.actor,
    subassemblyId: Object.values(context.document.subassemblies).find(item => !item.locked)?.id ?? 'main',
    stepId: context.document.steps.at(-1)?.id ?? 'step_1',
  }
  const required = (name: string): number => {
    if (typeof args[name] !== 'number' || !Number.isFinite(args[name])) {
      throw new SharedCapabilityError('INVALID_OPERATION', `${name} is required and must be a finite number.`, 'Follow the capability schema.')
    }
    return args[name] as number
  }
  try {
    let plan: AssemblyPlan
    switch (capability) {
      case 'build_crane': plan = planCrane({ ...base, boomStuds: required('boomStuds') }); break
      case 'build_lattice': plan = planLattice({ ...base, widthStuds: required('widthStuds'), depthStuds: required('depthStuds'), heightCourses: required('heightCourses'), bayStuds: required('bayStuds') }); break
      case 'build_snot_hull': plan = planSnotHull({ ...base, widthStuds: required('widthStuds'), depthStuds: required('depthStuds'), layers: required('layers') }); break
      case 'build_clock_faces': plan = planClockFaces({ ...base, diameterStuds: required('diameterStuds') }); break
    }
    const operations = finishAssemblyOperations(context, plan.operations, anchor)
    return { capability, label: sharedCapability(capability)!.title, operations, nextSelection: plan.partIds,
      summary: `${plan.partCount} parts. ${plan.notes.at(-1) ?? ''}`,
      report: { parts: plan.partCount, bill: plan.bill, notes: plan.notes, warnings: plan.warnings, origin },
    }
  } catch (error) {
    if (error instanceof MechanismGeometryError) throw new SharedCapabilityError(error.code, error.message, error.repair, { definitionId: error.definitionId })
    if (error instanceof AssemblyError) throw new SharedCapabilityError(error.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'INVALID_OPERATION', error.message, error.repair)
    throw error
  }
}
