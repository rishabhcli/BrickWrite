import type {
  CloudPage, CloudPageRequest, ProjectPageRequest, CommentPageRequest,
  AddCommentArgs,
  AppendTransactionArgs,
  AppendTransactionValue,
  AppendTransactionsArgs,
  AppendTransactionsValue,
  CloudAuditRecord,
  CloudBranchRecord,
  CloudHistoryPage,
  ReadHistoryArgs,
  CloudCommentRecord,
  CloudInvitationRecord,
  CloudMemberRecord,
  CloudPresenceRecord,
  CloudProjectSummary,
  CloudResult,
  CloudRole,
  CloudSnapshotRecord,
  CloudTransactionRecord,
  CloudVersionRecord,
  CreateBranchArgs,
  CreateProjectArgs,
  CreateVersionArgs,
  PresenceHeartbeatArgs,
  ProjectVisibility,
  SnapshotUpload,
} from '../../convex/model/protocol'

/**
 * The client half of the wire contract.
 *
 * Everything the browser knows about the shape of the data plane comes from
 * `convex/model/protocol.ts`, re-exported here so that application code imports
 * from `src/cloud` and never reaches into the deployment directory. The types
 * are defined once, on the side that enforces them.
 *
 * `CloudBackend` is the seam that makes the acceptance suite meaningful: the
 * Convex adapter and the in-process test double both implement it, so the same
 * contract tests run against both. A test double of the *backend* is legitimate
 * exactly to the extent that it implements the same semantics, which is why the
 * interface is stated here rather than being whatever the fake happens to do.
 */

export type {
  CloudPage, CloudPageRequest, ProjectPageRequest, CommentPageRequest,
  BatchTransaction,
  AddCommentArgs,
  AppendTransactionArgs,
  AppendTransactionValue,
  AppendTransactionsArgs,
  AppendTransactionsValue,
  CloudAuditRecord,
  CloudBranchRecord,
  CloudHistoryPage,
  ReadHistoryArgs,
  CloudCommentRecord,
  CloudErrorCode,
  CloudErrorShape,
  CloudInvitationRecord,
  CloudMemberRecord,
  CloudPresenceRecord,
  CloudProjectSummary,
  CloudResult,
  CloudRole,
  CloudSnapshotRecord,
  CloudTransactionRecord,
  CloudVersionRecord,
  CommentAnchor,
  CreateBranchArgs,
  CreateProjectArgs,
  CreateVersionArgs,
  MergeProposalRecord,
  PresenceHeartbeatArgs,
  ProjectVisibility,
  SnapshotUpload,
  StaleDocumentDetails,
} from '../../convex/model/protocol'

export {
  DEFAULT_DISCOVERY_PAGE_SIZE, MAX_DISCOVERY_PAGE_SIZE,
  cloudFailure,
  cloudSuccess,
  MAX_COMMENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_BATCH_BYTES,
  MAX_TRANSACTION_BATCH_COUNT,
  PRESENCE_TTL_MS,
  SNAPSHOT_CHUNK_BYTES,
} from '../../convex/model/protocol'

export interface CloudBackend {
  // Bounded incremental discovery for agents and large collections.
  readProjectsPage(args?: CloudPageRequest): Promise<CloudResult<CloudPage<CloudProjectSummary>>>
  readBranchesPage(args: ProjectPageRequest): Promise<CloudResult<CloudPage<CloudBranchRecord>>>
  readVersionsPage(args: ProjectPageRequest): Promise<CloudResult<CloudPage<CloudVersionRecord>>>
  readMembersPage(args: ProjectPageRequest): Promise<CloudResult<CloudPage<CloudMemberRecord>>>
  readInvitationsPage(args: ProjectPageRequest): Promise<CloudResult<CloudPage<CloudInvitationRecord>>>
  readCommentsPage(args: CommentPageRequest): Promise<CloudResult<CloudPage<CloudCommentRecord>>>
  // -- projects ------------------------------------------------------------
  listProjects(): Promise<CloudResult<CloudProjectSummary[]>>
  getProject(args: { projectId: string }): Promise<CloudResult<CloudProjectSummary>>
  createProject(args: CreateProjectArgs): Promise<CloudResult<CloudProjectSummary>>
  renameProject(args: { projectId: string; name: string }): Promise<CloudResult<CloudProjectSummary>>
  setVisibility(args: { projectId: string; visibility: ProjectVisibility }): Promise<CloudResult<CloudProjectSummary>>
  deleteProject(args: { projectId: string }): Promise<CloudResult<{ projectId: string; deletedAt: string }>>
  saveCheckpoint(args: {
    projectId: string
    branchId?: string
    snapshot: SnapshotUpload
  }): Promise<CloudResult<{ groupId: string; revision: number }>>
  latestCheckpoint(args: {
    projectId: string
    branchId?: string
    atRevision?: number
  }): Promise<CloudResult<CloudSnapshotRecord | null>>
  auditTrail(args: { projectId: string; limit?: number }): Promise<CloudResult<CloudAuditRecord[]>>

