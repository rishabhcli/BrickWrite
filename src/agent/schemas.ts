import { MECHANISM_SCHEMAS } from '../cad/mechanismSchemas'
import { z } from 'zod'
import {
  SHARED_CAPABILITIES,
  type SharedCapability,
  type SharedCapabilityId,
  type SharedMutationId,
} from '../cad/capabilities'

/**
 * Runtime argument schemas for the shared capability vocabulary.
 *
 * `action_mutate` used to advertise `args: { type: 'object' }` and then hand the
 * raw bag to `planSharedMutation`, which coerced it with its own ad-hoc helpers.
 * That is exactly the drift the WebMCP contract was written to avoid: the shape
 * the agent was told about and the shape the kernel accepted were two different
 * declarations, and only one of them was ever checked.
 *
 * Every mutating capability now has one Zod declaration here. The tool surface
 * advertises `toJSONSchema` of it, the gateway parses with it, and the parity
 * test in `schemas.test.ts` fails the build if a capability is added to
 * `SHARED_CAPABILITIES` without one — or if the prose contract in that file and
 * the enforced schema stop agreeing about what is required.
 *
 * Schemas are strict. An unknown key is a mistake worth reporting rather than
 * silently dropping: a model that sends `widthStud` learns it misspelled the
 * field instead of quietly building a 12×12 default.
 */

const partId = z.string().min(1).max(80)
const partIds = z.array(partId).max(500).describe('Concrete part ids from the current revision.')

const vec3 = z
  .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
  .describe('LDraw units [x, y, z]. LDraw is Y-down: a part stacked on top has a smaller y.')

const colorCode = z.number().int().min(0).max(999_999).describe('LDraw colour code.')

const opening = z.strictObject({
  atStud: z.number().int().min(0).max(4096),
  widthStuds: z.number().int().min(1).max(4096),
  fromCourse: z.number().int().min(0).max(4096),
  toCourse: z.number().int().min(0).max(4096),
})

const brickFamily = z.enum(['brick', 'plate', 'tile'])

/** Shared by the four parametric generators. */
const generatorBase = {
  color: colorCode.optional(),
  originLdu: vec3.optional().describe('Lower corner. Defaults to the stud plane of the current selection. Prefer anchorPartId.'),
  anchorPartId: partId.optional().describe('Existing part id whose studs receive the assembly. Copy from scene_query instead of inventing XYZ.'),
}

