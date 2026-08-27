import { catalog, searchCatalog } from './catalog'
import { jointFor } from './connections'
import { cleanBasis, isOrthonormal, orthonormalize, type RigidTransform } from './math'
import { deriveConnections } from './snapping'
import { createEmptyDocument, createShowcaseDocument } from './sample'
import { loadLocalDocument } from './storage'
import { validateDocument } from './validation'
import type {
  Actor,
  AutonomyMode,
  CadOperation,
  ConnectionEdge,
  CatalogSearchQuery,
  CatalogSearchRecord,
  CommandResult,
  EngineErrorShape,
  EngineSnapshot,
  ModelDocument,
  Proposal,
  Transaction,
} from './types'

interface HistoryEntry {
  before: ModelDocument
  after: ModelDocument
  transaction: Transaction
}

const clone = <T,>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()
const makeId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

function error(code: EngineErrorShape['code'], message: string, repair: string, details?: unknown): CommandResult<never> {
  return { ok: false, error: { code, message, repair, details } }
}

function affectedPartIds(operations: CadOperation[]) {
  return Array.from(
    new Set(
      operations.flatMap((operation) => {
        if (operation.type === 'part.add') return [operation.part.id]
        if ('partId' in operation) return [operation.partId]
        if (operation.type === 'note.add') return operation.note.anchorPartIds
        return []
      }),
    ),
  )
}

/**
 * Kernel invariant: a stored basis is orthonormal and free of float dust.
 *
 * Enforcing this on ingest rather than trusting callers keeps exported LDraw
 * matrices stable, makes transform comparison and content hashing meaningful,
 * and means a slightly-off matrix supplied by an agent is corrected once
 * instead of shearing the part on every later composition.
 */
function normalizeTransform(transform: RigidTransform): RigidTransform {
  const basis = isOrthonormal(transform.basis, 1e-12) ? transform.basis : orthonormalize(transform.basis)
  return { position: transform.position, basis: cleanBasis(basis) }
}

/** Applies the transform invariant across a whole document on ingest. */
function normalizeDocument(document: ModelDocument): ModelDocument {
  for (const part of Object.values(document.parts)) {
    part.transform = normalizeTransform(part.transform)
  }
  return document
}

/** Deterministic id for an edge, from its two endpoints. */
const edgeId = (a: string, b: string) => `edge_${[a, b].sort().join('__')}`

/**
 * Rewrites the document's connection edges from the current geometry.
 *
 * Edges are persisted rather than re-inferred on demand so the structural graph
 * survives save, load and export, and so each edge can carry its joint freedom
 * and provenance. An edge that still exists keeps its original revision and
 * source, so "when did this connection appear, and who made it" stays answerable
 * across later transactions.
 */
function syncConnections(document: ModelDocument, revision: number, source: ConnectionEdge['source']): void {
  const world = deriveConnections(document)
  const previous = document.connections ?? {}
  const next: Record<string, ConnectionEdge> = {}
  for (const pair of world.pairs) {
    const endpointA = `${pair.a.partId}/${pair.a.id}`
    const endpointB = `${pair.b.partId}/${pair.b.id}`
    const id = edgeId(endpointA, endpointB)
    const existing = previous[id]
    next[id] = existing ?? {
      id,
      a: { partId: pair.a.partId, featureId: pair.a.id },
      b: { partId: pair.b.partId, featureId: pair.b.id },
      family: pair.a.family,
      joint: jointFor(pair.a.feature, pair.b.feature),
      createdAtRevision: revision,
      source,
    }
  }
  document.connections = next
}

function isPartProtected(document: ModelDocument, partId: string): boolean {
  const part = document.parts[partId]
  if (!part) return false
  return part.protected || Boolean(document.subassemblies[part.subassemblyId]?.locked)
}

/**
 * Colour policy.
 *
 * An LDraw colour that no official set pairs with this part is a *virtual*
 * colour: legal to build, legal to export, and reported as such by validation.
 * It only becomes an error when the document carries a hard palette constraint,
 * because then the operator has explicitly asked for production-real colours.
 */
