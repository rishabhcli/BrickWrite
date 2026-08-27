import { articulate, findArticulatedJoints } from './articulation'
import { STUD_LDU } from './catalog'
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
  { id: 'weak_attachments', kind: 'read', group: 'inspect', title: 'Weak attachments', summary: 'Find parts held by only one neighbouring part.', input: {} },
  { id: 'list_joints', kind: 'read', group: 'mechanism', title: 'List joints', summary: 'Inspect drivable joints in the current scope.', input: { partIds: 'string[], optional' } },
  { id: 'compute_build_order', kind: 'read', group: 'sequence', title: 'Preview build order', summary: 'Derive and verify an attachment-aware build sequence.', input: { maxPartsPerStep: 'integer, optional' } },
  { id: 'duplicate_selection', kind: 'mutate', group: 'transform', title: 'Duplicate precisely', summary: 'Copy parts by an exact LDraw-unit offset.', input: { partIds: 'string[], optional', offsetLdu: '[x,y,z], default [20,0,0]' } },
  { id: 'mirror_selection', kind: 'mutate', group: 'transform', title: 'Mirror across X', summary: 'Reflect selected transforms across an exact X plane.', input: { partIds: 'string[], optional', axisLdu: 'number, default 0' } },
  { id: 'linear_array', kind: 'mutate', group: 'transform', title: 'Linear array', summary: 'Create deterministic repeated copies along an exact vector.', input: { partIds: 'string[], optional', copies: 'integer 1-24', offsetLdu: '[x,y,z]' } },
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
