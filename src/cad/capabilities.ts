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
import { getPartBounds } from './geometry'
import { createId } from './ids'
import { computeBuildOrder } from './instructions'
import { bestSnapTransform } from './snapping'
import type { Actor, CadOperation, ModelDocument, Transform, Vec3 } from './types'

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
  { id: 'duplicate_selection', kind: 'mutate', group: 'transform', title: 'Duplicate precisely', summary: 'Copy parts by an exact LDraw-unit offset.', input: { partIds: 'string[], optional', offsetLdu: '[x,y,z], default [20,0,0]' } },
  { id: 'mirror_selection', kind: 'mutate', group: 'transform', title: 'Mirror across X', summary: 'Reflect selected transforms across an exact X plane.', input: { partIds: 'string[], optional', axisLdu: 'number, default 0' } },
  { id: 'linear_array', kind: 'mutate', group: 'transform', title: 'Linear array', summary: 'Create deterministic repeated copies along an exact vector.', input: { partIds: 'string[], optional', copies: 'integer 1-24', offsetLdu: '[x,y,z]' } },
  { id: 'build_wall', kind: 'mutate', group: 'assemble', title: 'Lay a wall', summary: 'Generate a bonded brick wall in one transaction, with staggered courses and optional openings.', input: { lengthStuds: 'integer 1-256', courses: 'integer 1-64', axis: '"x" | "z", default "x"', color: 'LDraw colour, optional', family: '"brick" | "plate" | "tile", default "brick"', depthStuds: '1 or 2, default 1', originLdu: '[x,y,z], optional', openings: '[{ atStud, widthStuds, fromCourse, toCourse }], optional' } },
  { id: 'build_enclosure', kind: 'mutate', group: 'assemble', title: 'Lay a storey', summary: 'Generate four interlocking walls and an optional floor: one storey of a building, in one transaction.', input: { widthStuds: 'integer', depthStuds: 'integer', courses: 'integer 1-64', color: 'LDraw colour, optional', family: '"brick" | "plate", default "brick"', wallDepthStuds: '1 or 2, default 1', floor: 'boolean, default false', floorLayers: '1 or 2, default 2 (2 is cross-bonded and rigid)', originLdu: '[x,y,z], optional', openings: '[{ atStud, widthStuds, fromCourse, toCourse }], optional' } },
  { id: 'build_field', kind: 'mutate', group: 'assemble', title: 'Lay a floor', summary: 'Tile a rectangular footprint with staggered rows, optionally cross-bonded into a rigid slab.', input: { widthStuds: 'integer', depthStuds: 'integer', layers: '1 or 2, default 1', color: 'LDraw colour, optional', family: '"plate" | "tile" | "brick", default "plate"', originLdu: '[x,y,z], optional' } },
  { id: 'build_structure', kind: 'mutate', group: 'assemble', title: 'Raise a building', summary: 'Compose a whole multi-storey building in one transaction: deck, storeys with real windows, a ground-floor door, colour banding and a parapet.', input: { widthStuds: 'integer', depthStuds: 'integer', storeys: 'integer 1-24', coursesPerStorey: 'integer 2-12, default 4', color: 'LDraw colour', bandColor: 'LDraw colour, optional', windowsPerSide: 'integer 0-8, default 2', windowWidthStuds: '2 or 4, default 2', door: 'boolean, default true', trimColor: 'LDraw colour for window and door frames, default White', glassColor: 'LDraw colour for glazing, default Trans-Clear', deckLayers: '1 or 2, default 2 (2 is cross-bonded and rigid)', originLdu: '[x,y,z], optional' } },
  { id: 'build_hinged_flap', kind: 'mutate', group: 'assemble', title: 'Hinge a flap', summary: 'Build a flap that actually opens: a hinge line and a plate panel that the kernel can drive as a revolute joint.', input: { widthStuds: 'even integer ≥ 2', reachStuds: 'integer ≥ 1', color: 'LDraw colour, optional', originLdu: '[x,y,z], optional' } },
  { id: 'capture_module', kind: 'mutate', group: 'assemble', title: 'Capture a module', summary: 'Save the selection as a reusable named sub-build, rebased onto its own origin.', input: { name: 'string', partIds: 'string[], optional' } },
  { id: 'stamp_module', kind: 'mutate', group: 'assemble', title: 'Stamp a module', summary: 'Place copies of a captured module at an exact pose, with quarter-turn rotation and spacing.', input: { module: 'module id or name', atLdu: '[x,y,z]', quarterTurns: 'integer, optional', copies: 'integer 1-64, default 1', spacingLdu: '[x,y,z], optional', color: 'LDraw colour, optional' } },
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
    readonly code: 'INVALID_OPERATION' | 'PART_NOT_FOUND' | 'NO_COMPATIBLE_CONNECTOR' | 'RESOURCE_LIMIT',
    message: string,
    readonly repair: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SharedCapabilityError'
  }
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

