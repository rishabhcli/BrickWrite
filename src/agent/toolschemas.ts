import { z } from 'zod'

/**
 * The grounded tool surface the assistant is given.
 *
 * Declared once, here, because both sides of the process boundary need it and
 * they need it to be the same thing: `server/assistant` derives the JSON Schema
 * it advertises to the model from these declarations, and `src/agent/tools.ts`
 * parses incoming tool arguments with the very same objects before touching the
 * kernel. This file imports nothing but Zod — no kernel, no React, no DOM — so
 * the API process can import it without dragging the CAD kernel into Node.
 *
 * Shape of the surface, and why:
 *
 *   - Everything the model can call is a *read* or a *preflight*. There is no
 *     commit tool. A model cannot write the document even in Build mode; only
 *     `src/agent/modes.ts` reaches `commandBus`, and only after re-checking the
 *     revision. That is the structural half of "Propose mutates nothing".
 *   - Placement is expressed as a connector relationship to a named anchor
 *     part, not as absolute coordinates. The kernel's snap solver turns that
 *     into a pose. A model that guesses XYZ produces floating bricks; a model
 *     that says "on top of part_0007" produces a mated one.
 */

export const REFERENCE_TOKEN_DESCRIPTION =
  'A spatial reference: "@selection", "@part:<id>", "@subassembly:<id>", "@note:<id>", "@view" or a literal part id.'

const partIdList = z.array(z.string().min(1).max(80)).max(200)

export const SceneOverviewInput = z.strictObject({})

export const SceneQueryInput = z.strictObject({
  subassemblyId: z.string().min(1).max(80).optional(),
  partIds: partIdList.optional(),
  definitionId: z.string().min(1).max(64).optional().describe('Filter to placed instances of one catalog identity.'),
  selectionOnly: z.boolean().optional(),
  includeNeighbours: z
    .boolean()
    .optional()
    .describe('Include the parts each result is physically connected to. Use this to plan attachments.'),
  limit: z.number().int().min(1).max(200).optional(),
})

export const SelectionGeometryInput = z.strictObject({
  reference: z.string().min(1).max(120).optional().describe(REFERENCE_TOKEN_DESCRIPTION),
})

