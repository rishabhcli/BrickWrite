import { catalog, searchCatalog } from './catalog'
import { jointFor } from './connections'
import { cleanBasis, isOrthonormal, orthonormalize, type RigidTransform } from './math'
import { applyMutations, invertMutations, mutationsForOperations, touchedBy, type DocumentPatch, type EntityMutation } from './patch'
import { deriveConnections, IncrementalConnectorWorld, type MatedPair } from './snapping'
import { createEmptyDocument, createShowcaseDocument } from './sample'
import { validateDocument } from './validation'
import type {
  Actor,
  AutonomyMode,
  CadOperation,
  ConnectionEdge,
  ValidationReport,
  CatalogSearchQuery,
  CatalogSearchRecord,
  CommandResult,
  EngineErrorShape,
  EngineSnapshot,
  ModelDocument,
  Proposal,
  Transaction,
} from './types'

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
 * Connection-edge mutations needed to bring the document's recorded graph in
 * line with its geometry.
 *
 * Edges are persisted rather than re-inferred on demand so the structural graph
 * survives save, load and export, and so each edge can carry its joint freedom
 * and provenance. Emitting them as *mutations* rather than writing them directly
 * means they belong to the transaction, so undo removes the connections an edit
 * created along with the edit itself.
 *
 * An edge that still exists keeps its original revision and source, so "when did
 * this connection appear, and who made it" stays answerable across later edits.
 */
