import type { ModelDocument, Transaction } from '../../src/cad/types'
import type { CloudRole } from './capabilities'

/**
 * The wire contract between the browser and the Convex data plane.
 *
 * Owned by the server directory and re-exported by `src/cloud/protocol.ts`, so
 * the two sides cannot drift: a change to a response shape breaks the compile
 * on both ends at once. The CAD types are imported `import type` only — nothing
 * here has a runtime dependency on the kernel, so a Convex function can import
 * this file without dragging the catalogue into the deployment bundle.
 *
 * Timestamps cross the wire as ISO strings even though Convex stores epoch
 * milliseconds, because `ProjectSummary.savedAt` in `src/cad/persistence.ts` is
 * an ISO string and one project list should not have two time formats in it.
 *
 * Convex document ids cross the wire as opaque strings. The client has no
 * business knowing the table a row lives in.
 */

export type { CloudRole }

export type CloudErrorCode =
  /** No usable identity on the request. */
  | 'UNAUTHENTICATED'
  /** Identity is a member, but the role lacks the capability. */
  | 'FORBIDDEN'
  /** Absent, deleted, or private to somebody else — deliberately the same answer. */
  | 'NOT_FOUND'
  /** `baseRevision` did not match the branch head. Never resolved by overwriting. */
  | 'STALE_DOCUMENT'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_ARGUMENT'
  /** The replica was written by a different document schema version. */
  | 'SCHEMA_MISMATCH'
  /** A snapshot read found fewer chunks than were written. */
  | 'INCOMPLETE_SNAPSHOT'
  | 'CHECKSUM_MISMATCH'
  | 'NAME_TAKEN'
  // The remaining codes are produced by the client transport only. The server
  // never emits them; they are declared here so one union covers every failure
  // a caller of `ProjectStore` can see.
  | 'UNCONFIGURED'
  | 'OFFLINE'
  | 'OUTBOX_FULL'
  | 'TRANSPORT_FAILED'

/**
 * Mirrors `EngineErrorShape` in `src/cad/types.ts`: a code to branch on, a
 * message to show, and a repair the operator can actually carry out.
 */
export interface CloudErrorShape {
  code: CloudErrorCode
  message: string
  repair: string
  details?: unknown
}

export type CloudResult<T> = { ok: true; value: T } | { ok: false; error: CloudErrorShape }

export const cloudFailure = <T>(
  code: CloudErrorCode,
  message: string,
  repair: string,
  details?: unknown,
): CloudResult<T> => ({ ok: false, error: { code, message, repair, details } })

export const cloudSuccess = <T>(value: T): CloudResult<T> => ({ ok: true, value })

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Payload ceilings.
 *
 * A Convex document is capped at 1 MiB, so a snapshot is chunked below that and
 * a whole document is refused above `MAX_SNAPSHOT_BYTES` rather than truncated:
 * half a model that claims to be a checkpoint is worse than no checkpoint.
 */
export const SNAPSHOT_CHUNK_BYTES = 400_000
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
export const MAX_TRANSACTION_BYTES = 512 * 1024
export const MAX_COMMENT_BYTES = 8_000
/** Presence rows older than this are stale and are not returned. */
export const PRESENCE_TTL_MS = 30_000

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type ProjectVisibility = 'private' | 'unlisted' | 'public'
export type BranchKind = 'main' | 'named' | 'conflict'

export interface CloudProjectSummary {
  projectId: string
  /** The `ModelDocument.id` this replica mirrors. */
  localProjectId: string
  name: string
  ownerSubject: string
  visibility: ProjectVisibility
  /** The caller's own role. Never another member's. */
  role: CloudRole
  defaultBranchId: string
  headRevision: number
  schemaVersion: number
  catalogVersion: string
  createdAt: string
  updatedAt: string
}

export interface MergeProposalRecord {
  intoBranchId: string
  status: 'open' | 'merged' | 'withdrawn' | 'rejected'
  proposedBySubject: string
  proposedAt: string
  decidedBySubject?: string
  decidedAt?: string
  summary: string
}

export interface CloudBranchRecord {
  branchId: string
  projectId: string
  name: string
  kind: BranchKind
  headRevision: number
  baseRevision: number
  forkedFromBranchId?: string
  proposal?: MergeProposalRecord
  createdBySubject: string
  createdAt: string
  updatedAt: string
}

