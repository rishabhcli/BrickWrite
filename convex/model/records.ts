import { invitationRetryAt } from './invitationLifecycle'
import type { Doc } from '../_generated/dataModel'
import { auditCategory } from './audit'
import { iso } from './auth'
import type {
  CloudAuditRecord,
  CloudBranchRecord,
  CloudCommentRecord,
  CloudInvitationRecord,
  CloudMemberRecord,
  CloudPresenceRecord,
  CloudTransactionRecord,
  CloudVersionRecord,
} from './protocol'
import type { Transaction } from '../../src/cad/types'

/**
 * Row → wire mapping.
 *
 * Kept out of the function files for one reason that matters: Convex registers
 * every export of a module under `convex/` as part of its public API surface,
 * so a shared helper exported next to a mutation is a helper with a URL. These
 * live in `model/` where nothing is addressable.
 *
 * Each mapper is explicit rather than a spread of the stored row. A spread
 * would publish `_creationTime`, internal ids and any field added to the schema
 * later, and the field added later is exactly the one that turns out to be
 * sensitive.
 */

export const branchRecord = (branch: Doc<'branches'>): CloudBranchRecord => ({
  branchId: branch._id,
  projectId: branch.projectId,
  name: branch.name,
  kind: branch.kind,
  headRevision: branch.headRevision,
  baseRevision: branch.baseRevision,
  forkedFromBranchId: branch.forkedFromBranchId,
  proposal: branch.proposal && {
    intoBranchId: branch.proposal.intoBranchId,
    status: branch.proposal.status,
    proposedBySubject: branch.proposal.proposedBySubject,
    proposedAt: iso(branch.proposal.proposedAt),
    decidedBySubject: branch.proposal.decidedBySubject,
    decidedAt: branch.proposal.decidedAt ? iso(branch.proposal.decidedAt) : undefined,
    summary: branch.proposal.summary,
  },
  createdBySubject: branch.createdBySubject,
  createdAt: iso(branch.createdAt),
  updatedAt: iso(branch.updatedAt),
})

export const transactionRecord = (row: Doc<'transactions'>): CloudTransactionRecord => ({
  transactionId: row._id,
  projectId: row.projectId,
  branchId: row.branchId,
  clientTransactionId: row.clientTransactionId,
  baseRevision: row.baseRevision,
  resultRevision: row.resultRevision,
  authorSubject: row.authorSubject,
  checksum: row.checksum,
  bytes: row.bytes,
  schemaVersion: row.schemaVersion,
  catalogVersion: row.catalogVersion,
  createdAt: iso(row.createdAt),
  transaction: row.payload as Transaction,
})

export const versionRecord = (row: Doc<'versions'>): CloudVersionRecord => ({
  versionId: row._id,
  projectId: row.projectId,
  branchId: row.branchId,
  revision: row.revision,
  label: row.label,
  notes: row.notes,
  snapshotGroupId: row.snapshotGroupId,
  documentChecksum: row.documentChecksum,
  createdBySubject: row.createdBySubject,
  createdAt: iso(row.createdAt),
})

export const memberRecord = (row: Doc<'members'>): CloudMemberRecord => ({
  memberId: row._id,
  projectId: row.projectId,
  subject: row.subject,
  role: row.role,
  displayName: row.displayName,
  invitedBySubject: row.invitedBySubject,
  addedAt: iso(row.addedAt),
})

export const invitationRecord = (row: Doc<'invitations'>): CloudInvitationRecord => ({
  invitationId: row._id,
  projectId: row.projectId,
  email: row.email,
  role: row.role,
  status: row.status === 'pending' && row.expiresAt <= Date.now() ? 'expired' : row.status,
  deliveryStatus: row.deliveryStatus,
  deliveryAttempts: row.deliveryAttempts ?? 0,
  deliveryRetryAt:
    row.status === 'pending' && row.expiresAt > Date.now() && !['queued', 'sent'].includes(row.deliveryStatus)
      ? iso(invitationRetryAt(row))
      : undefined,
  // Older workers persisted arbitrary provider error text. Do not publish
  // legacy payloads that may contain access tokens or endpoint credentials.
  deliveryReason:
    row.deliveryGeneration === undefined
      ? 'Legacy delivery record. Inbox delivery has not been verified.'
      : row.deliveryReason,
  invitedBySubject: row.invitedBySubject,
  createdAt: iso(row.createdAt),
  expiresAt: iso(row.expiresAt),
})

export const commentRecord = (row: Doc<'comments'>): CloudCommentRecord => ({
  commentId: row._id,
  projectId: row.projectId,
  branchId: row.branchId,
  authorSubject: row.authorSubject,
  authorDisplayName: row.authorDisplayName,
  body: row.body,
  anchor: {
    partId: row.anchor.partId,
    revision: row.anchor.revision,
    poseChecksum: row.anchor.poseChecksum,
    pointLdu: row.anchor.pointLdu,
  },
  status: row.status,
  replyToId: row.replyToId,
  resolvedBySubject: row.resolvedBySubject,
  resolvedAt: row.resolvedAt ? iso(row.resolvedAt) : undefined,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
})

export const presenceRecord = (row: Doc<'presence'>): CloudPresenceRecord => ({
  projectId: row.projectId,
  subject: row.subject,
  sessionId: row.sessionId,
  displayName: row.displayName,
  color: row.color,
  revision: row.revision,
  selection: row.selection,
  cursorLdu: row.cursorLdu,
  cameraTargetLdu: row.cameraTargetLdu,
  followingSubject: row.followingSubject,
  updatedAt: iso(row.updatedAt),
  expiresAt: iso(row.expiresAt),
})

export const auditRecord = (row: Doc<'auditEvents'>): CloudAuditRecord => ({
  auditId: row._id,
  projectId: row.projectId,
  actorSubject: row.actorSubject,
  action: row.action,
  category: row.category ?? auditCategory(row.action),
  at: iso(row.at),
  detail: row.detail,
})
