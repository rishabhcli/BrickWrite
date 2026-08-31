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
    .describe(
      'Include graph neighbours (connectedTo) and spatially nearby parts (nearby: id, distanceLdu, approaches). A hovering brick has empty connectedTo — read nearby instead.',
    ),
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

/**
 * Generation, mirrored from the WebMCP surface.
 *
 * Declared here rather than imported from `src/webmcp/surfaces/generation.ts`
 * because this file may import nothing but Zod — the API process reads it — and
 * because the two surfaces are allowed to diverge in what they *offer* while
 * agreeing on what they *accept*. They do not diverge today: an external MCP
 * client and the in-editor Design Partner send the same arguments to the same
 * session.
 */
export const GenerationCompileInput = z.strictObject({
  prompt: z.string().max(4000).optional().describe('The build request in plain words. Omit to compile whatever prompt the session already holds.'),
})

export const GenerationSetInput = z.strictObject({
  prompt: z.string().max(4000).optional(),
  candidateCount: z.number().int().min(1).max(6).optional().describe('How many candidates to search. More candidates cost more time and more model spend.'),
  reason: z.string().min(1).max(200).optional().describe('Why the brief is being edited. Recorded on the brief.'),
  brief: z
    .object({
      subject: z.string().min(1).max(200).optional(),
      envelopeStuds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).nullable().optional(),
      scale: z.enum(['micro', 'minifig', 'midi', 'large', 'unspecified']).optional(),
      functions: z.array(z.string().min(1).max(80)).max(16).optional(),
      palette: z.array(z.number().int().min(0).max(9999)).max(16).optional(),
      symmetry: z.enum(['none', 'mirror-x', 'mirror-z', 'radial']).optional(),
      partBudget: z.number().int().min(1).max(4000).nullable().optional(),
      style: z.array(z.string().min(1).max(40)).max(12).optional(),
    })
    .optional(),
  conflict: z
    .object({
      field: z.string().min(1).max(40),
      choice: z.enum(['compiler', 'operator']),
    })
    .optional()
    .describe('Settle one contradiction the compiler refused to decide. Every conflict must be settled before generation_run.'),
})

export const GenerationRunInput = z.strictObject({
  useModel: z.boolean().optional().describe('false runs the deterministic strategies with no model call.'),
})

export const GenerationStateInput = z.strictObject({})

export const GenerationCancelInput = z.strictObject({})

