/**
 * Refinement — the "design doctor".
 *
 * The published surface of workstream 4. Everything here is data: analyses,
 * proposals, metric vectors and overlay instructions. There are no React
 * components, no Three.js objects and no engine mutation outside
 * `applyRefinement`, so the UI workstream renders what this returns and the agent
 * workstream reasons over the same values without either importing the other.
 *
 * The shape of a session:
 *
 *   1. `analyseRegion(document, createScope({ partIds }))` — what is wrong,
 *      located and measured.
 *   2. `proposeRefinements(request, document)` — ranked `RefinementProposalV1[]`.
 *      Mutates nothing; the engine stays at the revision it was found at.
 *   3. `proposal.overlay` — the changed-part heatmap the viewport paints.
 *   4. `applyRefinement(proposal, actor)` — one atomic transaction through
 *      `commandBus`, refused on a stale revision by the kernel itself.
 */

export {
  analyseRegion,
  analysePalette,
  analyseSymmetry,
  createScope,
  findMicroRuns,
  mutablePartIds,
  partsWithinBounds,
  rarityOf,
  RARITY_REFERENCE_FREQUENCY,
  type MicroRun,
  type PaletteEntry,
  type RarityEntry,
  type RegionAnalysis,
  type SymmetryReport,
  type VarietyEntry,
} from './analyse'

export {
  OBJECTIVES,
  objectiveList,
  measureAll,
  deltaOf,
  defaultWeights,
  improvementOf,
  regressionsOf,
  resolveWeights,
  scoreOf,
  MAX_WEIGHT,
  type ObjectiveDefinition,
  type ObjectiveDirection,
  type ObjectiveWeights,
} from './objectives'

export {
  STRATEGIES,
  STRATEGY_IDS,
  strategiesFor,
  strategyById,
  type StrategyEntry,
  type StrategyId,
} from './strategies'

export {
  assertScopeIsolation,
  addedPartIds,
  checkKernelValidity,
  checkProtection,
  checkSilhouette,
  componentsOf,
  guardCandidate,
  heldPartIds,
  modifiedPartIds,
  removedPartIds,
  ScopeViolationError,
  type GuardVerdict,
} from './guards'

export {
  buildCandidateDocument,
  candidateId,
  referenceFor,
  searchRefinements,
  type SearchBudget,
  type SearchCandidate,
  type SearchOptions,
  type SearchRejection,
  type SearchReport,
  type SearchResult,
} from './search'

export {
  applyRefinement,
  busFor,
  buildOverlay,
  compileRequest,
  metricsFor,
  proposeRefinements,
  proposeRefinementsWithModel,
  runRefinement,
  RefinementRequestError,
  type PipelineOptions,
  type RefinementBus,
  type RefinementRun,
} from './pipeline'

export {
  applyRanking,
  deterministicGoal,
  proposeGoal,
  rankProposals,
  sanitizeGoal,
  type GoalInput,
  type ModelOptions,
  type RefinementGoal,
} from './llm'

export {
  handleRefinementWorkerMessage,
  inWorkerScope,
  installRefinementWorker,
  refinementWorkerAvailable,
  runRefinementJob,
  type RefinementCancelMessage,
  type RefinementClientOptions,
  type RefinementJobResult,
  type RefinementSearchMessage,
  type RefinementWorkerRequest,
  type RefinementWorkerResponse,
} from './worker'

export {
  boundsOfParts,
  captureSilhouette,
  silhouetteArea,
  silhouetteDrift,
  silhouetteFrame,
  silhouetteIou,
  SILHOUETTE_HEIGHT,
  SILHOUETTE_WIDTH,
} from './silhouette'

export {
  countSeams,
  definitionFeatureKeys,
  exposedStudPlane,
  extractRows,
  extractSeams,
  findFreeStuds,
  findStackedSeams,
  findStepEdges,
  matedLocalFeatures,
  placedParts,
  type FreeStud,
  type Row,
  type Seam,
  type StackedSeam,
  type StepEdge,
} from './topology'

export { canMirror, mirrorPlaneFor, mirrorTransform, type MirrorAxis } from './mirror'

export {
  CHANGE_KINDS,
  ISSUE_KINDS,
  OBJECTIVE_IDS,
  REJECTION_CODES,
  isApplicable,
  metricVectorSchema,
  objectiveIdSchema,
  overlayInstructionSchema,
  refinementOperationSchema,
  refinementProposalSchema,
  refinementRequestSchema,
  silhouetteSchema,
  type ChangeKind,
  type IssueKind,
  type MetricVector,
  type ObjectiveId,
  type OverlayInstruction,
  type RefinementIssue,
  type RefinementOperation,
  type RefinementProposalV1,
  type RefinementRequestInput,
  type RefinementRequestV1,
  type RefinementScope,
  type RejectionCode,
  type SilhouetteV1,
} from './types'

/**
 * The in-editor surface.
 *
 * `RefinePanelContribution` is the only thing `src/App.tsx` needs: it registers
 * the dock panel, the changed-part overlay and the objective reference dialog
 * into the workbench extension registry and withdraws all three on unmount.
 */
export { RefinePanelContribution } from './contribution'
export { RefinePanel, useRefineState, OBJECTIVES_MODAL_ID } from './RefinePanel'
export { RefineOverlay } from './RefineOverlay'
export { ObjectivesDialog } from './ObjectivesDialog'
export {
  canApply,
  effortById,
  foundNothing,
  metricRows,
  overlayInstructions,
  rankedProposals,
  REFINE_EFFORTS,
  RefinementSession,
  refusedProposals,
  selectedProposal,
  type MetricRow,
  type RefineEffortId,
  type RefineOutcome,
  type RefinementRunner,
  type RefinementSessionOptions,
  type RefineState,
  type RefineStatus,
} from './session'
