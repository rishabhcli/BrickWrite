/**
 * Generation: natural language to an editable, physically valid assembly.
 *
 * The published surface of this workstream. Everything here is safe to import
 * from a browser bundle — nothing under `src/` reaches into `server/`, so no
 * credential can travel with it.
 *
 * The shape of the thing, in one paragraph: `compileBrief` turns prose into a
 * `DesignBrief` whose every field carries the phrase that produced it;
 * `GenerationEngine.generate` runs a four-phase pipeline per candidate, in which
 * a model proposes a **build graph** — nodes are part or region intents, edges
 * are connector-to-connector attachments — and the deterministic realiser turns
 * that graph into exact geometry with the kernel's own snap solver, verifying
 * every placement against collision, connectivity, statics and build order. A
 * candidate that cannot be built says which attachment failed and why.
 */

export {
  BRIEF_COMPILER_VERSION,
  DESIGN_BRIEF_SCHEMA,
  amendBrief,
  briefOnly,
  classifySubject,
  compileBrief,
  compileBriefDeterministically,
  matchColours,
  type ColourMatch,
  type CompileBriefOptions,
  type DesignBriefResult,
  type SubjectArchetype,
  type SubjectClassification,
} from './brief'

export {
  familiesCanMate,
  gridPointLdu,
  incomingEdge,
  mergeProtected,
  protectedNodeId,
  structuralHash,
  subgraph,
  topologicalOrder,
  validateGraph,
  type BuildEdge,
  type BuildGraph,
  type BuildNode,
  type ConnectorPick,
  type ConnectorRef,
  type GraphViolation,
  type MergeProtectedResult,
  type NodeKind,
  type PartIntent,
  type RegionIntent,
} from './graph'

export {
  GenerationAbortedError,
  GraphRealizer,
  measuredExtentStuds,
  orderFeatures,
  realizeGraph,
  realizedParts,
  resolvePartIdentity,
  type EdgeOutcome,
  type IdentityResolution,
  type NodeOutcome,
  type NodeStatus,
  type RealizeConstraints,
  type RealizeOptions,
  type RealizeResult,
} from './realize'

export {
  enumerateAttachmentAttempts,
  enumerateRegionAttempts,
  type AttachmentAttempt,
  type AttachmentRepairInput,
  type RegionAttempt,
  type RegionRepairInput,
  type RepairKind,
} from './repair'

export {
  DEFAULT_PART_BUDGET,
  GenerationCancelled,
  HARD_PART_CEILING,
  MASSING_SCHEMA,
  PHASES,
  STRATEGIES,
  clampBoxes,
  constraintsFor,
  fitBoxHeights,
  layoutStoreys,
  runPipeline,
  strategyById,
  volumeFor,
  type Candidate,
  type GenerationStrategy,
  type MassingBox,
  type MassingInput,
  type PhaseEvent,
  type PhaseMetrics,
  type PhaseName,
  type PipelineOptions,
  type StoreyLayout,
} from './phases'

export {
  componentsOf,
  diffMetrics,
  evaluateHardGates,
  metricDistance,
  scoreDocument,
  type HardGateResult,
  type MetricVector,
  type ScoreOptions,
} from './score'

export {
  cellCentreLdu,
  compareMasks,
  documentExtent,
  frameForBounds,
  frameForEnvelope,
  maskFromBitmap,
  maskFromBounds,
  maskFromEnvelope,
  maskToText,
  rasteriseSilhouette,
  referencesFromEnvelope,
  silhouetteScore,
  viewAxes,
  type FrameOptions,
  type SilhouetteComparison,
  type SilhouetteFrame,
  type SilhouetteMask,
  type SilhouetteReference,
  type SilhouetteView,
} from './silhouette'

export {
  GENERATION_VERSION,
  GenerationEngine,
  applyCandidate,
  candidateOperations,
  compareCandidates,
  type CommandBusLike,
  type GenerateOptions,
  type GenerationRun,
  type GenerationSettings,
  type RejectedCandidate,
  type RunDescriptor,
} from './engine'

export {
  compileBriefViaServer,
  createGenerationProvider,
  type GenerationClientOptions,
  type GenerationEventName,
  type GenerationWireEvent,
} from './provider'