const CAPABILITY_SCHEMAS = {
  ...MECHANISM_SCHEMAS,
  // ---- reads ----------------------------------------------------------
  export_ldraw: z.strictObject({}),
  export_mpd: z.strictObject({}),
  export_bom: z.strictObject({}),
  catalog_coverage: z.strictObject({}),
  weak_attachments: z.strictObject({}),
  selection_connected: z.strictObject({ partIds: partIds.optional() }),
  statics: z.strictObject({ clutchGramsPerStud: z.number().finite().positive().optional() }),
  list_joints: z.strictObject({ partIds: partIds.optional() }),
  compute_build_order: z.strictObject({ maxPartsPerStep: z.number().int().min(1).max(100).optional() }),

  // ---- transforms -----------------------------------------------------
  duplicate_selection: z.strictObject({
    partIds: partIds.optional(),
    offsetLdu: vec3.optional(),
    along: z.enum(['x', 'z', 'on-top']).optional().describe('Measured copy direction. Prefer this over inventing offsetLdu.'),
  }),
  mirror_selection: z.strictObject({
    partIds: partIds.optional(),
    axis: z.enum(['x', 'y', 'z']).optional().describe('Which coordinate the mirror reflects. Default x (left-right). z is front-to-back; y is vertical.'),
    axisLdu: z.number().finite().optional(),
    about: z.enum(['world', 'selection']).optional().describe('world is axis=axisLdu (default 0). selection is the measured centre of the selection along that axis.'),
  }),
  linear_array: z.strictObject({
    partIds: partIds.optional(),
    copies: z.number().int().min(1).max(24),
    offsetLdu: vec3.optional().describe('Copy pitch in LDU. Omit this and pass along instead of inventing XYZ.'),
    along: z.enum(['x', 'z', 'on-top']).optional(),
  }),

  // ---- parametric assemblies -----------------------------------------
  build_wall: z.strictObject({
    ...generatorBase,
    lengthStuds: z.number().int().min(1).max(256),
    courses: z.number().int().min(1).max(64),
    axis: z.enum(['x', 'z']).optional(),
    family: brickFamily.optional(),
    depthStuds: z.number().int().min(1).max(2).optional(),
    openings: z.array(opening).max(24).optional(),
  }),
  build_enclosure: z.strictObject({
    ...generatorBase,
    widthStuds: z.number().int().min(1).max(256),
    depthStuds: z.number().int().min(1).max(256),
    courses: z.number().int().min(1).max(64),
    family: z.enum(['brick', 'plate']).optional(),
    wallDepthStuds: z.number().int().min(1).max(2).optional(),
    floor: z.boolean().optional(),
    floorLayers: z.number().int().min(1).max(2).optional(),
    openings: z.array(opening).max(24).optional(),
  }),
  build_field: z.strictObject({
    ...generatorBase,
    widthStuds: z.number().int().min(1).max(256),
    depthStuds: z.number().int().min(1).max(256),
    layers: z.number().int().min(1).max(2).optional(),
    family: brickFamily.optional(),
  }),
  build_structure: z.strictObject({
    widthStuds: z.number().int().min(6).max(128),
    depthStuds: z.number().int().min(6).max(128),
    storeys: z.number().int().min(1).max(24),
    color: colorCode,
    coursesPerStorey: z.number().int().min(2).max(12).optional(),
    bandColor: colorCode.optional(),
    windowsPerSide: z.number().int().min(0).max(8).optional(),
    windowWidthStuds: z.number().int().min(1).max(8).optional(),
    door: z.boolean().optional(),
    trimColor: colorCode.optional(),
    glassColor: colorCode.optional(),
    deckLayers: z.number().int().min(1).max(2).optional(),
    originLdu: vec3.optional(),
    anchorPartId: partId.optional().describe('Existing part id whose studs receive the building. Copy from scene_query.'),
  }),
  build_hinged_flap: z.strictObject({
    ...generatorBase,
    widthStuds: z.number().int().min(2).max(128),
    reachStuds: z.number().int().min(1).max(128),
  }),

  // ---- modules --------------------------------------------------------
  capture_module: z.strictObject({ name: z.string().trim().min(1).max(80), partIds: partIds.optional() }),
  stamp_module: z.strictObject({
    module: z.string().trim().min(1).max(120).describe('Captured module id or name.'),
    atLdu: vec3.optional().describe('Stamp corner in LDU. Omit this and pass anchorPartId instead of inventing XYZ.'),
    anchorPartId: partId.optional().describe('Existing part id whose top receives the stamp. Copy from scene_query.'),
    quarterTurns: z.number().int().min(-64).max(64).optional(),
    copies: z.number().int().min(1).max(64).optional(),
    spacingLdu: vec3.optional(),
    color: colorCode.optional(),
  }),
  remove_module: z.strictObject({ module: z.string().trim().min(1).max(120) }),
  stack_selection: z.strictObject({
    copies: z.number().int().min(1).max(32),
    partIds: partIds.optional(),
    gapLdu: z.number().finite().optional(),
  }),

  // ---- mechanism ------------------------------------------------------
  connect_parts: z.strictObject({ movingPartId: partId, targetPartId: partId }),
  articulate_joint: z.strictObject({
    edgeId: z.string().min(1).max(200),
    partIds: partIds.optional(),
    rotateDegrees: z.number().finite().optional(),
    slideLdu: z.number().finite().optional(),
  }),

  // ---- structure ------------------------------------------------------
  create_subassembly: z.strictObject({
    name: z.string().trim().min(1).max(80),
    partIds: partIds.optional(),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  }),
  assign_subassembly: z.strictObject({ subassemblyId: z.string().min(1).max(80), partIds: partIds.optional() }),
  rename_subassembly: z.strictObject({
    subassemblyId: z.string().min(1).max(80),
    name: z.string().trim().min(1).max(80),
  }),
  lock_subassembly: z.strictObject({ subassemblyId: z.string().min(1).max(80), locked: z.boolean() }),

  // ---- collaboration --------------------------------------------------
  add_builder_note: z.strictObject({ text: z.string().trim().min(1).max(800), partIds: partIds.optional() }),
  respond_to_note: z.strictObject({
    noteId: z.string().min(1).max(80),
    response: z.string().trim().min(1).max(1200),
    resolved: z.boolean().optional(),
  }),

  // ---- constraints ----------------------------------------------------
  set_dimension_limit: z.strictObject({
    widthStuds: z.number().finite().positive(),
    depthStuds: z.number().finite().positive(),
    heightStuds: z.number().finite().positive().optional(),
    hard: z.boolean().optional(),
  }),
  set_piece_budget: z.strictObject({ maxParts: z.number().int().min(1).max(100_000), hard: z.boolean().optional() }),
  set_palette: z.strictObject({
    colors: z.array(z.number().int().min(0).max(999_999)).min(1).max(64),
    hard: z.boolean().optional(),
  }),
  remove_constraint: z.strictObject({ constraintId: z.string().min(1).max(80) }),

  // ---- sequence and project ------------------------------------------
  apply_build_order: z.strictObject({ maxPartsPerStep: z.number().int().min(1).max(100).optional() }),
  rename_document: z.strictObject({ name: z.string().trim().min(1).max(120) }),

  // === AGENT-ML-OWNED (Opus) ===
  generate_from_brief: z.strictObject({
    prompt: z.string().min(1).max(4000).describe('The build request in plain words. Compiled into a design brief, evidence and all.'),
    candidateCount: z.number().int().min(1).max(6).optional().describe('How many structural strategies to try. Defaults to 1.'),
    useModel: z
      .literal(false)
      .optional()
      .describe('Only false is accepted here; this capability is the deterministic path. For model-backed massing call the generation_run tool.'),
    partBudget: z.number().int().min(1).max(4000).optional().describe('Overrides the budget the brief inferred.'),
    envelopeStuds: vec3.optional().describe('Overrides the envelope the brief inferred, in studs [width, height, depth].'),
  }),
  generate_region: z.strictObject({
    prompt: z.string().min(1).max(4000).describe('What to build into the region — "a boarding ramp", "another storey", "a crane deck".'),
    anchorPartId: partId.optional().describe('Existing part the region is generated onto. Copy from scene_query; do not invent XYZ.'),
    envelopeStuds: vec3
      .optional()
      .describe('Region size in studs [width, height, depth]. Defaults to the measured extent around the anchor.'),
    partBudget: z.number().int().min(1).max(4000).optional(),
  }),
} as const satisfies Record<SharedCapabilityId, z.ZodType>