  // -- transactions --------------------------------------------------------
  /** Optional for legacy/offline hosts; production provides atomic batches. */
  appendTransactions?(args: AppendTransactionsArgs): Promise<CloudResult<AppendTransactionsValue>>
  readHistory(args: ReadHistoryArgs): Promise<CloudResult<CloudHistoryPage>>
  appendTransaction(args: AppendTransactionArgs): Promise<CloudResult<AppendTransactionValue>>
  listTransactions(args: {
    projectId: string
    branchId?: string
    sinceRevision: number
    limit?: number
  }): Promise<CloudResult<CloudTransactionRecord[]>>
  findTransaction(args: {
    projectId: string
    clientTransactionId: string
  }): Promise<CloudResult<CloudTransactionRecord | null>>

  // -- versions and branches ----------------------------------------------
  listBranches(args: { projectId: string }): Promise<CloudResult<CloudBranchRecord[]>>
  createBranch(args: CreateBranchArgs): Promise<CloudResult<CloudBranchRecord>>
  proposeMerge(args: {
    projectId: string
    branchId: string
    intoBranchId?: string
    summary: string
  }): Promise<CloudResult<CloudBranchRecord>>
  decideMerge(args: {
    projectId: string
    branchId: string
    decision: 'merged' | 'rejected' | 'withdrawn'
  }): Promise<CloudResult<CloudBranchRecord>>
  createVersion(args: CreateVersionArgs): Promise<CloudResult<CloudVersionRecord>>
  listVersions(args: { projectId: string }): Promise<CloudResult<CloudVersionRecord[]>>
  versionDocument(args: { projectId: string; versionId: string }): Promise<CloudResult<CloudSnapshotRecord>>

  // -- members and invitations --------------------------------------------
  listMembers(args: { projectId: string }): Promise<CloudResult<CloudMemberRecord[]>>
  myRole(args: { projectId: string }): Promise<CloudResult<CloudRole | null>>
  setMemberRole(args: {
    projectId: string
    subject: string
    role: Exclude<CloudRole, 'owner'>
  }): Promise<CloudResult<CloudMemberRecord>>
  removeMember(args: { projectId: string; subject: string }): Promise<CloudResult<{ removed: boolean }>>
  listInvitations(args: { projectId: string }): Promise<CloudResult<CloudInvitationRecord[]>>
  createInvitation(args: {
    projectId: string
    email: string
    role: Exclude<CloudRole, 'owner'>
  }): Promise<CloudResult<CloudInvitationRecord>>
  retryInvitationDelivery(args: {
    projectId: string
    invitationId: string
  }): Promise<CloudResult<CloudInvitationRecord>>
  revokeInvitation(args: { projectId: string; invitationId: string }): Promise<CloudResult<{ revoked: boolean }>>
  acceptInvitation(args: { token: string }): Promise<CloudResult<{ projectId: string; role: string }>>

  // -- comments ------------------------------------------------------------
  listComments(args: { projectId: string; status?: 'open' | 'resolved' }): Promise<CloudResult<CloudCommentRecord[]>>
  commentsForPart(args: { projectId: string; partId: string }): Promise<CloudResult<CloudCommentRecord[]>>
  addComment(args: AddCommentArgs): Promise<CloudResult<CloudCommentRecord>>
  /** Removes a comment and its replies. Returns how many rows went. */
  removeComment(args: { projectId: string; commentId: string }): Promise<CloudResult<{ removed: number }>>
  /** Removes a named version and the document it pinned. The log is untouched. */
  removeVersion(args: { projectId: string; versionId: string }): Promise<CloudResult<{ removed: boolean }>>
  setCommentStatus(args: {
    projectId: string
    commentId: string
    status: 'open' | 'resolved'
  }): Promise<CloudResult<CloudCommentRecord>>

  // -- presence ------------------------------------------------------------
  presenceHeartbeat(args: PresenceHeartbeatArgs): Promise<CloudResult<CloudPresenceRecord>>
  listPresence(args: { projectId: string }): Promise<CloudResult<CloudPresenceRecord[]>>
  presenceLeave(args: { projectId: string; sessionId: string }): Promise<CloudResult<{ left: boolean }>>
}