export interface CloudTransactionRecord {
  transactionId: string
  projectId: string
  branchId: string
  clientTransactionId: string
  baseRevision: number
  resultRevision: number
  authorSubject: string
  checksum: string
  bytes: number
  schemaVersion: number
  catalogVersion: string
  createdAt: string
  transaction: Transaction
}

export interface CloudSnapshotRecord {
  projectId: string
  branchId?: string
  groupId: string
  kind: 'checkpoint' | 'version'
  revision: number
  checksum: string
  bytes: number
  schemaVersion: number
  catalogVersion: string
  createdBySubject: string
  createdAt: string
  document: ModelDocument
}

export interface CloudVersionRecord {
  versionId: string
  projectId: string
  branchId: string
  revision: number
  label: string
  notes?: string
  snapshotGroupId: string
  documentChecksum: string
  createdBySubject: string
  createdAt: string
}

export interface CloudMemberRecord {
  memberId: string
  projectId: string
  subject: string
  role: CloudRole
  displayName?: string
  invitedBySubject?: string
  addedAt: string
}

export interface CloudInvitationRecord {
  invitationId: string
  projectId: string
  /** Only ever returned to a caller holding `member.invite` on the project. */
  email: string
  role: Exclude<CloudRole, 'owner'>
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  deliveryStatus: 'pending' | 'sent' | 'not-configured' | 'failed'
  /** Why delivery is in that state — never a fabricated success. */
  deliveryReason?: string
  invitedBySubject: string
  createdAt: string
  expiresAt: string
}

export interface CommentAnchor {
  partId: string
  revision: number
  poseChecksum: string
  pointLdu?: { x: number; y: number; z: number }
}

export interface CloudCommentRecord {
  commentId: string
  projectId: string
  branchId?: string
  authorSubject: string
  authorDisplayName?: string
  body: string
  anchor: CommentAnchor
  status: 'open' | 'resolved'
  replyToId?: string
  resolvedBySubject?: string
  resolvedAt?: string
  createdAt: string
  updatedAt: string
}

export interface CloudPresenceRecord {
  projectId: string
  subject: string
  sessionId: string
  displayName?: string
  color: string
  revision: number
  selection: string[]
  cursorLdu?: { x: number; y: number; z: number }
  cameraTargetLdu?: { x: number; y: number; z: number }
  followingSubject?: string
  updatedAt: string
  expiresAt: string
}

export interface CloudAuditRecord {
  auditId: string
  projectId: string
  actorSubject: string
  action: string
  at: string
  /** Scalars only, filtered by `model/audit.ts`. */
  detail: Record<string, string | number | boolean>
}

// ---------------------------------------------------------------------------
// Mutation arguments and results
// ---------------------------------------------------------------------------

export interface CreateProjectArgs {
  localProjectId: string
  name: string
  visibility?: ProjectVisibility
  schemaVersion: number
  catalogVersion: string
  /** Optional seed checkpoint, chunked by the caller. */
  snapshot?: SnapshotUpload
}

export interface SnapshotUpload {
  revision: number
  /** Canonical JSON of the `ModelDocument`, already split into chunks. */
  chunks: string[]
  checksum: string
  bytes: number
  schemaVersion: number
  catalogVersion: string
}

export interface AppendTransactionArgs {
  projectId: string
  branchId?: string
  /** `Transaction.id`. The idempotency key. */
  clientTransactionId: string
  baseRevision: number
  resultRevision: number
  transaction: Transaction
  checksum: string
  schemaVersion: number
  catalogVersion: string
}

export interface AppendTransactionValue {
  transactionId: string
  branchId: string
  headRevision: number
  /** False when this call matched an existing `clientTransactionId`. */
  applied: boolean
}

/** `STALE_DOCUMENT` carries the head the caller must rebase onto. */
export interface StaleDocumentDetails {
  headRevision: number
  branchId: string
}

export interface CreateBranchArgs {
  projectId: string
  name: string
  kind?: BranchKind
  /** Defaults to the project's default branch. */
  fromBranchId?: string
}

export interface CreateVersionArgs {
  projectId: string
  branchId?: string
  label: string
  notes?: string
  snapshot: SnapshotUpload
}

export interface AddCommentArgs {
  projectId: string
  branchId?: string
  body: string
  anchor: CommentAnchor
  replyToId?: string
}

export interface PresenceHeartbeatArgs {
  projectId: string
  sessionId: string
  revision: number
  selection: string[]
  cursorLdu?: { x: number; y: number; z: number }
  cameraTargetLdu?: { x: number; y: number; z: number }
  followingSubject?: string
}