function connectionMutations(
  document: ModelDocument,
  revision: number,
  source: ConnectionEdge['source'],
  scope?: { world: IncrementalConnectorWorld; touchedPartIds: readonly string[] },
): EntityMutation[] {
  const previous = document.connections ?? {}
  const mutations: EntityMutation[] = []

  const edgeFor = (pair: MatedPair): ConnectionEdge => {
    const id = edgeId(`${pair.a.partId}/${pair.a.id}`, `${pair.b.partId}/${pair.b.id}`)
    return {
      id,
      a: { partId: pair.a.partId, featureId: pair.a.id },
      b: { partId: pair.b.partId, featureId: pair.b.id },
      family: pair.a.family,
      joint: jointFor(pair.a.feature, pair.b.feature),
      createdAtRevision: revision,
      source,
    }
  }

  if (scope) {
    // Only edges with an endpoint on a touched part can have changed, so the
    // diff is bounded by the edit rather than by the model.
    const touched = new Set(scope.touchedPartIds)
    const live = new Set<string>()
    for (const partId of touched) {
      for (const pair of scope.world.matesFor(partId, document)) {
        const edge = edgeFor(pair)
        live.add(edge.id)
        if (!previous[edge.id]) mutations.push({ kind: 'connection', id: edge.id, value: edge })
      }
    }
    for (const [id, edge] of Object.entries(previous)) {
      const involved = touched.has(edge.a.partId) || touched.has(edge.b.partId)
      if (involved && !live.has(id)) mutations.push({ kind: 'connection', id, value: null })
    }
    return mutations
  }

  const world = deriveConnections(document)
  const live = new Set<string>()
  for (const pair of world.pairs) {
    const edge = edgeFor(pair)
    live.add(edge.id)
    if (!previous[edge.id]) mutations.push({ kind: 'connection', id: edge.id, value: edge })
  }
  for (const id of Object.keys(previous)) {
    if (!live.has(id)) mutations.push({ kind: 'connection', id, value: null })
  }
  return mutations
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

/**
 * Builds a complete transaction patch for a batch of operations.
 *
 * The connection edges the edit implies are derived from the resulting geometry
 * and appended to the same forward list, so the whole change — parts, membership,
 * steps and connections — commits and reverts as one unit.
 */
function buildPatch(
  document: ModelDocument,
  operations: CadOperation[],
  actor: Actor,
  transactionId: string,
  resultRevision: number,
  edgeSource: ConnectionEdge['source'],
  connectorWorld?: IncrementalConnectorWorld,
): { patch: DocumentPatch; document: ModelDocument } {
  const operationMutations = mutationsForOperations(document, operations, actor, transactionId).map(normalizeMutation)
  const candidate = applyMutations(document, operationMutations)
  const touchedPartIds = touchedBy(operationMutations).partIds
  if (connectorWorld) connectorWorld.sync(candidate, touchedPartIds)
  const forward = [
    ...operationMutations,
    ...connectionMutations(
      candidate,
      resultRevision,
      edgeSource,
      connectorWorld ? { world: connectorWorld, touchedPartIds } : undefined,
    ),
  ]
  const inverse = invertMutations(document, forward)
  const next = applyMutations(document, forward)
  next.revision = resultRevision
  next.updatedAt = now()
  return {
    patch: { baseRevision: document.revision, forward, inverse, touched: touchedBy(forward) },
    document: next,
  }
}

/**
 * Fills in a document's connection edges without creating a transaction.
 *
 * Used when a document arrives from outside the command bus — the opening
 * showcase, an import, a restored project — where there is no edit to attribute
 * the edges to.
 */
function seedConnections(document: ModelDocument): ModelDocument {
  const mutations = connectionMutations(document, document.revision, 'import-inferred')
  return mutations.length ? applyMutations(document, mutations) : document
}

/** Applies the transform invariant to any part a mutation writes. */
function normalizeMutation(mutation: EntityMutation): EntityMutation {
  if (mutation.kind !== 'part' || !mutation.value) return mutation
  return { ...mutation, value: { ...mutation.value, transform: normalizeTransform(mutation.value.transform) } }
}

export class CadEngine {
  private document: ModelDocument
  private transactions: Transaction[] = []
  private proposals = new Map<string, Proposal>()
  // History holds transactions, not document copies: each carries its own
  // inverse, so undo costs what the edit cost rather than what the model costs.
  private undoStack: Transaction[] = []
  private redoStack: Transaction[] = []
  private listeners = new Set<() => void>()
  private commitListeners = new Set<(transaction: Transaction, document: ModelDocument) => void>()
  private autonomy: AutonomyMode = 'propose'
  private selection: string[] = []
  private snapshot: EngineSnapshot
  /** Last report plus what the commit that produced it touched. */
  private lastValidation: { report: ValidationReport; touchedPartIds: readonly string[] } | null = null
  /** Connector index kept alive across revisions for the commit path. */
  private connectorWorld = new IncrementalConnectorWorld()

  constructor(initialDocument: ModelDocument = createShowcaseDocument()) {
    this.document = seedConnections(normalizeDocument(clone(initialDocument)))
    this.connectorWorld.sync(this.document)
    this.snapshot = this.buildSnapshot()
  }

  /**
   * Builds the snapshot, deferring validation until something reads it.
   *
   * Validation is the most expensive derived value, and most commits never have
   * theirs observed — a scripted build, an agent batch or a rapid sequence of
   * edits all discard intermediate reports. Computing it eagerly made commit
   * cost scale with model size for no benefit. The getter memoizes, so a
   * consumer that reads it repeatedly pays once.
   */
  private buildSnapshot(touchedPartIds?: readonly string[]): EngineSnapshot {
    const document = this.document
    const previous = this.lastValidation
    let computed: ValidationReport | null = null

    const snapshot: EngineSnapshot = {
      document,
      transactions: this.transactions,
      proposals: Array.from(this.proposals.values()),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      autonomy: this.autonomy,
      selection: this.selection,
      get validation() {
        if (computed) return computed
        // A commit that reported what it touched only needs its own
        // neighbourhood rechecked; anything else revalidates from scratch.
        computed = validateDocument(
          document,
          touchedPartIds && previous ? { incremental: { previous: previous.report, touchedPartIds } } : {},
        )
        return computed
      },
    }
    // Recorded lazily too: the next incremental pass needs whichever report was
    // actually produced, not one computed speculatively.
    Object.defineProperty(snapshot, '__recordValidation', {
      enumerable: false,
      value: () => {
        if (computed) this.lastValidation = { report: computed, touchedPartIds: touchedPartIds ?? [] }
      },
    })
    return snapshot
  }

  private emit(touchedPartIds?: readonly string[]) {
    // Hand the outgoing snapshot's report, if one was produced, to the
    // incremental chain before replacing it.
    ;(this.snapshot as { __recordValidation?: () => void }).__recordValidation?.()
    this.snapshot = this.buildSnapshot(touchedPartIds)
    for (const listener of this.listeners) listener()
  }

  /** Discards cached validation, forcing the next pass to recompute in full. */
  private invalidateValidation() {
    this.lastValidation = null
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Observes committed transactions.
   *
   * Kept separate from `subscribe` so persistence receives the transaction
   * itself — the thing it needs to append to the log — without the kernel taking
   * on any knowledge of storage.
   */
  onCommit = (listener: (transaction: Transaction, document: ModelDocument) => void) => {
    this.commitListeners.add(listener)
    return () => this.commitListeners.delete(listener)
  }

  private announce(transaction: Transaction) {
    for (const listener of this.commitListeners) listener(transaction, this.document)
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
    // An imported or restored document may have no recorded edges, so its graph
    // is inferred once and marked as such.
    this.document = seedConnections(normalizeDocument(clone(document)))
    this.connectorWorld.sync(this.document)
    this.invalidateValidation()
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

    const transactionId = makeId('txn')
    const resultRevision = this.document.revision + 1
    const { patch, document: after } = buildPatch(
      this.document,
      operations,
      actor,
      transactionId,
      resultRevision,
      'snap',
      this.connectorWorld,
    )

    if (actor === 'agent') {
      const beforeReport = validateDocument(this.document)
      const afterReport = validateDocument(after)
      const introduced = afterReport.collisions.length - beforeReport.collisions.length
      if (introduced > 0) {
        return error(
          'COLLISION',
          `Agent transaction would introduce ${introduced} collision${introduced === 1 ? '' : 's'}.`,
          'Run build_preflight, inspect the collision entities, and choose another snap candidate.',
          afterReport.collisions,
        )
      }
    }

    const transaction: Transaction = {
      id: transactionId,
      author: actor,
      label,
      baseRevision: patch.baseRevision,
      resultRevision,
      timestamp: now(),
      operations: clone(operations),
      patch,
      affectedPartIds: [...patch.touched.partIds],
      sourceTool,
      kind: 'edit',
    }

    this.document = after
    this.transactions = [...this.transactions, transaction]
    this.undoStack.push(transaction)
    this.redoStack = []
    this.proposals.clear()
    this.selection = this.selection.filter((id) => Boolean(after.parts[id]))
    this.emit(patch.touched.partIds)
    this.announce(transaction)
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
    const { document: preview } = buildPatch(
      this.document,
      operations,
      actor,
      makeId('preflight'),
      this.document.revision + 1,
      'snap',
    )
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

  /**
   * Reverses the latest transaction by applying its inverse patch.
   *
   * The revision still moves forward — history is append-only, so undo is itself
   * a transaction rather than a rewind. That keeps every agent revision check
   * meaningful: a stale plan cannot become valid again because a human undid
   * something.
   */
  undo(actor: Actor = 'human'): CommandResult<Transaction> {
    const undone = this.undoStack.at(-1)
    if (!undone) {
      return error('INVALID_OPERATION', 'There is no transaction to undo.', 'Continue building or choose a named checkpoint.')
    }
    if (actor === 'agent' && undone.affectedPartIds.some((partId) => isPartProtected(this.document, partId))) {
      return error(
        'PROTECTED_REGION',
        'The latest transaction affects a currently protected region.',
        'Ask the human to undo it or continue in an unlocked region.',
      )
    }
    this.undoStack.pop()
    this.redoStack.push(undone)
    return {
      ok: true,
      value: this.replay(
        undone,
        undone.patch.inverse,
        `Undo: ${undone.label}`,
        'undo',
        actor,
        actor === 'agent' ? 'undo_edit' : undefined,
      ),
    }
  }

  redo(actor: Actor = 'human'): CommandResult<Transaction> {
    const redone = this.redoStack.at(-1)
    if (!redone) return error('INVALID_OPERATION', 'There is no transaction to redo.', 'Undo a transaction first.')
    if (actor === 'agent' && redone.affectedPartIds.some((partId) => isPartProtected(this.document, partId))) {
      return error(
        'PROTECTED_REGION',
        'The redo transaction affects a protected region.',
        'Ask the human to redo it or continue in an unlocked region.',
      )
    }
    this.redoStack.pop()
    this.undoStack.push(redone)
    return {
      ok: true,
      value: this.replay(
        redone,
        redone.patch.forward,
        `Redo: ${redone.label}`,
        'redo',
        actor,
        actor === 'agent' ? 'redo_edit' : undefined,
      ),
    }
  }

  /** Commits a mutation list as a new transaction derived from an existing one. */
  private replay(
    origin: Transaction,
    mutations: readonly EntityMutation[],
    label: string,
    kind: 'undo' | 'redo',
    actor: Actor,
    sourceTool?: string,
  ): Transaction {
    const baseRevision = this.document.revision
    const resultRevision = baseRevision + 1
    const inverse = invertMutations(this.document, mutations)
    const next = applyMutations(this.document, mutations)
    next.revision = resultRevision
    next.updatedAt = now()

    const transaction: Transaction = {
      id: makeId('txn'),
      author: actor,
      label,
      baseRevision,
      resultRevision,
      timestamp: now(),
      operations: clone(origin.operations),
      patch: { baseRevision, forward: [...mutations], inverse, touched: touchedBy(mutations) },
      affectedPartIds: origin.affectedPartIds,
      sourceTool,
      kind,
    }

    this.document = next
    this.connectorWorld.sync(next, transaction.patch.touched.partIds)
    this.transactions = [...this.transactions, transaction]
    this.proposals.clear()
    this.selection = this.selection.filter((id) => Boolean(next.parts[id]))
    this.emit(transaction.patch.touched.partIds)
    this.announce(transaction)
    return transaction
  }
}

export const cadEngine = new CadEngine(createShowcaseDocument())

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