function checkColor(
  document: ModelDocument,
  availableColors: number[],
  color: number,
): CommandResult<never> | null {
  if (!catalog.hasColor(color)) {
    return error(
      'COLOR_UNAVAILABLE',
      `LDraw colour ${color} is not defined in the compiled colour table.`,
      'Choose a colour code from the LDraw colour table returned by workspace_get.',
    )
  }
  const palette = document.constraints.find((constraint) => constraint.kind === 'palette' && constraint.hard)
  if (palette && Array.isArray(palette.value) && !(palette.value as number[]).includes(color)) {
    return error(
      'COLOR_UNAVAILABLE',
      `Colour ${color} is outside the hard palette constraint “${palette.label}”.`,
      'Use one of the constrained palette colours, or ask the operator to relax the constraint.',
      { allowed: palette.value, availableColors },
    )
  }
  return null
}

function validateOperations(document: ModelDocument, operations: CadOperation[], actor: Actor): CommandResult<true> {
  for (const operation of operations) {
    if (operation.type === 'part.add') {
      const definition = catalog.get(operation.part.definitionId)
      if (!definition) {
        const identity = catalog.describe(operation.part.definitionId)
        if (identity) {
          return error(
            'GEOMETRY_UNAVAILABLE',
            `Part ${identity.id} (${identity.name}) exists in catalog ${document.catalogVersion} but has no compiled geometry in this build.`,
            'Call catalog_search with requireGeometry=true and choose a part that can be placed.',
            { canonicalId: identity.id, category: identity.category },
          )
        }
        return error(
          'PART_DEFINITION_NOT_FOUND',
          `Part definition ${operation.part.definitionId} does not exist in catalog ${document.catalogVersion}.`,
          'Call catalog_search, then retry with a returned definition id.',
        )
      }
      const colorCheck = checkColor(document, definition.availableColors, operation.part.color)
      if (colorCheck) return colorCheck
      if (document.parts[operation.part.id]) {
        return error('INVALID_OPERATION', `Part id ${operation.part.id} already exists.`, 'Generate a fresh stable part id.')
      }
      if (actor === 'agent' && document.subassemblies[operation.part.subassemblyId]?.locked) {
        return error(
          'PROTECTED_REGION',
          `Subassembly ${operation.part.subassemblyId} is locked.`,
          'Modify an unlocked subassembly or build around the protected region.',
        )
      }
    }
    if ('partId' in operation) {
      if (!document.parts[operation.partId]) {
        return error('PART_NOT_FOUND', `Part ${operation.partId} is not present at revision ${document.revision}.`, 'Reread the scene region and retry.')
      }
      if (actor === 'agent' && isPartProtected(document, operation.partId)) {
        const region = document.subassemblies[document.parts[operation.partId].subassemblyId]?.name ?? 'protected selection'
        return error(
          'PROTECTED_REGION',
          `Part ${operation.partId} belongs to locked region “${region}”.`,
          'Modify an unlocked region or leave the protected geometry unchanged.',
          { partId: operation.partId, region },
        )
      }
    }
    if (operation.type === 'part.recolor') {
      const part = document.parts[operation.partId]
      const definition = part ? catalog.get(part.definitionId) : undefined
      if (definition) {
        const colorCheck = checkColor(document, definition.availableColors, operation.color)
        if (colorCheck) return colorCheck
      }
    }
    if (operation.type === 'part.assign-subassembly' && !document.subassemblies[operation.subassemblyId]) {
      return error('INVALID_OPERATION', `Subassembly ${operation.subassemblyId} does not exist.`, 'Create the subassembly first or choose an existing unlocked subassembly.')
    }
    if (operation.type === 'part.assign-subassembly' && actor === 'agent' && document.subassemblies[operation.subassemblyId]?.locked) {
      return error('PROTECTED_REGION', `Subassembly ${operation.subassemblyId} is locked.`, 'Assign the part to an unlocked subassembly.')
    }
    if (operation.type === 'subassembly.add' && document.subassemblies[operation.subassembly.id]) {
      return error('INVALID_OPERATION', `Subassembly ${operation.subassembly.id} already exists.`, 'Choose a new stable subassembly id.')
    }
    if (operation.type === 'note.respond' && !document.notes.some((note) => note.id === operation.noteId)) {
      return error('INVALID_OPERATION', `Builder note ${operation.noteId} does not exist.`, 'Call builder_feedback_get and respond to a current note id.')
    }
  }
  return { ok: true, value: true }
}