/** Reflects a rigid transform through the document-space plane x = `axis`. */
export function mirrorTransformAcrossX(transform: Transform, axis: number): Transform {
  const basis = transform.basis
  return {
    position: [axis - (transform.position[0] - axis), transform.position[1], transform.position[2]],
    basis: [-basis[0], basis[1], basis[2], -basis[3], basis[4], basis[5], -basis[6], basis[7], basis[8]],
  }
}

/**
 * Where a generated assembly starts, when the caller does not say.
 *
 * Defaulting to the origin would drop a storey through whatever is already
 * built. Defaulting to the top of the selection is what a person means by
 * "now put a floor on that", and it is stud-aligned so the result mates.
 */
function assemblyOrigin(context: SharedMutationContext, args: Record<string, unknown>): Vec3 {
  if (args.originLdu !== undefined) return vector(args.originLdu, [0, 0, 0], 'originLdu')
  const scope = context.selection.filter((id) => context.document.parts[id])
  if (!scope.length) return [0, 0, 0]
  const bounds = scope.map((id) => getPartBounds(context.document.parts[id]))
  return [
    Math.round(Math.min(...bounds.map((item) => item.min[0])) / STUD_LDU) * STUD_LDU,
    Math.min(...bounds.map((item) => item.min[1])),
    Math.round(Math.min(...bounds.map((item) => item.min[2])) / STUD_LDU) * STUD_LDU,
  ]
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
  const origin = assemblyOrigin(context, args)
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
  return {
    capability,
    label,
    operations: plan.operations,
    nextSelection: plan.partIds,
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
  const origin = assemblyOrigin(context, args)

  const base = {
    color,
    trimColor: args.trimColor === undefined ? undefined : integer(args.trimColor, 15, 0, 999999, 'trimColor'),
    glassColor: args.glassColor === undefined ? undefined : integer(args.glassColor, 47, 0, 999999, 'glassColor'),
    subassemblyId: defaultSubassembly(context),
    stepId: context.document.steps.at(-1)?.id ?? 'step_1',
    actor: context.actor,
  }

  const operations: CadOperation[] = []
  const created: string[] = []
  const bill = new Map<string, { definitionId: string; name: string; count: number }>()
  const notes: string[] = []
  const warnings: string[] = []
  let unbonded = 0
  let windows = 0
  let doors = 0

  const absorb = (plan: AssemblyPlan) => {
    operations.push(...plan.operations)
    created.push(...plan.partIds)
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

  return {
    capability: 'build_structure',
    label: `Raise a ${width} × ${depth} building, ${storeys} storey${storeys === 1 ? '' : 's'}`,
    operations,
    nextSelection: created,
    summary:
      `${operations.length} parts across ${storeys} storey${storeys === 1 ? '' : 's'}, `
      + `${windows} window${windows === 1 ? '' : 's'}${doors ? ` and ${doors} door${doors === 1 ? '' : 's'}` : ''} seated, `
      + `${unbonded === 0 ? 'every course staggered' : `${unbonded} course(s) not fully staggered`}.`,
    report: {
      parts: operations.length,
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
      const offset = vector(args.offsetLdu, [STUD_LDU, 0, 0], 'offsetLdu')
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
      return { capability, label: `Duplicate ${partIds.length} part${partIds.length === 1 ? '' : 's'}`, operations, nextSelection, summary: `${partIds.length} exact cop${partIds.length === 1 ? 'y' : 'ies'} at [${offset.join(', ')}] LDU.` }
    }

    case 'mirror_selection': {
      const partIds = scopedPartIds(context, args)
      const axis = finite(args.axisLdu, 0, 'axisLdu')
      return {
        capability,
        label: `Mirror ${partIds.length} part${partIds.length === 1 ? '' : 's'}`,
        operations: partIds.map((partId) => ({ type: 'part.transform', partId, transform: mirrorTransformAcrossX(context.document.parts[partId].transform, axis) })),
        nextSelection: partIds,
        summary: `${partIds.length} part${partIds.length === 1 ? '' : 's'} reflected across x=${axis} LDU.`,
      }
    }

    case 'linear_array': {
      const partIds = scopedPartIds(context, args)
      const copies = integer(args.copies, 2, 1, MAX_ARRAY_COPIES, 'copies')
      if (partIds.length * copies > MAX_PART_SCOPE) {
        throw new SharedCapabilityError('RESOURCE_LIMIT', `The array would create ${partIds.length * copies} parts.`, `Reduce the selection or copies so the command creates at most ${MAX_PART_SCOPE} parts.`)
      }
      const offset = vector(args.offsetLdu, [STUD_LDU, 0, 0], 'offsetLdu')
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
      return { capability, label: `Array ${partIds.length} part${partIds.length === 1 ? '' : 's'} × ${copies}`, operations, nextSelection, summary: `${copies} repeated cop${copies === 1 ? 'y' : 'ies'} along [${offset.join(', ')}] LDU.` }
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
      const atLdu = vector(args.atLdu, [0, 0, 0], 'atLdu')
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
      return {
        capability,
        label: `Stamp ${copies} × “${module.name}”`,
        operations: result.parts.map((part) => ({ type: 'part.add', part })),
        nextSelection: result.parts.map((part) => part.id),
        summary: `${result.parts.length} parts placed from a ${describeModule(module)} module.`,
        report: { moduleId: module.id, name: module.name, copies, parts: result.parts.length, footprintLdu: result.footprintLdu },
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
      const bounds = getPartBounds(target)
      const coarse: Transform = {
        position: [target.transform.position[0], bounds.min[1], target.transform.position[2]],
        basis: moving.transform.basis,
      }
      const solved = bestSnapTransform(moving, context.document, coarse, { radiusLdu: STUD_LDU, targetPartIds: [target.id] })
      if (!solved) {
        throw new SharedCapabilityError('NO_COMPATIBLE_CONNECTOR', `No legal connector mate was found between ${moving.id} and ${target.id}.`, 'Inspect both part definitions and choose a compatible, unoccupied target connector.')
      }
      return {
        capability,
        label: `Connect ${moving.definitionId} to ${target.definitionId}`,
        operations: [{ type: 'part.transform', partId: moving.id, transform: solved }],
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
      const result = computeBuildOrder(context.document, { maxPartsPerStep })
      if (!result.steps.length) {
        throw new SharedCapabilityError('INVALID_OPERATION', 'The model has no parts to sequence.', 'Place parts before generating a build order.')
      }
      return { capability, label: 'Generate build order', operations: [{ type: 'steps.replace', steps: result.steps }], summary: `${result.steps.length} verified steps; ${result.unsupportedPartIds.length} independently started island${result.unsupportedPartIds.length === 1 ? '' : 's'}.` }
    }

    case 'rename_document': {
      const name = text(args.name, 'Project name', 120)
      return { capability, label: `Rename project to “${name}”`, operations: [{ type: 'document.rename', name }], summary: `The document name becomes ${name}.` }
    }
  }
}