export const CatalogSearchInput = z.strictObject({
  text: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  connectorTypes: z.array(z.string().max(24)).max(12).optional(),
  requireGeometry: z.boolean().optional(),
  tier: z.enum(['placeable', 'modelled', 'catalogued', 'all']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

export const CapabilitySearchInput = z.strictObject({
  query: z.string().max(120).optional().describe('Task-oriented words, e.g. "wall", "mirror", "budget".'),
  capability: z.string().max(80).optional().describe('Exact capability id, to fetch its full argument schema.'),
})

export const NotesReadInput = z.strictObject({
  status: z.enum(['open', 'resolved', 'all']).optional(),
})

export const RenderCaptureInput = z.strictObject({
  view: z.enum(['isometric', 'front', 'rear', 'left', 'right', 'top']).optional(),
  width: z.number().int().min(64).max(1024).optional(),
  height: z.number().int().min(64).max(1024).optional(),
})

export const ValidateModelInput = z.strictObject({})

export const PreflightCapabilityInput = z.strictObject({
  capability: z.string().min(1).max(80),
  args: z.record(z.string(), z.unknown()).optional(),
  label: z.string().min(1).max(120).optional().describe('What a reviewer will read on this wave.'),
})

export const PreflightPlacementInput = z.strictObject({
  definitionId: z.string().min(1).max(64).describe('A catalog identity with tier "placeable".'),
  anchorPartId: z.string().min(1).max(80).describe('An existing part id to attach to.'),
  approach: z
    .enum(['on-top', 'underneath', 'beside-x', 'beside-minus-x', 'beside-z', 'beside-minus-z'])
    .describe('Which face of the anchor to seat against. The snap solver finds the exact mating pose.'),
  color: z.number().int().min(0).max(999_999).optional(),
  quarterTurns: z.number().int().min(-4).max(4).optional().describe('Rotation about the vertical axis.'),
  offsetStuds: z
    .number()
    .int()
    .min(-64)
    .max(64)
    .optional()
    .describe('Slide along the approach face, in whole studs, before solving the mate.'),
  label: z.string().min(1).max(120).optional(),
})

export const RepairSuggestInput = z.strictObject({
  proposalId: z.string().min(1).max(120).optional(),
  partIds: partIdList.optional(),
  failureCode: z.string().max(64).optional().describe('The error code the previous attempt returned.'),
})

export interface AssistantToolDeclaration {
  readonly name: string
  readonly description: string
  readonly schema: z.ZodType
  /** Read tools are offered in every autonomy mode; preflight tools are not. */
  readonly kind: 'read' | 'preflight'
}

export const ASSISTANT_TOOLS: readonly AssistantToolDeclaration[] = [
  {
    name: 'scene_overview',
    kind: 'read',
    description:
      'Read the current document: exact revision, autonomy mode, part count, measured bounds, subassemblies and their locks, design constraints, module library and a validation summary. Call this first; every later call depends on the revision it returns.',
    schema: SceneOverviewInput,
  },
  {
    name: 'scene_query',
    kind: 'read',
    description:
      'List placed parts with their identity, colour, assembly, protection flag and — with includeNeighbours — the parts they are physically connected to. Filter rather than dumping the scene.',
    schema: SceneQueryInput,
  },
  {
    name: 'selection_geometry',
    kind: 'read',
    description:
      'Measure a reference scope: world bounds in LDraw units and studs, the top mating plane, which parts sit at that plane, protection and lock status, and the neighbouring parts. Use this instead of guessing coordinates.',
    schema: SelectionGeometryInput,
  },
  {
    name: 'catalog_search',
    kind: 'read',
    description:
      'Search every catalogued LEGO identity. Each result carries its tier: placeable (compiled geometry, can be built with), modelled (shape known, no mesh in this build) or catalogued (the part exists and nothing else is known). Only placeable identities can be placed; say so plainly when a requested part is not one.',
    schema: CatalogSearchInput,
  },
  {
    name: 'capability_search',
    kind: 'read',
    description:
      'Discover the shared human/agent action vocabulary. With `capability` set, returns that capability’s exact JSON Schema — the same schema the gateway enforces. Plan in capabilities, not in coordinates.',
    schema: CapabilitySearchInput,
  },
  {
    name: 'notes_read',
    kind: 'read',
    description: 'Read spatial builder notes with their anchor parts, author, revision and resolution status.',
    schema: NotesReadInput,
  },
  {
    name: 'render_capture',
    kind: 'read',
    description:
      'Capture the model from a named engineering view. Returns measured framing, coverage and bounds, and the rendered pixels when an encoder is available. When pixels are unavailable it says so rather than describing an image it does not have.',
    schema: RenderCaptureInput,
  },
  {
    name: 'validate_model',
    kind: 'read',
    description:
      'Run deterministic collision, connectivity, colour-evidence and constraint validation on the current document.',
    schema: ValidateModelInput,
  },
  {
    name: 'preflight_capability',
    kind: 'preflight',
    description:
      'Dry-run one shared capability. Validates arguments against its schema, resolves every referenced id against the live document, and produces a reviewable ghost wave. This never mutates the document — a human accepts or rejects the wave.',
    schema: PreflightCapabilityInput,
  },
  {
    name: 'preflight_placement',
    kind: 'preflight',
    description:
      'Dry-run placing one catalog part against an existing anchor part. You choose the identity, the anchor and the face; the kernel’s connector solver computes the pose. Produces a reviewable ghost wave and never mutates the document.',
    schema: PreflightPlacementInput,
  },
  {
    name: 'repair_suggest',
    kind: 'read',
    description:
      'Ask the kernel what to do about a refusal: measured collision overlaps and the offset that would clear them, which region is protected and who owns it, weak attachments, and whether a stale revision needs a replan.',
    schema: RepairSuggestInput,
  },
]

/** Tool declarations legal in one autonomy mode. Inspect is read-only, structurally. */
export function toolsForMode(mode: 'inspect' | 'propose' | 'build'): readonly AssistantToolDeclaration[] {
  return mode === 'inspect' ? ASSISTANT_TOOLS.filter((tool) => tool.kind === 'read') : ASSISTANT_TOOLS
}

export const ASSISTANT_TOOL_NAMES: readonly string[] = ASSISTANT_TOOLS.map((tool) => tool.name)

/** JSON Schema for one tool, derived from the schema that is actually enforced. */
export function toolJsonSchema(tool: AssistantToolDeclaration): Record<string, unknown> {
  return z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>
}