function applyOperationsTo(document: ModelDocument, operations: CadOperation[], actor: Actor): ModelDocument {
  const next = clone(document)
  for (const operation of operations) {
    switch (operation.type) {
      case 'part.add': {
        next.parts[operation.part.id] = { ...clone(operation.part), transform: normalizeTransform(operation.part.transform) }
        const subassembly = next.subassemblies[operation.part.subassemblyId]
        if (subassembly && !subassembly.partIds.includes(operation.part.id)) subassembly.partIds.push(operation.part.id)
        const step = next.steps.find((candidate) => candidate.id === operation.part.stepId)
        if (step && !step.partIds.includes(operation.part.id)) step.partIds.push(operation.part.id)
        break
      }
      case 'part.remove': {
        const removed = next.parts[operation.partId]
        if (removed) {
          const subassembly = next.subassemblies[removed.subassemblyId]
          if (subassembly) subassembly.partIds = subassembly.partIds.filter((id) => id !== removed.id)
          const step = next.steps.find((candidate) => candidate.id === removed.stepId)
          if (step) step.partIds = step.partIds.filter((id) => id !== removed.id)
          delete next.parts[removed.id]
        }
        break
      }
      case 'part.transform':
        next.parts[operation.partId].transform = normalizeTransform(operation.transform)
        break
      case 'part.recolor':
        next.parts[operation.partId].color = operation.color
        break
      case 'part.protect':
        next.parts[operation.partId].protected = operation.protected
        break
      case 'part.assign-subassembly': {
        const moved = next.parts[operation.partId]
        const previous = next.subassemblies[moved.subassemblyId]
        if (previous) previous.partIds = previous.partIds.filter((id) => id !== moved.id)
        moved.subassemblyId = operation.subassemblyId
        next.subassemblies[operation.subassemblyId]?.partIds.push(moved.id)
        break
      }
      case 'subassembly.add':
        next.subassemblies[operation.subassembly.id] = clone(operation.subassembly)
        break
      case 'subassembly.lock': {
        const subassembly = next.subassemblies[operation.subassemblyId]
        if (subassembly) subassembly.locked = operation.locked
        break
      }
      case 'note.add':
        next.notes.push(clone(operation.note))
        break
      case 'note.respond': {
        const note = next.notes.find((candidate) => candidate.id === operation.noteId)
        if (note) {
          note.response = operation.response
          if (operation.resolved) note.status = 'resolved'
        }
        break
      }
    }
  }
  for (const partId of affectedPartIds(operations)) {
    if (next.parts[partId]) next.parts[partId].provenance = actor
  }
  return next
}

export class CadEngine {
  private document: ModelDocument
  private transactions: Transaction[] = []
  private proposals = new Map<string, Proposal>()
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private listeners = new Set<() => void>()
  private autonomy: AutonomyMode = 'propose'
  private selection: string[] = []
  private snapshot: EngineSnapshot

  constructor(initialDocument: ModelDocument = createShowcaseDocument()) {
    this.document = normalizeDocument(clone(initialDocument))
    syncConnections(this.document, this.document.revision, 'import-inferred')
    this.snapshot = this.buildSnapshot()
  }

  private buildSnapshot(): EngineSnapshot {
    return {
      document: this.document,
      transactions: this.transactions,
      proposals: Array.from(this.proposals.values()),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      autonomy: this.autonomy,
      validation: validateDocument(this.document),
      selection: this.selection,
    }
  }

