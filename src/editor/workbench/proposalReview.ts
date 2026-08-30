import type { CadOperation, EngineSnapshot, Proposal } from '../../cad/types'

export type ProposalOperationGroup =
  | 'add'
  | 'remove'
  | 'move'
  | 'appearance'
  | 'structure'
  | 'collaboration'
  | 'constraints'
  | 'sequence'
  | 'project'

export interface ProposalOperationSummary {
  readonly id: ProposalOperationGroup
  readonly label: string
  readonly count: number
  readonly partIds: readonly string[]
}

export interface ProposalReviewSummary {
  readonly affectedPartIds: readonly string[]
  readonly selectablePartIds: readonly string[]
  readonly addedPartIds: readonly string[]
  readonly removedPartIds: readonly string[]
  readonly groups: readonly ProposalOperationSummary[]
  readonly partDelta: number
  readonly connectionDelta: number
  readonly componentDelta: number
  readonly collisionDelta: number
  readonly newDisconnectedPartIds: readonly string[]
  readonly newVirtualColorPartIds: readonly string[]
  readonly failedConstraints: readonly string[]
  readonly stale: boolean
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
  readonly ready: boolean
}

const GROUP_LABELS: Record<ProposalOperationGroup, string> = {
  add: 'Add parts',
  remove: 'Remove parts',
  move: 'Move geometry',
  appearance: 'Appearance and access',
  structure: 'Assembly structure',
  collaboration: 'Builder handoff',
  constraints: 'Design constraints',
  sequence: 'Build sequence',
  project: 'Project metadata',
}

function operationGroup(operation: CadOperation): ProposalOperationGroup {
  if (operation.type === 'part.add') return 'add'
  if (operation.type === 'part.remove') return 'remove'
  if (operation.type === 'part.transform') return 'move'
  if (operation.type === 'part.recolor' || operation.type === 'part.protect') return 'appearance'
  if (operation.type.startsWith('subassembly.') || operation.type === 'part.assign-subassembly') return 'structure'
  if (operation.type.startsWith('note.')) return 'collaboration'
  if (operation.type.startsWith('constraint.')) return 'constraints'
  if (operation.type === 'steps.replace') return 'sequence'
  return 'project'
}

function operationPartIds(operation: CadOperation): string[] {
  if (operation.type === 'part.add') return [operation.part.id]
  if (
    operation.type === 'part.remove'
    || operation.type === 'part.transform'
    || operation.type === 'part.recolor'
    || operation.type === 'part.protect'
    || operation.type === 'part.assign-subassembly'
  ) return [operation.partId]
  if (operation.type === 'subassembly.add') return operation.subassembly.partIds
  if (operation.type === 'note.add') return operation.note.anchorPartIds
  if (operation.type === 'steps.replace') return operation.steps.flatMap((step) => step.partIds)
  return []
}

const unique = (ids: readonly string[]) => [...new Set(ids)]

/**
 * Turn a kernel proposal into a bounded, human-readable review contract.
 *
 * This does not decide whether an edit can commit — `CadEngine.applyProposal`
 * remains authoritative. It exposes the same measured preflight facts so a
 * human and an agent can understand the queue before asking the kernel.
 */
export function summariseProposal(proposal: Proposal, current: EngineSnapshot): ProposalReviewSummary {
  const groups = new Map<ProposalOperationGroup, { count: number; partIds: string[] }>()
  for (const operation of proposal.operations) {
    const id = operationGroup(operation)
    const entry = groups.get(id) ?? { count: 0, partIds: [] }
    entry.count += 1
    entry.partIds.push(...operationPartIds(operation))
    groups.set(id, entry)
  }

  const affectedPartIds = unique(proposal.operations.flatMap(operationPartIds))
  const addedPartIds = proposal.operations
    .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
    .map((operation) => operation.part.id)
  const removedPartIds = proposal.operations
    .filter((operation): operation is Extract<CadOperation, { type: 'part.remove' }> => operation.type === 'part.remove')
    .map((operation) => operation.partId)
  const currentDisconnected = new Set(current.validation.disconnectedPartIds)
  const currentVirtual = new Set(current.validation.virtualColors.map((item) => item.partId))
  const newDisconnectedPartIds = proposal.validation.disconnectedPartIds.filter((id) => !currentDisconnected.has(id))
  const newVirtualColorPartIds = proposal.validation.virtualColors
    .map((item) => item.partId)
    .filter((id) => !currentVirtual.has(id))
  const failedConstraints = proposal.validation.constraints
    .filter((constraint) => constraint.status === 'fail')
    .map((constraint) => constraint.label)
  const stale = proposal.baseRevision !== current.document.revision

  const blockers = [
    ...(stale ? [`Based on r${proposal.baseRevision}; the document is now r${current.document.revision}.`] : []),
    ...(proposal.validation.collisions.length
      ? [`${proposal.validation.collisions.length} collision${proposal.validation.collisions.length === 1 ? '' : 's'} in the preview.`]
      : []),
    ...(newDisconnectedPartIds.length
      ? [`${newDisconnectedPartIds.length} newly disconnected part${newDisconnectedPartIds.length === 1 ? '' : 's'}.`]
      : []),
    ...failedConstraints.map((label) => `Constraint failed: ${label}.`),
  ]
  const warnings = [
    ...(proposal.validation.unverifiedCollisions
      ? [`${proposal.validation.unverifiedCollisions} collision verdict${proposal.validation.unverifiedCollisions === 1 ? '' : 's'} use bounds-only evidence.`]
      : []),
    ...(newVirtualColorPartIds.length
      ? [`${newVirtualColorPartIds.length} new virtual colour${newVirtualColorPartIds.length === 1 ? '' : 's'}.`]
      : []),
  ]

  return {
    affectedPartIds,
    selectablePartIds: affectedPartIds.filter((id) => Boolean(current.document.parts[id])),
    addedPartIds,
    removedPartIds,
    groups: [...groups].map(([id, entry]) => ({
      id,
      label: GROUP_LABELS[id],
      count: entry.count,
      partIds: unique(entry.partIds),
    })),
    partDelta: proposal.validation.partCount - current.validation.partCount,
    connectionDelta: proposal.validation.connectionCount - current.validation.connectionCount,
    componentDelta: proposal.validation.componentCount - current.validation.componentCount,
    collisionDelta: proposal.validation.collisions.length - current.validation.collisions.length,
    newDisconnectedPartIds,
    newVirtualColorPartIds,
    failedConstraints,
    stale,
    blockers,
    warnings,
    ready: blockers.length === 0,
  }
}
