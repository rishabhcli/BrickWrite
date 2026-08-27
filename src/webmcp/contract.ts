import { z } from 'zod'
import { catalog } from '../cad/catalog'
import type { CadOperation, Transform } from '../cad/types'
import { basisFromEulerDegrees, IDENTITY_BASIS, isOrthonormal, orthonormalize, type Mat3 } from '../cad/math'

/**
 * The WebMCP contract.
 *
 * Schemas are declared once with Zod and JSON Schema is derived from them, so the
 * shape the agent is told about and the shape the gateway enforces cannot drift.
 * Previously the tool descriptions hand-wrote JSON Schema while the handlers did
 * their own ad-hoc coercion, which meant `operations` was advertised as an array
 * of bare objects and validated nowhere.
 */

export const TOOL_PROFILE = 'brickwright.tools/2'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const Vec3Schema = z
  .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
  .describe('LDraw units. LDraw is Y-down, so a part stacked on top has a smaller y.')

const BasisSchema = z
  .tuple([
    z.number().finite(), z.number().finite(), z.number().finite(),
    z.number().finite(), z.number().finite(), z.number().finite(),
    z.number().finite(), z.number().finite(), z.number().finite(),
  ])
  .describe(
    'Row-major orthonormal 3x3 orientation — the same nine values an LDraw type-1 line carries. ' +
      'Exact and preferred over `rotation`.',
  )

const EulerSchema = Vec3Schema.describe(
  'Convenience orientation in Euler degrees about the LDraw X, Y and Z axes. Converted to an exact ' +
    'basis on entry; the document never stores angles.',
)

/**
 * Orientation as either an exact basis or Euler degrees.
 *
 * A non-orthonormal basis is rejected rather than silently normalized: an agent
 * that sends a sheared matrix has a bug, and quietly correcting it would hide
 * that while producing a part the operator did not ask for.
 */