  private emit() {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  getDocument = () => clone(this.document)

  getCatalog(query: CatalogSearchQuery = {}): CatalogSearchRecord[] {
    return searchCatalog(query)
  }

  setSelection(ids: string[]) {
    this.selection = ids.filter((id, index) => Boolean(this.document.parts[id]) && ids.indexOf(id) === index)
    this.emit()
  }

  setAutonomy(mode: AutonomyMode) {
    this.autonomy = mode
    this.emit()
  }

  replaceDocument(document: ModelDocument) {
    this.document = normalizeDocument(clone(document))
    // An imported or restored document has no recorded edges, so its graph is
    // inferred once and marked as such.
    syncConnections(this.document, this.document.revision, 'import-inferred')
    this.transactions = []
    this.proposals.clear()
    this.undoStack = []
    this.redoStack = []
    this.selection = []
    this.emit()
  }

  newDocument() {
    this.replaceDocument(createEmptyDocument())
  }

  execute(
    label: string,
    operations: CadOperation[],
    actor: Actor,
    expectedRevision = this.document.revision,
    sourceTool?: string,
  ): CommandResult<Transaction> {
    if (actor === 'agent' && this.autonomy !== 'build') {
      return error('READ_ONLY_MODE', `Agent writes are disabled in ${this.autonomy} mode.`, 'Switch to Build mode or create a proposal instead.')
    }
    if (expectedRevision !== this.document.revision) {
      return error(
        'STALE_DOCUMENT',
        `Expected revision ${expectedRevision}; current revision is ${this.document.revision}.`,
        'Reread the changed region and re-plan against the current revision.',
        { expectedRevision, currentRevision: this.document.revision },
      )
    }
    const precondition = validateOperations(this.document, operations, actor)
    if (!precondition.ok) return precondition

    const before = clone(this.document)
    const after = applyOperationsTo(this.document, operations, actor)
    if (actor === 'agent') {
      const beforeReport = validateDocument(this.document)
      const afterReport = validateDocument(after)
      if (afterReport.collisions.length > beforeReport.collisions.length) {
        return error(
          'COLLISION',
          `Agent transaction would introduce ${afterReport.collisions.length - beforeReport.collisions.length} collision${afterReport.collisions.length - beforeReport.collisions.length === 1 ? '' : 's'}.`,
          'Run build_preflight, inspect the collision entities, and choose another snap candidate.',
          afterReport.collisions,
        )
      }
    }
    const transactionId = makeId('txn')
    after.revision = this.document.revision + 1
    after.updatedAt = now()
    syncConnections(after, after.revision, 'snap')
    for (const partId of affectedPartIds(operations)) {
      if (after.parts[partId]) after.parts[partId].createdByTransaction = transactionId
    }
    const transaction: Transaction = {
      id: transactionId,
      author: actor,
      label,
      baseRevision: this.document.revision,
      resultRevision: after.revision,
      timestamp: now(),
      operations: clone(operations),
      affectedPartIds: affectedPartIds(operations),
      sourceTool,
      kind: 'edit',
    }
    this.document = after
    this.transactions = [...this.transactions, transaction]
    this.undoStack.push({ before, after: clone(after), transaction })
    this.redoStack = []
    this.proposals.clear()
    this.selection = this.selection.filter((id) => Boolean(after.parts[id]))
    this.emit()
    return { ok: true, value: transaction }
  }

  preflight(
    label: string,
    operations: CadOperation[],
    actor: Actor,
    expectedRevision = this.document.revision,
  ): CommandResult<Proposal> {
    if (expectedRevision !== this.document.revision) {
      return error(
        'STALE_DOCUMENT',
        `Expected revision ${expectedRevision}; current revision is ${this.document.revision}.`,
        'Reread the workspace and run preflight again.',
      )
    }
    const precondition = validateOperations(this.document, operations, actor)
    if (!precondition.ok) return precondition
    const preview = applyOperationsTo(this.document, operations, actor)
    preview.revision = this.document.revision + 1
    preview.updatedAt = now()
    syncConnections(preview, preview.revision, 'snap')
    const proposal: Proposal = {
      id: makeId('proposal'),
      label,
      author: actor,
      baseRevision: this.document.revision,
      createdAt: now(),
      operations: clone(operations),
      previewDocument: preview,
      validation: validateDocument(preview),
      status: 'pending',
    }
    this.proposals.set(proposal.id, proposal)
    this.emit()
    return { ok: true, value: proposal }
  }

  applyProposal(proposalId: string, actor: Actor = 'human'): CommandResult<Transaction> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) return error('PROPOSAL_NOT_FOUND', `Proposal ${proposalId} does not exist.`, 'List current proposals and retry.')
    if (proposal.baseRevision !== this.document.revision) {
      return error(
        'PROPOSAL_STALE',
        `Proposal ${proposalId} was based on revision ${proposal.baseRevision}; current revision is ${this.document.revision}.`,
        'Discard this proposal and preflight it again against the current document.',
      )
    }
    if (proposal.validation.collisions.length) {
      return error(
        'COLLISION',
        `${proposal.validation.collisions.length} collision${proposal.validation.collisions.length === 1 ? '' : 's'} found in proposal ${proposalId}.`,
        'Choose another snap candidate or move the colliding part by at least 8 LDU.',
        proposal.validation.collisions,
      )
    }
    const priorAutonomy = this.autonomy
    if (actor === 'agent') this.autonomy = 'build'
    const result = this.execute(proposal.label, proposal.operations, actor, proposal.baseRevision, 'build_apply')
    this.autonomy = priorAutonomy
    if (result.ok) proposal.status = 'applied'
    this.proposals.delete(proposalId)
    this.emit()
    return result
  }

  rejectProposal(proposalId: string): CommandResult<Proposal> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) return error('PROPOSAL_NOT_FOUND', `Proposal ${proposalId} does not exist.`, 'List current proposals and retry.')
    proposal.status = 'rejected'
    this.proposals.delete(proposalId)
    this.emit()
    return { ok: true, value: proposal }
  }

  undo(actor: Actor = 'human'): CommandResult<Transaction> {
    const entry = this.undoStack.at(-1)
    if (!entry) return error('INVALID_OPERATION', 'There is no transaction to undo.', 'Continue building or choose a named checkpoint.')
    if (actor === 'agent' && entry.transaction.affectedPartIds.some((partId) => isPartProtected(this.document, partId))) {
      return error('PROTECTED_REGION', 'The latest transaction affects a currently protected region.', 'Ask the human to undo it or continue in an unlocked region.')
    }
    this.undoStack.pop()
    const baseRevision = this.document.revision
    const restored = clone(entry.before)
    restored.revision = baseRevision + 1
    restored.updatedAt = now()
    const transaction: Transaction = {
      id: makeId('txn'),
      author: actor,
      label: `Undo: ${entry.transaction.label}`,
      baseRevision,
      resultRevision: restored.revision,
      timestamp: now(),
      operations: clone(entry.transaction.operations),
      affectedPartIds: entry.transaction.affectedPartIds,
      sourceTool: actor === 'agent' ? 'undo_edit' : undefined,
      kind: 'undo',
    }
    this.document = restored
    this.redoStack.push(entry)
    this.transactions = [...this.transactions, transaction]
    this.proposals.clear()
    this.emit()
    return { ok: true, value: transaction }
  }

  redo(actor: Actor = 'human'): CommandResult<Transaction> {
    const entry = this.redoStack.at(-1)
    if (!entry) return error('INVALID_OPERATION', 'There is no transaction to redo.', 'Undo a transaction first.')
    if (actor === 'agent' && entry.transaction.affectedPartIds.some((partId) => isPartProtected(entry.after, partId))) {
      return error('PROTECTED_REGION', 'The redo transaction affects a protected region.', 'Ask the human to redo it or continue in an unlocked region.')
    }
    this.redoStack.pop()
    const baseRevision = this.document.revision
    const restored = clone(entry.after)
    restored.revision = baseRevision + 1
    restored.updatedAt = now()
    const transaction: Transaction = {
      id: makeId('txn'),
      author: actor,
      label: `Redo: ${entry.transaction.label}`,
      baseRevision,
      resultRevision: restored.revision,
      timestamp: now(),
      operations: clone(entry.transaction.operations),
      affectedPartIds: entry.transaction.affectedPartIds,
      sourceTool: actor === 'agent' ? 'redo_edit' : undefined,
      kind: 'redo',
    }
    this.document = restored
    this.undoStack.push(entry)
    this.transactions = [...this.transactions, transaction]
    this.proposals.clear()
    this.emit()
    return { ok: true, value: transaction }
  }
}

export const cadEngine = new CadEngine(loadLocalDocument() ?? createShowcaseDocument())

export const commandBus = {
  dispatch: (
    label: string,
    operations: CadOperation[],
    actor: Actor,
    expectedRevision?: number,
    sourceTool?: string,
  ) => cadEngine.execute(label, operations, actor, expectedRevision, sourceTool),
  preflight: (label: string, operations: CadOperation[], actor: Actor, expectedRevision?: number) =>
    cadEngine.preflight(label, operations, actor, expectedRevision),
}
