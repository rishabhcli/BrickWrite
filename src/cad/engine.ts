import { catalog, searchCatalog } from './catalog'
import { jointFor } from './connections'
import { createId } from './ids'
import { cleanBasis, isOrthonormal, orthonormalize, type RigidTransform } from './math'
import { applyMutations, invertMutations, mutationsForOperations, touchedBy, type DocumentPatch, type EntityMutation } from './patch'
import {
  connectionEdgeId as edgeId,
  deriveConnections,
  IncrementalConnectorWorld,
  jointOverrideIndex,
  type MatedPair,
} from './snapping'
import { createBlankDocument, createEmptyDocument } from './sample'
import { introducedCollisions } from './collisionGate'
import {
  adjacencyFromRecordedEdges,
  evaluateConstraints,
  floatingPartIds,
  hoverVerdictFor,
  restCodeForSupport,
  unclutchedRestCode,
  unclutchedRestPartIds,
  validateDocument,
} from './validation'
import type {
  Actor,
  AutonomyMode,
  CadOperation,
  ConnectionEdge,
  Constraint,
  ValidationReport,
  CatalogSearchQuery,
  CatalogSearchRecord,
  CommandResult,
  EngineErrorShape,
  EngineSnapshot,
  ModelDocument,
  PartInstance,
  Proposal,
  Transaction,
} from './types'

const clone = <T,>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()