export const GenerationPreviewInput = z.strictObject({
  candidateId: z.string().min(1).max(120).describe('An id from the candidates array of generation_run or generation_state.'),
  label: z.string().min(1).max(120).optional().describe('What a reviewer will read on this wave. Defaults to the brief subject.'),
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
      'Read the current document: exact revision, autonomy mode, part count, measured bounds, statics (tipping, overloaded joints), subassemblies and their locks, design constraints, module library, a validation summary, and nextAction / nextTool / nextArgs — the kernel\'s instruction for the next tool call. Call this first. If partCount is 0, do not call preflight_placement.',
    schema: SceneOverviewInput,
  },
  {
    name: 'scene_query',
    kind: 'read',
    description:
      'List placed parts with their identity, colour, assembly, protection flag, which faces can still receive a brick (approaches), and — with includeNeighbours — graph neighbours plus spatially nearby parts. A hovering brick has no connectedTo; use nearby ids whose approaches.on-top is true, then preflight_capability connect_parts. Filter rather than dumping the scene.',
    schema: SceneQueryInput,
  },
  {
    name: 'selection_geometry',
    kind: 'read',
    description:
      'Measure a reference scope: world bounds in LDraw units and studs, the top mating plane, which parts sit at that plane, protection and lock status, graph neighbours, spatially nearby parts (even with no clutch), and connectors — freeByFamily plus approaches (on-top, underneath, beside). on-top is false when there are no free studs. Use nearby ids whose approaches.on-top is true with connect_parts instead of guessing coordinates.',
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
      'Run deterministic collision, connectivity, colour-evidence, constraint and statics validation. Returns floatingPartIds (hovering, unclutched) and nextAction for the next tool call.',
    schema: ValidateModelInput,
  },
  {
    name: 'generation_compile',
    kind: 'read',
    description:
      'Compile a build request in plain words into a DesignBrief: subject, envelope in studs, scale, palette, part budget, symmetry and functions, each with the evidence in the sentence that produced it. This is step one of building something whole — a tower, a freighter, a clock palace — and it is what "build me X" means. Contradictions are reported, never silently resolved. On MODEL_UNAVAILABLE, call generation_compile_local. Reads only.',
    schema: GenerationCompileInput,
  },
  {
    name: 'generation_compile_local',
    kind: 'read',
    description:
      'Compile the same brief from rules in this browser, with no model call. Use when generation_compile reports MODEL_UNAVAILABLE. Reads only.',
    schema: GenerationCompileInput,
  },
  {
    name: 'generation_set',
    kind: 'read',
    description:
      'Adjust the prompt, the candidate count, or brief fields, and settle the compiler/operator conflicts the brief reported. generation_run refuses while any conflict is open. Reads only.',
    schema: GenerationSetInput,
  },
  {
    name: 'generation_run',
    kind: 'read',
    description:
      'Run the generation pipeline — massing, skeleton, packing, detail — and score the candidates. One run produces whole bonded assemblies of hundreds or thousands of parts, with running bond, real openings and kernel-verified clutch; no coordinate in the result was proposed by a model. useModel=false is the deterministic path. Writes nothing: candidates are reviewed with generation_preview.',
    schema: GenerationRunInput,
  },
  {
    name: 'generation_state',
    kind: 'read',
    description:
      'Read the shared generation session: prompt, brief, unresolved conflicts, candidates with their part, collision and component counts, and what is under review. The Generate panel and this conversation are the same session, so a brief the builder typed is one you can read.',
    schema: GenerationStateInput,
  },
  {
    name: 'generation_cancel',
    kind: 'read',
    description: 'Stop an in-flight generation run. Nothing was written to the document.',
    schema: GenerationCancelInput,
  },
  {
    name: 'generation_preview',
    kind: 'preflight',
    description:
      'Stage one generated candidate as a single reviewable wave — the entire model as one ghost and one undo step, not a stream of individual adds. The kernel verifies collisions and connectivity against the live revision first. A person accepts it, or Build mode does after re-checking; this never mutates the document.',
    schema: GenerationPreviewInput,
  },
  {
    name: 'preflight_capability',
    kind: 'preflight',
    description:
      'Dry-run one shared capability. Validates arguments against its schema, resolves every referenced id against the live document, and produces a reviewable ghost wave. For walls, floors and stamps prefer anchorPartId from scene_query. For copies prefer along (x, z, on-top) over invented offsetLdu. This never mutates the document — a human accepts or rejects the wave.',
    schema: PreflightCapabilityInput,
  },
  {
    name: 'preflight_placement',
    kind: 'preflight',
    description:
      'Dry-run placing ONE catalog part against ONE existing anchor part. This is for a single deliberate brick — a detail, a fix, a part a builder named. It is the wrong tool for constructing anything: never lay a building, a vehicle, a mechanism or a set brick by brick with it. To build something whole, call generation_compile then generation_run; for a wall, floor, enclosure or field, call preflight_capability with build_wall / build_enclosure / build_structure / build_field. The document must already contain the anchor — on an empty plate this tool has nothing to attach to. You choose the identity, the anchor and the face; the kernel’s connector solver computes the pose. A pose that does not mate is refused as NO_COMPATIBLE_CONNECTOR (tile / wrong family) or CONNECTOR_OCCUPIED (that face had studs and they are all taken). Produces a reviewable ghost wave and never mutates the document.',
    schema: PreflightPlacementInput,
  },
  {
    name: 'repair_suggest',
    kind: 'read',
    description:
      'Ask the kernel what to do about a refusal. Returns measured collision overlaps, floating part ids, protected regions, weak attachments, and `next` — the exact tool and args to call next. Pass the failureCode you just received. Call next.tool with next.args unchanged. Never invent XYZ or a transform.',
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