export type CapabilitySchemas = typeof CAPABILITY_SCHEMAS

/** The runtime schema for one capability, or undefined for an unknown id. */
export function capabilitySchema(id: string): z.ZodType | undefined {
  return (CAPABILITY_SCHEMAS as Record<string, z.ZodType | undefined>)[id]
}

/** The runtime schema for one mutating capability. Total over `SharedMutationId`. */
export function mutationSchema(id: SharedMutationId): z.ZodType {
  return CAPABILITY_SCHEMAS[id]
}

/** JSON Schema derived from the enforced schema, so the two cannot diverge. */
export function capabilityJsonSchema(id: string): Record<string, unknown> | undefined {
  const schema = capabilitySchema(id)
  return schema ? (z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>) : undefined
}

export interface CapabilityArgsFailure {
  code: 'INVALID_INPUT'
  message: string
  repair: string
  issues: Array<{ path: string; problem: string }>
}

export type CapabilityArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: CapabilityArgsFailure }

/**
 * Validates capability arguments against the enforced schema.
 *
 * Returns a result rather than throwing so callers can put the failure in front
 * of the model as a repairable tool error — a thrown exception at this layer
 * would surface as an internal error and tell the model nothing about which
 * field it got wrong.
 */
export function parseCapabilityArgs(id: string, raw: unknown): CapabilityArgsResult {
  const schema = capabilitySchema(id)
  if (!schema) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Unknown capability "${id}".`,
        repair: 'Call capability_search, then use one of the returned ids.',
        issues: [],
      },
    }
  }
  const result = schema.safeParse(raw ?? {})
  if (result.success) return { ok: true, args: result.data as Record<string, unknown> }
  const issues = result.error.issues.slice(0, 5).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    problem: issue.message,
  }))
  return {
    ok: false,
    error: {
      code: 'INVALID_INPUT',
      message: `Arguments for ${id} did not match its schema: ${issues
        .map((issue) => `${issue.path} — ${issue.problem}`)
        .join('; ')}`,
      repair: `Call capability_search for "${id}" and resend arguments matching its declared JSON Schema.`,
      issues,
    },
  }
}

/**
 * The prose contract in `SHARED_CAPABILITIES` reduced to field requiredness.
 *
 * "optional" or "default" in a field's description means the planner supplies a
 * value; anything else is a field the caller has to send. The parity test uses
 * this to prove the two declarations agree rather than trusting that they do.
 */
export function advertisedFields(capability: SharedCapability): Array<{ name: string; required: boolean }> {
  return Object.entries(capability.input as Record<string, string>).map(([name, description]) => ({
    name,
    required: !/\boptional\b/i.test(description) && !/\bdefault\b/i.test(description),
  }))
}

/** Every capability id, in the order the shared catalog declares them. */
export const CAPABILITY_IDS: readonly SharedCapabilityId[] = SHARED_CAPABILITIES.map(
  (capability) => capability.id,
)