export function resolveBasis(input: { basis?: readonly number[]; rotation?: readonly number[] }, fallback: Mat3): Mat3 {
  if (input.basis) {
    const candidate = input.basis as unknown as Mat3
    if (!isOrthonormal(candidate, 1e-4)) {
      throw new ContractError(
        'INVALID_INPUT',
        'basis must be an orthonormal row-major 3x3 matrix.',
        'Send a rotation matrix whose rows are unit length and mutually perpendicular, or use `rotation` in degrees instead.',
      )
    }
    return orthonormalize(candidate)
  }
  if (input.rotation) return basisFromEulerDegrees(input.rotation as unknown as [number, number, number])
  return fallback
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const PoseFields = {
  position: Vec3Schema.optional(),
  basis: BasisSchema.optional(),
  rotation: EulerSchema.optional(),
}

const AddOperation = z.object({
  op: z.literal('add'),
  definitionId: z.string().min(1).max(64),
  color: z.number().int().min(0).max(9999).optional(),
  partId: z.string().min(1).max(80).optional(),
  subassemblyId: z.string().min(1).max(80).optional(),
  stepId: z.string().min(1).max(80).optional(),
  ...PoseFields,
})

const MoveOperation = z.object({
  op: z.enum(['move', 'transform']),
  partId: z.string().min(1).max(80),
  ...PoseFields,
})

const RemoveOperation = z.object({ op: z.literal('remove'), partId: z.string().min(1).max(80) })

const RecolorOperation = z.object({
  op: z.literal('recolor'),
  partId: z.string().min(1).max(80),
  color: z.number().int().min(0).max(9999),
})

const ProtectOperation = z.object({
  op: z.literal('protect'),
  partId: z.string().min(1).max(80),
  protected: z.boolean(),
})

const LockOperation = z.object({
  op: z.literal('lock-subassembly'),
  subassemblyId: z.string().min(1).max(80),
  locked: z.boolean(),
})

const AssignSubassemblyOperation = z.object({
  op: z.literal('assign-subassembly'),
  partId: z.string().min(1).max(80),
  subassemblyId: z.string().min(1).max(80),
})

const AddSubassemblyOperation = z.object({
  op: z.literal('add-subassembly'),
  subassemblyId: z.string().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  locked: z.boolean().optional(),
})

const RenameSubassemblyOperation = z.object({
  op: z.literal('rename-subassembly'),
  subassemblyId: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(80),
})

const AddNoteOperation = z.object({
  op: z.literal('add-note'),
  noteId: z.string().min(1).max(80).optional(),
  partIds: z.array(z.string().min(1).max(80)).min(1).max(500),
  text: z.string().trim().min(1).max(800),
})

const RespondNoteOperation = z.object({
  op: z.literal('respond-note'),
  noteId: z.string().min(1).max(80),
  response: z.string().trim().min(1).max(1200),
  resolved: z.boolean().optional(),
})

const RenameDocumentOperation = z.object({
  op: z.literal('rename-document'),
  name: z.string().trim().min(1).max(120),
})

const ReplaceStepsOperation = z.object({
  op: z.literal('replace-steps'),
  steps: z.array(z.object({
    id: z.string().min(1).max(80),
    index: z.number().int().min(0),
    name: z.string().trim().min(1).max(120),
    partIds: z.array(z.string().min(1).max(80)).max(500),
  })).min(1).max(250),
})

const SetDimensionConstraintOperation = z.object({
  op: z.literal('set-dimension-constraint'),
  constraintId: z.string().min(1).max(80).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  widthStuds: z.number().finite().positive(),
  depthStuds: z.number().finite().positive(),
  heightStuds: z.number().finite().positive().optional(),
  hard: z.boolean().optional(),
})

const SetPieceBudgetOperation = z.object({
  op: z.literal('set-piece-budget'),
  constraintId: z.string().min(1).max(80).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  maxParts: z.number().int().min(1).max(100_000),
  hard: z.boolean().optional(),
})

const SetPaletteConstraintOperation = z.object({
  op: z.literal('set-palette-constraint'),
  constraintId: z.string().min(1).max(80).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  colors: z.array(z.number().int().min(0).max(9999)).min(1).max(64),
  hard: z.boolean().optional(),
})

const RemoveConstraintOperation = z.object({
  op: z.literal('remove-constraint'),
  constraintId: z.string().min(1).max(80),
})

export const OperationSchema = z.discriminatedUnion('op', [
  AddOperation,
  MoveOperation,
  RemoveOperation,
  RecolorOperation,
  ProtectOperation,
  LockOperation,
  AssignSubassemblyOperation,
  AddSubassemblyOperation,
  RenameSubassemblyOperation,
  AddNoteOperation,
  RespondNoteOperation,
  RenameDocumentOperation,
  ReplaceStepsOperation,
  SetDimensionConstraintOperation,
  SetPieceBudgetOperation,
  SetPaletteConstraintOperation,
  RemoveConstraintOperation,
])

export type OperationInput = z.infer<typeof OperationSchema>

/** Hard ceiling on one batch, so an agent cannot request unbounded work. */
export const MAX_OPERATIONS_PER_BATCH = 500

export const PreflightSchema = z.object({
  expectedRevision: z.number().int().min(0),
  expectedCatalogVersion: z.string().optional(),
  expectedToolProfileHash: z.string().optional(),
  label: z.string().min(1).max(160),
  operations: z.array(OperationSchema).min(1).max(MAX_OPERATIONS_PER_BATCH),
})

export const CatalogSearchSchema = z.object({
  text: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  minStuds: z
    .object({ width: z.number().optional(), height: z.number().optional(), depth: z.number().optional() })
    .optional(),
  maxStuds: z
    .object({ width: z.number().optional(), height: z.number().optional(), depth: z.number().optional() })
    .optional(),
  connectorTypes: z.array(z.string()).max(12).optional(),
  colors: z.array(z.number().int()).max(24).optional(),
  requireGeometry: z.boolean().optional(),
  includeHelpers: z.boolean().optional(),
  /**
   * Which knowledge tier to search. Defaults to every loaded tier, so a
   * question about whether a part exists is not silently answered from the
   * subset this build happens to be able to place.
   */
  tier: z.enum(['placeable', 'modelled', 'catalogued', 'all']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
})

/** Derives the JSON Schema a tool advertises from its runtime schema. */
export const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BrickwrightErrorCode =
  | 'STALE_DOCUMENT'
  | 'STALE_TOOL_PROFILE'
  | 'CATALOG_VERSION_MISMATCH'
  | 'PROTECTED_REGION'
  | 'PART_NOT_FOUND'
  | 'PART_DEFINITION_NOT_FOUND'
  | 'GEOMETRY_UNAVAILABLE'
  | 'COLOR_UNAVAILABLE'
  | 'NO_COMPATIBLE_CONNECTOR'
  | 'CONNECTOR_OCCUPIED'
  | 'COLLISION'
  | 'CONSTRAINT_VIOLATION'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_STALE'
  | 'READ_ONLY_MODE'
  | 'TOOL_NOT_AVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_OPERATION'
  | 'RESOURCE_LIMIT'
  | 'INTERNAL_ERROR'

export class ContractError extends Error {
  constructor(
    readonly code: BrickwrightErrorCode,
    message: string,
    readonly repair: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ContractError'
  }
}

/**
 * Patterns redacted from anything that becomes tool output.
 *
 * A tool error is model input. A leaked bearer token or signed URL would be
 * carried into the agent's context and potentially echoed onward, and a
 * filesystem path or long opaque blob is noise that crowds out the repair hint.
 */
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\b(api[_-]?key|token|password|passwd|secret|cookie|authorization)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*[?&](sig|signature|token|key)=[^\s"'&]+/gi, '[REDACTED_SIGNED_URL]'],
  [/data:[^;,\s]+;base64,[A-Za-z0-9+/=]{64,}/g, '[REDACTED_DATA_URL]'],
  [/\/(?:Users|home|var|private|tmp)\/[^\s"')]+/g, '[path]'],
  [/[A-Za-z0-9+/]{200,}={0,2}/g, '[REDACTED_BLOB]'],
]

export const MAX_ERROR_MESSAGE_LENGTH = 2048

/** Strips secrets and noise from a message destined for tool output. */
export function sanitizeMessage(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value ?? '')
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_ERROR_MESSAGE_LENGTH ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : text
}

export interface ToolErrorEnvelope {
  ok: false
  error: {
    code: BrickwrightErrorCode
    message: string
    repair: string
    retryable: boolean
    currentRevision?: number
    details?: Record<string, unknown>
  }
}

/** Codes worth retrying after the agent rereads state. */
const RETRYABLE: ReadonlySet<BrickwrightErrorCode> = new Set<BrickwrightErrorCode>([
  'STALE_DOCUMENT',
  'STALE_TOOL_PROFILE',
  'CATALOG_VERSION_MISMATCH',
  'PROPOSAL_STALE',
])

export function toErrorEnvelope(
  cause: unknown,
  context: { currentRevision?: number } = {},
): ToolErrorEnvelope {
  if (cause instanceof ContractError) {
    return {
      ok: false,
      error: {
        code: cause.code,
        message: sanitizeMessage(cause.message),
        repair: cause.repair,
        retryable: RETRYABLE.has(cause.code),
        ...(context.currentRevision !== undefined ? { currentRevision: context.currentRevision } : {}),
        ...(cause.details ? { details: cause.details } : {}),
      },
    }
  }

  if (cause instanceof z.ZodError) {
    // Zod's issue list is precise and safe to relay, but only the first few
    // matter: an agent needs the shape of the mistake, not an exhaustive audit.
    const issues = cause.issues.slice(0, 5).map((issue) => ({
      path: issue.path.join('.') || '(root)',
      problem: sanitizeMessage(issue.message),
    }))
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Input did not match the tool's schema: ${issues.map((issue) => `${issue.path} — ${issue.problem}`).join('; ')}`,
        repair: 'Call capabilities_help for this operation and resend arguments matching its declared schema.',
        retryable: false,
        details: { issues, totalIssues: cause.issues.length },
      },
    }
  }

  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      // A stack trace never reaches the agent; the sanitized message does.
      message: sanitizeMessage(cause) || 'The operation failed.',
      repair: 'Reread the workspace and retry; if it persists, report it through tooling_feedback_report.',
      retryable: false,
      ...(context.currentRevision !== undefined ? { currentRevision: context.currentRevision } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Tool profile
// ---------------------------------------------------------------------------

/**
 * Stable fingerprint of the tool surface currently exposed.
 *
 * An agent can pass the hash it discovered back on a mutation; if the surface has
 * since changed — an autonomy switch, a catalog upgrade — the call is refused
 * rather than executed against a contract the agent never saw.
 */
export function toolProfileHash(toolNames: readonly string[], catalogVersion: string): string {
  const canonical = JSON.stringify({ profile: TOOL_PROFILE, tools: [...toolNames].sort(), catalogVersion })
  // FNV-1a: no crypto dependency, and collision resistance is irrelevant here —
  // this detects change, it does not defend against forgery.
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`
}

export interface ProfileContext {
  toolProfile: string
  profileHash: string
  catalogVersion: string
  documentRevision: number
}

/** Refuses a call whose expectations no longer hold. */
export function assertExpectations(
  input: { expectedToolProfileHash?: string; expectedCatalogVersion?: string },
  context: ProfileContext,
): void {
  if (input.expectedToolProfileHash && input.expectedToolProfileHash !== context.profileHash) {
    throw new ContractError(
      'STALE_TOOL_PROFILE',
      `Tool surface changed: expected profile ${input.expectedToolProfileHash}, current is ${context.profileHash}.`,
      'Call workspace_get and capabilities_search again, then reissue against the current profile.',
      { currentProfileHash: context.profileHash },
    )
  }
  if (input.expectedCatalogVersion && input.expectedCatalogVersion !== context.catalogVersion) {
    throw new ContractError(
      'CATALOG_VERSION_MISMATCH',
      `Catalog changed: expected ${input.expectedCatalogVersion}, current is ${context.catalogVersion}.`,
      'Reread part identities from catalog_search; part numbers and colour evidence may have moved.',
      { currentCatalogVersion: context.catalogVersion },
    )
  }
}

// ---------------------------------------------------------------------------
// Operation translation
// ---------------------------------------------------------------------------

/**
 * Turns validated tool input into kernel operations.
 *
 * An unknown or unplaceable definition is *not* rejected here: the operation is
 * built and handed to the kernel so the agent receives the kernel's specific
 * error — `PART_DEFINITION_NOT_FOUND` or `GEOMETRY_UNAVAILABLE` — rather than a
 * generic adapter failure that says nothing about how to recover.
 */
export function toKernelOperations(
  inputs: readonly OperationInput[],
  context: {
    parts: Record<string, { transform: Transform }>
    defaultSubassemblyId: string
    defaultStepId: string
    idPrefix: string
    revision: number
  },
): CadOperation[] {
  return inputs.map((input, index): CadOperation => {
    switch (input.op) {
      case 'add': {
        const definition = catalog.get(input.definitionId)
        return {
          type: 'part.add',
          part: {
            id: input.partId ?? `${context.idPrefix}_${index}`,
            definitionId: input.definitionId,
            color: input.color ?? definition?.availableColors[0] ?? 71,
            transform: {
              position: input.position ?? [0, 0, 0],
              basis: resolveBasis(input, IDENTITY_BASIS),
            },
            subassemblyId: input.subassemblyId ?? context.defaultSubassemblyId,
            stepId: input.stepId ?? context.defaultStepId,
            provenance: 'agent',
            protected: false,
          },
        }
      }
      case 'move':
      case 'transform': {
        const current = context.parts[input.partId]
        return {
          type: 'part.transform',
          partId: input.partId,
          transform: {
            position: input.position ?? current?.transform.position ?? [0, 0, 0],
            basis: resolveBasis(input, current?.transform.basis ?? IDENTITY_BASIS),
          },
        }
      }
      case 'remove':
        return { type: 'part.remove', partId: input.partId }
      case 'recolor':
        return { type: 'part.recolor', partId: input.partId, color: input.color }
      case 'protect':
        return { type: 'part.protect', partId: input.partId, protected: input.protected }
      case 'lock-subassembly':
        return { type: 'subassembly.lock', subassemblyId: input.subassemblyId, locked: input.locked }
      case 'assign-subassembly':
        return { type: 'part.assign-subassembly', partId: input.partId, subassemblyId: input.subassemblyId }
      case 'add-subassembly':
        return {
          type: 'subassembly.add',
          subassembly: {
            id: input.subassemblyId ?? `${context.idPrefix}_subassembly_${index}`,
            name: input.name,
            partIds: [],
            locked: input.locked ?? false,
            accent: input.accent ?? '#e79032',
          },
        }
      case 'rename-subassembly':
        return { type: 'subassembly.rename', subassemblyId: input.subassemblyId, name: input.name }
      case 'add-note':
        return {
          type: 'note.add',
          note: {
            id: input.noteId ?? `${context.idPrefix}_note_${index}`,
            anchorPartIds: [...new Set(input.partIds)],
            text: input.text,
            status: 'open',
            author: 'agent',
            revisionCreated: context.revision,
          },
        }
      case 'respond-note':
        return { type: 'note.respond', noteId: input.noteId, response: input.response, resolved: input.resolved }
      case 'rename-document':
        return { type: 'document.rename', name: input.name }
      case 'replace-steps':
        return { type: 'steps.replace', steps: input.steps.map((step) => ({ ...step, partIds: [...new Set(step.partIds)] })) }
      case 'set-dimension-constraint':
        return {
          type: 'constraint.set',
          constraint: {
            id: input.constraintId ?? `${context.idPrefix}_dimensions_${index}`,
            kind: 'dimensions',
            label: input.label ?? 'Maximum dimensions',
            value: {
              width: input.widthStuds,
              depth: input.depthStuds,
              ...(input.heightStuds === undefined ? {} : { height: input.heightStuds }),
            },
            hard: input.hard ?? true,
          },
        }
      case 'set-piece-budget':
        return {
          type: 'constraint.set',
          constraint: {
            id: input.constraintId ?? `${context.idPrefix}_pieces_${index}`,
            kind: 'piece-count',
            label: input.label ?? 'Piece budget',
            value: input.maxParts,
            hard: input.hard ?? true,
          },
        }
      case 'set-palette-constraint':
        return {
          type: 'constraint.set',
          constraint: {
            id: input.constraintId ?? `${context.idPrefix}_palette_${index}`,
            kind: 'palette',
            label: input.label ?? 'Allowed palette',
            value: [...new Set(input.colors)],
            hard: input.hard ?? true,
          },
        }
      case 'remove-constraint':
        return { type: 'constraint.remove', constraintId: input.constraintId }
    }
  })
}
