import type { ModelDocument, Transaction } from '../../src/cad/types'
import type { CloudRole } from './capabilities'
import type { InvitationDeliveryStatus } from './invitationLifecycle'

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
  /** The requested branch cannot be replayed completely to its advertised head. */
  | 'INCOMPLETE_HISTORY'
  /** A list could not be read completely; never contains a successful partial value. */
  | 'INCOMPLETE_LIST'
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

/** The failure half of a `CloudResult`, nameable on its own. */
export type CloudFailure = { ok: false; error: CloudErrorShape }

export type CloudResult<T> = { ok: true; value: T } | CloudFailure

/**
 * A failure carries no value, so this returns the failure branch rather than the
 * whole union. That is assignable to `CloudResult<T>` for every T — there was
 * nothing in the arguments to infer T from, so the union form widened to
 * `CloudResult<unknown>` and would not return from a function promising a
 * specific value — and it also lets a caller read `.error` without first
 * narrowing away an `ok: true` case that can never occur.
 */
export const cloudFailure = (
  code: CloudErrorCode,
  message: string,
  repair: string,
  details?: unknown,
): CloudFailure => ({ ok: false, error: { code, message, repair, details } })

export const cloudSuccess = <T>(value: T): CloudResult<T> => ({ ok: true, value })

/**
 * A type alias rather than an interface on purpose.
 *
 * The Convex client constrains a query's arguments to `Record<string, unknown>`,
 * and TypeScript gives an implicit index signature to type aliases but not to
 * interfaces — so declaring this as an interface made it, and every intersection
 * built on it, unassignable at all six paged read sites.
 */
export type CloudPageRequest = {
  cursor?: string | null
  limit?: number
}

export interface CloudPage<T> {
  items: T[]
  /** Opaque continuation, bound to the caller and query/filter scope. */
  cursor: string | null
  done: boolean
}

export type ProjectPageRequest = CloudPageRequest & { projectId: string }
export type CommentPageRequest = ProjectPageRequest & { status?: 'open' | 'resolved'; partId?: string }
export const DEFAULT_DISCOVERY_PAGE_SIZE = 50
export const MAX_DISCOVERY_PAGE_SIZE = 100

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
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_TRANSACTION_BYTES = 512 * 1024
/** Bounded all-or-nothing sync groups, including their wire envelopes. */
export const MAX_TRANSACTION_BATCH_COUNT = 50
export const MAX_TRANSACTION_BATCH_BYTES = 2 * 1024 * 1024
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

export type ReadHistoryArgs = {
  projectId: string
  branchId?: string
  /** Exclusive cursor; send the previous page's nextRevision. */
  sinceRevision: number
  /** Pin subsequent pages to the first page's headRevision. */
  throughRevision?: number
  limit?: number
}

export interface CloudHistoryPage {
  branchId: string
  /** The pinned read target, not a moving head on subsequent pages. */
  headRevision: number
  transactions: CloudTransactionRecord[]
  nextRevision: number
  done: boolean
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
  deliveryStatus: InvitationDeliveryStatus
  deliveryAttempts?: number
  /** Earliest safe retry time for a pending invitation; absent after acceptance by the endpoint. */
  deliveryRetryAt?: string
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

export type CreateProjectArgs = {
  localProjectId: string
  name: string
  visibility?: ProjectVisibility
  schemaVersion: number
  catalogVersion: string
  /** Optional seed checkpoint, chunked by the caller. */
  snapshot?: SnapshotUpload
  /** Resume only an exact original seed owned by this identity; never overwrite existing work. */
  resumeExisting?: boolean
}

export type SnapshotUpload = {
  revision: number
  /** Canonical JSON of the `ModelDocument`, already split into chunks. */
  chunks: string[]
  checksum: string
  bytes: number
  schemaVersion: number
  catalogVersion: string
}

export type AppendTransactionArgs = {
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

/** Every batch targets one authorised project/branch and one contiguous log range. */
export type BatchTransaction = Omit<AppendTransactionArgs, 'projectId' | 'branchId'>
export type AppendTransactionsArgs = {
  projectId: string
  branchId?: string
  transactions: BatchTransaction[]
}
export interface AppendTransactionsValue {
  branchId: string
  headRevision: number
  transactions: Array<{
    clientTransactionId: string
    transactionId: string
    resultRevision: number
    applied: boolean
  }>
}

/** `STALE_DOCUMENT` carries the head the caller must rebase onto. */
export interface StaleDocumentDetails {
  headRevision: number
  branchId: string
}

export type CreateBranchArgs = {
  projectId: string
  name: string
  /** `main` is created with the project and is never created again. */
  kind?: Exclude<BranchKind, 'main'>
  /** Defaults to the project's default branch. */
  fromBranchId?: string
  /**
   * Revision to fork at. Defaults to the parent's head. A conflict fork uses an
   * earlier revision — the point where the two histories diverged — so the
   * local tail replays onto it exactly as it was authored.
   */
  atRevision?: number
  /**
   * Conflict recovery only: atomically seed the exact divergence checkpoint.
   * Repeating the same key, creator, parent, name, revision and seed returns the
   * existing branch, even after its head advances. A changed request is refused.
   */
  recovery?: { key: string; snapshot: SnapshotUpload }
}

export type CreateVersionArgs = {
  projectId: string
  branchId?: string
  label: string
  notes?: string
  snapshot: SnapshotUpload
}

export type AddCommentArgs = {
  projectId: string
  branchId?: string
  body: string
  anchor: CommentAnchor
  replyToId?: string
}

export type PresenceHeartbeatArgs = {
  projectId: string
  sessionId: string
  revision: number
  selection: string[]
  cursorLdu?: { x: number; y: number; z: number }
  cameraTargetLdu?: { x: number; y: number; z: number }
  followingSubject?: string
}