function error(code: EngineErrorShape['code'], message: string, repair: string, details?: unknown): CommandResult<never> {
  return { ok: false, error: { code, message, repair, details } }
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
  // The incremental path has to honour asserted freedoms exactly as the bulk
  // derivation does, or a winch would revert to a plain axle the next time a
  // part near it moved.
  const overrides = jointOverrideIndex(document)

  const edgeFor = (pair: MatedPair): ConnectionEdge => {
    const id = edgeId(`${pair.a.partId}/${pair.a.id}`, `${pair.b.partId}/${pair.b.id}`)
    return {
      id,
      a: { partId: pair.a.partId, featureId: pair.a.id },
      b: { partId: pair.b.partId, featureId: pair.b.id },
      family: pair.a.family,
      joint: overrides.get(id) ?? jointFor(pair.a.feature, pair.b.feature),
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
    // Iterated by key rather than through `Object.entries`, which allocates a
    // two-element array per edge: the campus demo carries 26,496 of them and
    // this scan runs on every commit.
    for (const id in previous) {
      const edge = previous[id]
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
  for (const id in previous) {
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
  document: Pick<ModelDocument, 'constraints'>,
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

/**
 * The batch's view of the part table, as an overlay rather than a copy.
 *
 * `validateOperations` has to see the batch's own earlier operations — add then
 * recolour is one legal command — which it did by loading every part into a
 * `Map` on entry. That is 2.8 ms of pure setup per commit on the 11,493-part
 * campus demo, to support a batch that usually touches one part.
 *
 * `null` in the overlay records a removal, which is what distinguishes "not
 * written by this batch" (`undefined`) from "deleted by this batch".
 */
class PartOverlay {
  private readonly written = new Map<string, PartInstance | null>()

  constructor(private readonly base: Readonly<Record<string, PartInstance>>) {}

  has(id: string): boolean {
    const written = this.written.get(id)
    return written === undefined ? this.base[id] !== undefined : written !== null
  }

  get(id: string): PartInstance | undefined {
    const written = this.written.get(id)
    if (written !== undefined) return written ?? undefined
    return this.base[id]
  }

  set(id: string, value: PartInstance) {
    this.written.set(id, value)
  }

  delete(id: string) {
    this.written.set(id, null)
  }

  /** Only `steps.replace` needs this, so the base count is walked on demand. */
  get size(): number {
    let count = Object.keys(this.base).length
    for (const [id, value] of this.written) {
      const inBase = this.base[id] !== undefined
      if (value === null && inBase) count -= 1
      else if (value !== null && !inBase) count += 1
    }
    return count
  }
}

function validateOperations(document: ModelDocument, operations: CadOperation[], actor: Actor): CommandResult<true> {
  // Validate in operation order, just like the patch builder applies the batch.
  // This permits add→recolor and add-subassembly→assign in one atomic command
  // while still rejecting references to entities that have not been created yet.
  const parts = new PartOverlay(document.parts)
  const subassemblies = new Map(Object.entries(document.subassemblies))
  const noteIds = new Set(document.notes.map((note) => note.id))
  const constraints = new Map(document.constraints.map((constraint) => [constraint.id, constraint]))
  const modules = new Map((document.modules ?? []).map((module) => [module.id, module]))

  const activeConstraints = () => ({ constraints: [...constraints.values()] })

  const validateConstraint = (constraint: Constraint): CommandResult<true> => {
    if (!constraint.id.trim() || constraint.id.length > 80) {
      return error('INVALID_OPERATION', 'Constraint ids must contain 1–80 characters.', 'Use a stable, concise constraint id.')
    }
    if (!constraint.label.trim() || constraint.label.trim().length > 120) {
      return error('INVALID_OPERATION', 'Constraint labels must contain 1–120 characters.', 'Describe the design limit concisely.')
    }
    if (constraint.kind === 'piece-count') {
      const maximum = Number(constraint.value)
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100_000) {
        return error('INVALID_OPERATION', 'Piece-count constraints must be integers between 1 and 100,000.', 'Choose a positive, bounded piece budget.')
      }
    }
    if (constraint.kind === 'dimensions') {
      const value = constraint.value as { width?: unknown; depth?: unknown; height?: unknown } | null
      const dimensions = [value?.width, value?.depth, ...(value?.height === undefined ? [] : [value.height])].map(Number)
      if (!value || dimensions.length < 2 || dimensions.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
        return error('INVALID_OPERATION', 'Dimension constraints need positive finite width and depth, plus an optional height.', 'Send dimensions in studs as { width, depth, height? }.')
      }
    }
    if (constraint.kind === 'palette') {
      const colors = Array.isArray(constraint.value) ? constraint.value.map(Number) : []
      if (!colors.length || colors.length > 64 || colors.some((color) => !Number.isInteger(color) || !catalog.hasColor(color))) {
        return error('COLOR_UNAVAILABLE', 'Palette constraints need 1–64 defined LDraw colour codes.', 'Choose colour codes returned by workspace_get or the project palette.')
      }
    }
    if (constraint.kind === 'locked-region') {
      const subassemblyId = String(constraint.value ?? '')
      if (!subassemblies.has(subassemblyId)) {
        return error('INVALID_OPERATION', `Locked-region constraint references missing subassembly ${subassemblyId || '(empty)'}.`, 'Choose a current subassembly id.')
      }
    }
    return { ok: true, value: true }
  }

  for (const operation of operations) {
    if (operation.type === 'document.rename' && (!operation.name.trim() || operation.name.trim().length > 120)) {
      return error('INVALID_OPERATION', 'Document names must contain 1–120 characters.', 'Choose a concise non-empty project name.')
    }
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
      const colorCheck = checkColor(activeConstraints(), definition.availableColors, operation.part.color)
      if (colorCheck) return colorCheck
      if (parts.has(operation.part.id)) {
        return error('INVALID_OPERATION', `Part id ${operation.part.id} already exists.`, 'Generate a fresh stable part id.')
      }
      const destination = subassemblies.get(operation.part.subassemblyId)
      if (!destination) {
        return error('INVALID_OPERATION', `Subassembly ${operation.part.subassemblyId} does not exist.`, 'Create the subassembly earlier in the same batch or choose a current one.')
      }
      if (!document.steps.some((step) => step.id === operation.part.stepId)) {
        return error('INVALID_OPERATION', `Build step ${operation.part.stepId} does not exist.`, 'Choose a current build step id.')
      }
      if (actor === 'agent' && destination.locked) {
        return error(
          'PROTECTED_REGION',
          `Subassembly ${operation.part.subassemblyId} is locked.`,
          'Modify an unlocked subassembly or build around the protected region.',
        )
      }
      parts.set(operation.part.id, operation.part)
    }
    if ('partId' in operation) {
      const part = parts.get(operation.partId)
      if (!part) {
        return error('PART_NOT_FOUND', `Part ${operation.partId} is not present at revision ${document.revision}.`, 'Reread the scene region and retry.')
      }
      if (actor === 'agent' && (part.protected || subassemblies.get(part.subassemblyId)?.locked)) {
        const region = subassemblies.get(part.subassemblyId)?.name ?? 'protected selection'
        return error(
          'PROTECTED_REGION',
          `Part ${operation.partId} belongs to locked region “${region}”.`,
          'Modify an unlocked region or leave the protected geometry unchanged.',
          { partId: operation.partId, region },
        )
      }
    }
    if (operation.type === 'part.recolor') {
      const part = parts.get(operation.partId)
      const definition = part ? catalog.get(part.definitionId) : undefined
      if (definition) {
        const colorCheck = checkColor(activeConstraints(), definition.availableColors, operation.color)
        if (colorCheck) return colorCheck
      }
    }
    if (operation.type === 'part.assign-subassembly') {
      const destination = subassemblies.get(operation.subassemblyId)
      if (!destination) {
        return error('INVALID_OPERATION', `Subassembly ${operation.subassemblyId} does not exist.`, 'Create the subassembly earlier in the same batch or choose an existing unlocked subassembly.')
      }
      if (actor === 'agent' && destination.locked) {
        return error('PROTECTED_REGION', `Subassembly ${operation.subassemblyId} is locked.`, 'Assign the part to an unlocked subassembly.')
      }
      const part = parts.get(operation.partId)
      if (part) parts.set(part.id, { ...part, subassemblyId: operation.subassemblyId })
    }
    if (operation.type === 'part.remove') parts.delete(operation.partId)
    if (operation.type === 'subassembly.add') {
      if (subassemblies.has(operation.subassembly.id)) {
        return error('INVALID_OPERATION', `Subassembly ${operation.subassembly.id} already exists.`, 'Choose a new stable subassembly id.')
      }
      if (!operation.subassembly.name.trim() || operation.subassembly.name.trim().length > 80) {
        return error('INVALID_OPERATION', 'Subassembly names must contain 1–80 characters.', 'Choose a concise non-empty subassembly name.')
      }
      if (!/^#[0-9a-f]{6}$/i.test(operation.subassembly.accent)) {
        return error('INVALID_OPERATION', 'Subassembly accents must be six-digit hexadecimal colours.', 'Send an accent such as #e79032.')
      }
      subassemblies.set(operation.subassembly.id, operation.subassembly)
    }
    if (operation.type === 'subassembly.rename') {
      const subassembly = subassemblies.get(operation.subassemblyId)
      if (!subassembly) {
        return error('INVALID_OPERATION', `Subassembly ${operation.subassemblyId} does not exist.`, 'Choose a current subassembly id.')
      }
      if (!operation.name.trim() || operation.name.trim().length > 80) {
        return error('INVALID_OPERATION', 'Subassembly names must contain 1–80 characters.', 'Choose a concise non-empty subassembly name.')
      }
      if (actor === 'agent' && subassembly.locked) {
        return error('PROTECTED_REGION', `Subassembly ${operation.subassemblyId} is locked.`, 'Rename an unlocked subassembly or ask the human to unlock it.')
      }
      subassemblies.set(subassembly.id, { ...subassembly, name: operation.name.trim() })
    }
    if (operation.type === 'subassembly.lock') {
      const subassembly = subassemblies.get(operation.subassemblyId)
      if (!subassembly) {
        return error('INVALID_OPERATION', `Subassembly ${operation.subassemblyId} does not exist.`, 'Choose a current subassembly id.')
      }
      if (actor === 'agent' && subassembly.locked && !operation.locked) {
        return error('PROTECTED_REGION', `Subassembly ${operation.subassemblyId} is locked by the human.`, 'Ask the human to unlock it or work elsewhere.')
      }
      subassemblies.set(subassembly.id, { ...subassembly, locked: operation.locked })
    }
    if (operation.type === 'constraint.set') {
      const checked = validateConstraint(operation.constraint)
      if (!checked.ok) return checked
      constraints.set(operation.constraint.id, operation.constraint)
    }
    if (operation.type === 'constraint.remove') {
      if (!constraints.has(operation.constraintId)) {
        return error('INVALID_OPERATION', `Constraint ${operation.constraintId} does not exist.`, 'Choose a current constraint id.')
      }
      constraints.delete(operation.constraintId)
    }
    if (operation.type === 'module.define') {
      if (!operation.module.parts.length) {
        return error('INVALID_OPERATION', `Module ${operation.module.name} contains no parts.`, 'Capture a module from a selection that holds at least one part.')
      }
      const unplaceable = operation.module.parts.find((entry) => !catalog.get(entry.definitionId))
      if (unplaceable) {
        return error('GEOMETRY_UNAVAILABLE', `Module ${operation.module.name} references ${unplaceable.definitionId}, which has no compiled geometry.`, 'Capture the module from parts this build can place.')
      }
      modules.set(operation.module.id, operation.module)
    }
    if (operation.type === 'module.remove') {
      if (!modules.has(operation.moduleId)) {
        return error('INVALID_OPERATION', `Module ${operation.moduleId} does not exist.`, 'Choose a current module id.')
      }
      modules.delete(operation.moduleId)
    }
    if (operation.type === 'note.add') {
      if (noteIds.has(operation.note.id)) {
        return error('INVALID_OPERATION', `Builder note ${operation.note.id} already exists.`, 'Generate a fresh note id.')
      }
      if (!operation.note.text.trim() || operation.note.text.trim().length > 800) {
        return error('INVALID_OPERATION', 'Builder notes must contain 1–800 characters.', 'Send a concise non-empty note.')
      }
      const missing = operation.note.anchorPartIds.filter((id) => !parts.has(id))
      if (!operation.note.anchorPartIds.length || missing.length) {
        return error('PART_NOT_FOUND', `Builder note anchors must reference current parts${missing[0] ? `; ${missing[0]} is missing` : ''}.`, 'Anchor the note to at least one current part id.')
      }
      noteIds.add(operation.note.id)
    }
    if (operation.type === 'note.respond' && !noteIds.has(operation.noteId)) {
      return error('INVALID_OPERATION', `Builder note ${operation.noteId} does not exist.`, 'Call builder_feedback_get and respond to a current note id.')
    }
    if (operation.type === 'steps.replace') {
      const placed = new Set<string>()
      for (const step of operation.steps) {
        for (const partId of step.partIds) {
          if (!parts.has(partId)) {
            return error('PART_NOT_FOUND', `Build step ${step.id} references missing part ${partId}.`, 'Use only current part ids in the replacement sequence.')
          }
          if (placed.has(partId)) {
            return error('INVALID_OPERATION', `Part ${partId} appears in more than one build step.`, 'Assign every part to exactly one step.')
          }
          placed.add(partId)
        }
      }
      if (placed.size !== parts.size) {
        return error('INVALID_OPERATION', `Build sequence covers ${placed.size} of ${parts.size} parts.`, 'Assign every current part to exactly one step.')
      }
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
  // The index is read *speculatively*: this patch may still be refused by a
  // constraint, a collision or the clutch gate, and an index left holding a
  // refused pose would silently corrupt the next edit's incremental diff. The
  // caller advances it for real once the transaction commits.
  const forward = [
    ...operationMutations,
    ...(connectorWorld
      ? connectorWorld.speculate(document, candidate, touchedPartIds, (world) =>
          connectionMutations(candidate, resultRevision, edgeSource, { world, touchedPartIds }),
        )
      : connectionMutations(candidate, resultRevision, edgeSource)),
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
  private validationByDocument = new WeakMap<ModelDocument, ValidationReport>()
  /** Last report plus what the commit that produced it touched. */
  private lastValidation: { report: ValidationReport; touchedPartIds: readonly string[] } | null = null
  /** Connector index kept alive across revisions for the commit path. */
  private connectorWorld = new IncrementalConnectorWorld()

  constructor(initialDocument: ModelDocument = createBlankDocument()) {
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
    const validationCache = this.validationByDocument
    let computed: ValidationReport | null = validationCache.get(document) ?? null

    const snapshot: EngineSnapshot = {
      document,
      transactions: this.transactions,
      proposals: Array.from(this.proposals.values()),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      autonomy: this.autonomy,
      selection: this.selection,
      get validation() {
        computed ??= validationCache.get(document) ?? null
        if (computed) return computed
        // A commit that reported what it touched only needs its own
        // neighbourhood rechecked; anything else revalidates from scratch.
        computed = validateDocument(
          document,
          touchedPartIds && previous ? { incremental: { previous: previous.report, touchedPartIds } } : {},
        )
        validationCache.set(document, computed)
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
    this.validationByDocument = new WeakMap()
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

    const transactionId = createId('txn')
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

    // A hard constraint is declared design intent, so the kernel enforces it for
    // every actor rather than only for agents. It reads `evaluateConstraints`,
    // not a whole validation report: constraints need the part list and the
    // envelope, and pulling collision work into every commit is what previously
    // made an edit cost as much as a full validation pass. A document that
    // declares no hard constraint skips the gate entirely.
    //
    // Only constraints this transaction leaves *untouched* are enforced against
    // it. Introducing or rewriting one is a declaration of intent, not a
    // violation of it: an operator is allowed to state a target the build has
    // not reached yet, and rewriting is the escape hatch the refusal message
    // points at — which would be a dead end if softening a failing constraint
    // were itself refused.
    const priorHard = new Map(
      this.document.constraints.filter((constraint) => constraint.hard).map((constraint) => [constraint.id, constraint]),
    )
    const unchanged = (constraint: Constraint) => {
      const prior = priorHard.get(constraint.id)
      return prior !== undefined && JSON.stringify(prior) === JSON.stringify(constraint)
    }
    const hardConstraintIds = new Set(
      after.constraints.filter((constraint) => constraint.hard && unchanged(constraint)).map((constraint) => constraint.id),
    )
    if (hardConstraintIds.size) {
      const priorConstraintStatus = new Map(
        evaluateConstraints(this.document).map((constraint) => [constraint.id, constraint.status]),
      )
      // Only a *newly* introduced failure refuses the edit. A constraint that is
      // already failing must not lock the document, or tightening a budget below
      // the current build would make every subsequent repair impossible.
      const introducedHardFailures = evaluateConstraints(after).filter(
        (constraint) =>
          hardConstraintIds.has(constraint.id) &&
          constraint.status === 'fail' &&
          priorConstraintStatus.get(constraint.id) !== 'fail',
      )
      if (introducedHardFailures.length) {
        return error(
          'CONSTRAINT_VIOLATION',
          `Transaction would violate ${introducedHardFailures.length} hard design constraint${introducedHardFailures.length === 1 ? '' : 's'}.`,
          'Adjust the edit, or explicitly soften/remove the constraint before retrying.',
          introducedHardFailures,
        )
      }
    }

    // Confirmed collisions and unconnected unverified overlaps refuse every
    // actor. Mated partners (hinge flaps, stud stacks) may keep an unverified
    // box overlap — blocking those would freeze legal mechanisms. Two buildings
    // on the table are legal LEGO. Undo/redo go through `replay`, not this gate.
    const touched = [...patch.touched.partIds]
    if (touched.length) {
      const placing = operations.some((operation) => operation.type === 'part.add')
      // Both sides' mating clearances come from the connector index this engine
      // keeps across revisions, for the cost of the edit. Without them each side
      // rebuilds the whole connector world — 114 ms on the 11,493-part campus
      // demo, against 0.03 ms for these two scoped reads.
      const beforeMates = this.connectorWorld.scopedMates(this.document, touched)
      const afterMates = this.connectorWorld.speculate(this.document, after, touched, (world) =>
        world.scopedMates(after, touched),
      )
      const introduced = introducedCollisions(this.document, after, touched, { placing, beforeMates, afterMates })
      if (introduced.length) {
        return error(
          'COLLISION',
          `Transaction would introduce ${introduced.length} collision${introduced.length === 1 ? '' : 's'}.`,
          'Place against a different face, or move the colliding part clear of the overlap. An agent should call repair_suggest then preflight_placement.',
          introduced,
        )
      }
    }

    const addedIds = operations.filter((operation) => operation.type === 'part.add').map((operation) => operation.part.id)
    const movedIds = operations.filter((operation) => operation.type === 'part.transform').map((operation) => operation.partId)
    // Walls and storeys are many *adds* in one transaction; their clutch is the
    // planner's job. Every *moved* part is still a brick the operator or agent
    // is dragging — lifting two unconnected bricks into the air, or aligning a
    // brick onto a tile, is not a wall. Hinge flaps stay clutched via the joint.
    const idsToGate = [...movedIds]
    if (addedIds.length === 1 && movedIds.length === 0) idsToGate.push(addedIds[0]!)
    if (idsToGate.length) {
      // The hovering verdicts, asked about the parts this edit moved rather than
      // about every part in the model, and asked against the *recorded*
      // connection graph rather than by re-deriving the connector world.
      //
      // `after` carries the edge mutations this very transaction produced, and
      // `this.document` is the committed graph, so both are current by
      // construction — which is the precondition `adjacencyFromRecordedEdges`
      // states. On the campus demo the four whole-document passes this replaces
      // cost 46 ms plus a 114 ms derivation of a document a microsecond old.
      const beforeAdjacency = adjacencyFromRecordedEdges(this.document)
      const afterAdjacency = adjacencyFromRecordedEdges(after)
      const beforeVerdict = hoverVerdictFor(this.document, idsToGate, beforeAdjacency)
      const afterVerdict = hoverVerdictFor(after, idsToGate, afterAdjacency)
      const beforeFloating = new Set(beforeVerdict.floating)
      const afterFloating = new Set(afterVerdict.floating)
      const beforeRest = new Set(beforeVerdict.unclutchedRests.map((entry) => entry.partId))
      const afterRest = new Map(afterVerdict.unclutchedRests.map((entry) => [entry.partId, entry.supportId]))
      for (const id of idsToGate) {
        if (!beforeFloating.has(id) && afterFloating.has(id)) {
          return error(
            'DISCONNECTED',
            `Transaction would leave ${id} floating with no clutch and no ground under it.`,
            'Mate the part to an existing connector, or rest it on the ground. An already-placed hovering brick is mated with preflight_capability connect_parts — do not invent XYZ.',
            { partIds: [id] },
          )
        }
        if (!beforeRest.has(id) && afterRest.has(id)) {
          const code = restCodeForSupport(after, afterRest.get(id) ?? null)
          return error(
            code,
            `Transaction would rest ${id} on another part without clutching.`,
            code === 'CONNECTOR_OCCUPIED'
              ? 'Every exclusive connector on that face is occupied. Place on the ground, or on a face with free studs.'
              : 'That surface has no free connector that can receive this part. Place on the ground, or on a face with free studs. An agent should call selection_geometry and read approaches before preflight_placement.',
            { partIds: [id] },
          )
        }
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
    // The index tracks the committed document, so it advances here rather than
    // inside `buildPatch`: every gate above can still refuse.
    this.connectorWorld.sync(after, patch.touched.partIds)
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
      createId('preflight'),
      this.document.revision + 1,
      'snap',
    )
    const proposal: Proposal = {
      id: createId('proposal'),
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
        'Choose another snap candidate or move the colliding part by at least 8 LDU. Call repair_suggest, then preflight_placement against a different face.',
        proposal.validation.collisions,
      )
    }
    const liveFloating = new Set(floatingPartIds(this.document))
    const proposalFloating = floatingPartIds(proposal.previewDocument).filter((id) => !liveFloating.has(id))
    if (proposalFloating.length) {
      return error(
        'DISCONNECTED',
        `Proposal ${proposalId} would leave ${proposalFloating.length} part${proposalFloating.length === 1 ? '' : 's'} floating with no clutch and no ground under ${proposalFloating.length === 1 ? 'it' : 'them'}.`,
        'Mate the part to an existing connector with preflight_capability connect_parts, or rest it on the ground. Do not invent XYZ.',
        { partIds: proposalFloating },
      )
    }
    const liveRest = new Set(unclutchedRestPartIds(this.document))
    const proposalRest = unclutchedRestPartIds(proposal.previewDocument).filter((id) => !liveRest.has(id))
    if (proposalRest.length) {
      const code = unclutchedRestCode(proposal.previewDocument, proposalRest[0]!)
      return error(
        code,
        `Proposal ${proposalId} would rest ${proposalRest.length} part${proposalRest.length === 1 ? '' : 's'} on another part without clutching.`,
        code === 'CONNECTOR_OCCUPIED'
          ? 'Every exclusive connector on that face is occupied. Place on the ground, or on a face with free studs.'
          : 'Place on the ground, or on a face with a free compatible connector. Call selection_geometry and read approaches.',
        { partIds: proposalRest },
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
      id: createId('txn'),
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

export const cadEngine = new CadEngine(createBlankDocument())

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
