/**
 * Cloud projects — the published entry point.
 *
 * Data, stores and hooks. No page UI: this workstream owns synchronisation and
 * the collaboration data model, and the surfaces that render them belong to the
 * workstreams that own those routes.
 *
 * The shape of the thing, in one paragraph: IndexedDB stays the immediate
 * durable store and the local-first behaviour of `src/cad/persistence.ts` is
 * unchanged. Hexclave is the identity plane; ownership is keyed by the Hexclave
 * user id and never by an email address. Convex is the data plane, holding a
 * replica that is advanced by optimistic concurrency control on the revision —
 * a write whose base revision is not the current head is refused, never merged
 * by overwriting. Signed-out, offline and unconfigured are all first-class
 * states with reasons attached, and in every one of them the editor keeps
 * working against local storage alone.
 */

export {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  ROLES,
  capabilitiesFor,
  isCloudRole,
  refusalReason,
  roleAllows,
  roleAtLeast,
  type Capability,
  type CloudRole,
} from './permissions'

export {
  MAX_COMMENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_BATCH_BYTES,
  MAX_TRANSACTION_BATCH_COUNT,
  PRESENCE_TTL_MS,
  SNAPSHOT_CHUNK_BYTES,
  cloudFailure,
  cloudSuccess,
  DEFAULT_DISCOVERY_PAGE_SIZE,
  MAX_DISCOVERY_PAGE_SIZE,
  type CloudPage,
  type CloudPageRequest,
  type ProjectPageRequest,
  type CommentPageRequest,
  type AddCommentArgs,
  type AppendTransactionArgs,
  type AppendTransactionValue,
  type AppendTransactionsArgs,
  type AppendTransactionsValue,
  type BatchTransaction,
  type CloudAuditRecord,
  type CloudBackend,
  type CloudBranchRecord,
  type CloudHistoryPage,
  type ReadHistoryArgs,
  type CloudCommentRecord,
  type CloudErrorCode,
  type CloudErrorShape,
  type CloudInvitationRecord,
  type CloudMemberRecord,
  type CloudPresenceRecord,
  type CloudProjectSummary,
  type CloudResult,
  type CloudSnapshotRecord,
  type CloudTransactionRecord,
  type CloudVersionRecord,
  type CommentAnchor,
  type CreateBranchArgs,
  type CreateProjectArgs,
  type CreateVersionArgs,
  type MergeProposalRecord,
  type PresenceHeartbeatArgs,
  type ProjectVisibility,
  type SnapshotUpload,
  type StaleDocumentDetails,
} from './protocol'

export { readCompleteHistory } from './history'
export { collectCloudPages } from './pagination'
export { transactionBatch, sendTransactionBatch } from './batches'
export { validateTransactionPayload } from '../../convex/model/transactionValidation'

export { attachCloudSync, settled, type AttachCloudSyncOptions, type CloudSyncHandle } from './attach'

export {
  CloudProjectStore,
  LocalProjectStore,
  MirroredProjectStore,
  ProjectLinks,
  type AppendOutcome,
  type CheckpointOutcome,
  type DivergenceOutcome,
  type ProjectLink,
  type ProjectStore,
  type StoredLoadedProject,
  type StoredProjectSummary,
} from './projectStore'

export {
  OUTBOX_CAPACITY,
  Outbox,
  RETRY_BASE_MS,
  RETRY_CEILING_MS,
  UNCONFIGURED_SYNC_STATE,
  startAutoDrain,
  type OutboxEntry,
  type OutboxPayload,
  type SyncState,
  type SyncStatus,
} from './outbox'

export {
  executeConflictFork,
  isDisjoint,
  overlapOf,
  planRebase,
  scopeOf,
  type ConflictFork,
  type GlobalScope,
  type RebaseInput,
  type RebasePlan,
  type ScopeOverlap,
  type TouchedScope,
} from './rebase'

export {
  claimIntegrityReport,
  claimLocalProject,
  provenanceOf,
  transactionIds,
  type ClaimArgs,
  type ClaimIntegrityReport,
  type ClaimOutcome,
} from './claim'

export {
  compareToVersion,
  diffDocuments,
  restorePlan,
  summariseDiff,
  type CollectionDiff,
  type DocumentDiff,
  type RestorePlan,
  type VersionComparison,
} from './versions'

export {
  anchorFor,
  anchorSummary,
  resolveAnchor,
  resolveAnchors,
  threadsOf,
  type AnchorReport,
  type AnchorState,
  type CommentThread,
} from './comments'

export {
  PresenceSession,
  presenceView,
  type PresencePeer,
  type PresenceSessionOptions,
  type PresenceView,
} from './presence'

export {
  ConvexCloudBackend,
  convexUrlFromEnv,
  createConvexCloud,
  hexclaveTokenSource,
  type AccessTokenSource,
  type ConvexCloudOptions,
  type ConvexCloudReady,
  type ConvexCloudResult,
  type ConvexCloudUnconfigured,
} from './convexClient'

export {
  canonicalJson,
  checksumOf,
  checksumOfText,
  chunkText,
  documentChecksum,
  poseChecksumOf,
  snapshotUploadFor,
  transactionChecksum,
  utf8Bytes,
} from './serialize'

export { refs } from './functionRefs'

export { useAnchorReports, useProjectList, useSyncState, type ProjectListState } from './hooks'

// ---------------------------------------------------------------------------
// In-editor surfaces
// ---------------------------------------------------------------------------
//
// The workstream's data model is above; this is how a person reaches it. Each
// export is a zero-prop component that registers itself into a named workbench
// slot, so `src/App.tsx` lists `CloudProjectsContribution` and nothing else in
// the editor changes. See "In-editor surface" in
// docs/integration/cloud-projects.md.

export {
  CloudMembersPanelContribution,
  CloudProjectsContribution,
  CloudProjectsPanelContribution,
  CloudSyncStatusContribution,
  CloudVersionHistoryContribution,
} from './contributions'

export { CloudSyncProvider, useCloudSync, useOptionalCloudSync, type CloudSyncProviderProps } from './CloudSyncProvider'

export {
  CloudRuntime,
  SIGNED_OUT_IDENTITY,
  canReachCloud,
  type CloudConfiguration,
  type CloudConnection,
  type CloudIdentity,
  type CloudKernelBridge,
  type CloudProjectRow,
  type CloudRuntimeOptions,
  type CloudRuntimeSnapshot,
} from './runtime'

export { browserCloud, browserCloudRuntime, browserKernelBridge, resetBrowserCloudRuntime } from './browserRuntime'

export { describeSync, type SyncReadout, type SyncReadoutInput } from './syncReadout'
export { CloudProjectsPanel } from './ProjectsPanel'
export { CloudSyncStatus, useProjectLinked, useSyncReadout } from './SyncStatus'
export { CloudVersionHistory } from './VersionHistory'
export { VERSION_HISTORY_MODAL_ID, type CloudWorkbenchApi, type SurfaceNotice } from './surface'
