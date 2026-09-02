import { auditCategory } from '../../../convex/model/audit'
import { invitationRetryAt, type InvitationDeliveryStatus } from '../../../convex/model/invitationLifecycle'
import { roleAllows, type Capability, type CloudRole } from '../../../convex/model/capabilities'
import { canonicalJson, checksumOfText, utf8Bytes } from '../../../convex/model/checksum'
import { decodeSnapshotUpload } from '../../../convex/model/snapshotValidation'
import { readBranchHistory, verifyHistoryRecord } from '../../../convex/model/history'
import { redactAuditDetail } from '../../../convex/model/redaction'
import type { Transaction } from '../../cad/types'
import {
  type CloudPage, type CloudPageRequest, type ProjectPageRequest, type CommentPageRequest,
  MAX_COMMENT_BYTES,
  MAX_TRANSACTION_BYTES,
  PRESENCE_TTL_MS,
  type AddCommentArgs,
  type AppendTransactionArgs,
  type AppendTransactionValue,
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
} from '../protocol'

/**
 * An in-process implementation of the Convex deployment.
 *
 * This is a test double of the *backend*, and it is only worth anything to the
 * extent that it implements the same semantics as the real functions. So it
 * shares the parts that decide outcomes rather than copying them: the
 * capability matrix, the payload ceilings and snapshot validation, the checksum
 * algorithm and the audit redaction filter are all imported from `convex/model/`
 * — the same modules the deployment runs. What is reimplemented here is
 * storage: Maps and arrays instead of `ctx.db` and its indexes.
 *
 * The check order in every method deliberately mirrors its counterpart under
 * `convex/`, because the order is observable: whether a viewer sees `FORBIDDEN`
 * or `STALE_DOCUMENT` for a stale write depends on which check runs first.
 *
 * Atomicity is real rather than approximated. Every mutation below runs to
 * completion without awaiting, so on a single-threaded event loop no two
 * mutations can interleave — which is the property Convex's serializable
 * execution gives the deployment, and the one the concurrency gate exercises.
 *
 * A live Convex deployment is NOT exercised by any of this.
 */

export interface FakeIdentity {
  /** The Hexclave user id. */
  subject: string
  displayName?: string
}

interface ProjectRow {
  _id: string
  ownerSubject: string
  name: string
  visibility: ProjectVisibility
  localProjectId: string
  defaultBranchId?: string
  schemaVersion: number
  catalogVersion: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  creation?: { name: string; visibility: ProjectVisibility; snapshotGroupId?: string }
}

interface BranchRow {
  _id: string
  projectId: string
  name: string
  headRevision: number
  baseRevision: number
  forkedFromBranchId?: string
  kind: 'main' | 'named' | 'conflict'
  recoveryKey?: string
  recoverySnapshotGroupId?: string
  createdBySubject: string
  createdAt: number
  updatedAt: number
  proposal?: {
    intoBranchId: string
    status: 'open' | 'merged' | 'withdrawn' | 'rejected'
    proposedBySubject: string
    proposedAt: number
    decidedBySubject?: string
    decidedAt?: number
    summary: string
  }
}

interface TransactionRow {
  _id: string
  projectId: string
  branchId: string
  clientTransactionId: string
  baseRevision: number
  resultRevision: number
  authorSubject: string
  payload: Transaction
  checksum: string
  bytes: number
  schemaVersion: number
  catalogVersion: string
  createdAt: number
}

interface SnapshotRow {
  _id: string
  projectId: string
  branchId?: string
  groupId: string
  kind: 'checkpoint' | 'version'
  revision: number
  chunkIndex: number
  chunkCount: number
  data: string
  checksum: string
  bytes: number
  schemaVersion: number
  catalogVersion: string
  createdBySubject: string
  createdAt: number
}

interface VersionRow {
  _id: string
  projectId: string
  branchId: string
  revision: number
  label: string
  notes?: string
  snapshotGroupId: string
  documentChecksum: string
  createdBySubject: string
  createdAt: number
}

interface MemberRow {
  _id: string
  projectId: string
  subject: string
  role: CloudRole
  displayName?: string
  invitedBySubject?: string
  addedAt: number
}

interface InvitationRow {
  _id: string
  projectId: string
  email: string
  role: Exclude<CloudRole, 'owner'>
  token: string
  invitedBySubject: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  deliveryStatus: InvitationDeliveryStatus
  deliveryGeneration?: number
  deliveryAttempts?: number
  deliveryRequestedAt?: number
  deliveryStartedAt?: number
  deliveryReason?: string
  acceptedBySubject?: string
  acceptedAt?: number
}

interface PresenceRow {
  _id: string
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
  updatedAt: number
  expiresAt: number
}

interface CommentRow {
  _id: string
  projectId: string
  branchId?: string
  authorSubject: string
  authorDisplayName?: string
  body: string
  anchor: CommentAnchor
  status: 'open' | 'resolved'
  replyToId?: string
  resolvedBySubject?: string
  resolvedAt?: number
  createdAt: number
  updatedAt: number
}

export interface AuditRow {
  _id: string
  projectId: string
  actorSubject: string
  action: string
  at: number
  detail: Record<string, string | number | boolean>
}

const fail = <T>(code: CloudErrorCode, message: string, repair: string, details?: unknown): CloudResult<T> => ({
  ok: false,
  error: { code, message, repair, details },
})

const UNAUTHENTICATED: CloudErrorShape = {
  code: 'UNAUTHENTICATED',
  message: 'This request carried no signed-in identity.',
  repair: 'Sign in, then retry. Local projects keep working while signed out.',
}

const notFound = <T>(): CloudResult<T> =>
  fail(
    'NOT_FOUND',
    'That project is not available to this account.',
    'Check the project link, or ask its owner for access.',
  )

const SWATCHES = ['#f0a202', '#3aa6b9', '#c94f7c', '#7cb342', '#8a6fdf', '#d95d39', '#2e9e83', '#b07d62']

function swatchFor(subject: string): string {
  let hash = 0
  for (let index = 0; index < subject.length; index += 1) {
    hash = (hash * 31 + subject.charCodeAt(index)) >>> 0
  }
  return SWATCHES[hash % SWATCHES.length]
}

export interface FakeDeploymentOptions {
  /** Base epoch for generated timestamps; each write advances by one ms. */
  startedAt?: number
  /** Set on construction to start disconnected. */
  offline?: boolean
}

export class FakeConvexDeployment {
  readonly projects: ProjectRow[] = []
  readonly branches: BranchRow[] = []
  readonly transactions: TransactionRow[] = []
  readonly snapshots: SnapshotRow[] = []
  readonly versions: VersionRow[] = []
  readonly members: MemberRow[] = []
  readonly invitations: InvitationRow[] = []
  readonly presence: PresenceRow[] = []
  readonly comments: CommentRow[] = []
  readonly auditEvents: AuditRow[] = []

  private counter = 0
  private clock: number
  private offlineReason: string | null

  constructor(options: FakeDeploymentOptions = {}) {
    this.clock = options.startedAt ?? Date.UTC(2026, 0, 1)
    this.offlineReason = options.offline ? 'The network is unavailable.' : null
  }

  private id(table: string): string {
    this.counter += 1
    return `${table}_${this.counter}`
  }

  /** Monotonic, so `createdAt` ordering is deterministic across a whole test. */
  private now(): number {
    this.clock += 1
    return this.clock
  }

  private iso(at: number): string {
    return new Date(at).toISOString()
  }

  /** Simulates losing and regaining the network. */
  setOffline(offline: boolean, reason = 'The network is unavailable.'): void {
    this.offlineReason = offline ? reason : null
  }

  get isOffline(): boolean {
    return this.offlineReason !== null
  }

  /** A `CloudBackend` bound to one identity, or to nobody when null. */
  as(identity: FakeIdentity | null): CloudBackend {
    return new FakeConvexBackend(this, identity)
  }

  // -- internals used by the bound backend ---------------------------------

  offlineFailure<T>(): CloudResult<T> | null {
    if (!this.offlineReason) return null
    return fail(
      'OFFLINE',
      `The cloud is unreachable: ${this.offlineReason}`,
      'Keep working; queued changes are sent when the connection returns.',
    )
  }

  project(projectId: string): ProjectRow | undefined {
    const row = this.projects.find((project) => project._id === projectId)
    return row && row.deletedAt === undefined ? row : undefined
  }

  membership(projectId: string, subject: string): MemberRow | undefined {
    return this.members.find((member) => member.projectId === projectId && member.subject === subject)
  }

  /**
   * The single authorisation gate, mirroring `convex/model/auth.ts`.
   *
   * A non-member of a private project is told `NOT_FOUND`, not `FORBIDDEN`:
   * `FORBIDDEN` would confirm the project exists, which a stranger is not
   * entitled to know. A member who merely lacks the capability does get
   * `FORBIDDEN`, because for them the project's existence is not a secret.
   */
  authorise(
    identity: FakeIdentity | null,
    projectId: string,
    capability: Capability,
  ): CloudResult<{ identity: FakeIdentity; project: ProjectRow; role: CloudRole }> {
    if (!identity) return { ok: false, error: UNAUTHENTICATED }
    const project = this.project(projectId)
    if (!project) return notFound()
    const explicit = this.membership(project._id, identity.subject)?.role ?? null
    const role: CloudRole | null =
      explicit ?? (project.visibility === 'public' ? 'viewer' : null)
    if (!role) return notFound()
    if (!roleAllows(role, capability)) {
      return fail(
        'FORBIDDEN',
        `A ${role} may not ${capability.replace('.', ' ')} on this project.`,
        'Ask an owner to raise your role on this project.',
        { role, capability },
      )
    }
    return { ok: true, value: { identity, project, role } }
  }

  branch(project: ProjectRow, branchId?: string): CloudResult<BranchRow> {
    const id = branchId ?? project.defaultBranchId
    if (!id) {
      return fail(
        'NOT_FOUND',
        'This project has no branch to write to.',
        'Reopen the project; its default branch is created with it.',
      )
    }
    const branch = this.branches.find((row) => row._id === id)
    if (!branch || branch.projectId !== project._id) {
      return fail(
        'NOT_FOUND',
        'That branch does not belong to this project.',
        'Reload the branch list and choose again.',
      )
    }
    return { ok: true, value: branch }
  }

  audit(projectId: string, actorSubject: string, action: string, detail: Record<string, unknown>) {
    this.auditEvents.push({
      _id: this.id('auditEvents'),
      projectId,
      actorSubject,
      action,
      at: this.now(),
      detail: redactAuditDetail(detail),
    })
  }

  writeSnapshot(args: {
    projectId: string
    branchId?: string
    kind: 'checkpoint' | 'version'
    upload: SnapshotUpload
    createdBySubject: string
  }): CloudResult<string> {
    const project = this.projects.find((row) => row._id === args.projectId)
    const validated = decodeSnapshotUpload(args.upload, project && {
      localProjectId: project.localProjectId, schemaVersion: project.schemaVersion,
    })
    if (!validated.ok) return validated
    const groupId = this.id('snapgroup')
    const createdAt = this.now()
    args.upload.chunks.forEach((data, chunkIndex) => {
      this.snapshots.push({
        _id: this.id('snapshots'),
        projectId: args.projectId,
        branchId: args.branchId,
        groupId,
        kind: args.kind,
        revision: args.upload.revision,
        chunkIndex,
        chunkCount: args.upload.chunks.length,
        data,
        checksum: args.upload.checksum,
        bytes: args.upload.bytes,
        schemaVersion: args.upload.schemaVersion,
        catalogVersion: args.upload.catalogVersion,
        createdBySubject: args.createdBySubject,
        createdAt,
      })
    })
    return { ok: true, value: groupId }
  }

  readSnapshot(groupId: string, projectId: string): CloudResult<CloudSnapshotRecord> {
    const chunks = this.snapshots.filter((row) => row.groupId === groupId)
    if (chunks.length === 0) {
      return fail(
        'NOT_FOUND',
        'That checkpoint is not stored in this deployment.',
        'Pick another version, or re-upload a checkpoint from the open document.',
      )
    }
    const first = chunks[0]
    if (first.projectId !== projectId) {
      return fail(
        'NOT_FOUND',
        'That checkpoint belongs to a different project.',
        'Reload the version list and choose again.',
      )
    }
    if (chunks.length !== first.chunkCount) {
      return fail(
        'INCOMPLETE_SNAPSHOT',
        `That checkpoint stored ${first.chunkCount} chunks but only ${chunks.length} are present.`,
        'Restore an earlier version; this one cannot be reassembled.',
        { expected: first.chunkCount, actual: chunks.length },
      )
    }
    const text = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex).map((row) => row.data).join('')
    if (checksumOfText(text) !== first.checksum) {
      return fail(
        'CHECKSUM_MISMATCH',
        'The stored checkpoint failed its checksum.',
        'Restore an earlier version; this one is corrupt.',
      )
    }
    const project = this.projects.find((row) => row._id === projectId)
    const decoded = decodeSnapshotUpload({ ...first, chunks: [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex).map((row) => row.data) },
      project && { localProjectId: project.localProjectId, schemaVersion: project.schemaVersion })
    if (!decoded.ok) {
      return fail(
        'INCOMPLETE_SNAPSHOT',
        'The stored checkpoint is not a complete document matching its project and metadata.',
        'Restore an earlier version; this one is corrupt.',
      )
    }
    return {
      ok: true,
      value: {
        projectId: first.projectId,
        branchId: first.branchId,
        groupId: first.groupId,
        kind: first.kind,
        revision: first.revision,
        checksum: first.checksum,
        bytes: first.bytes,
        schemaVersion: first.schemaVersion,
        catalogVersion: first.catalogVersion,
        createdBySubject: first.createdBySubject,
        createdAt: this.iso(first.createdAt),
        document: decoded.value,
      },
    }
  }

  summarise(project: ProjectRow, role: CloudRole): CloudProjectSummary {
    const branch = this.branches.find((row) => row._id === project.defaultBranchId)
    return {
      projectId: project._id,
      localProjectId: project.localProjectId,
      name: project.name,
      ownerSubject: project.ownerSubject,
      visibility: project.visibility,
      role,
      defaultBranchId: branch?._id ?? '',
      headRevision: branch?.headRevision ?? 0,
      schemaVersion: project.schemaVersion,
      catalogVersion: project.catalogVersion,
      createdAt: this.iso(project.createdAt),
      updatedAt: this.iso(project.updatedAt),
    }
  }

  branchRecord(branch: BranchRow): CloudBranchRecord {
    const proposal: MergeProposalRecord | undefined = branch.proposal && {
      intoBranchId: branch.proposal.intoBranchId,
      status: branch.proposal.status,
      proposedBySubject: branch.proposal.proposedBySubject,
      proposedAt: this.iso(branch.proposal.proposedAt),
      decidedBySubject: branch.proposal.decidedBySubject,
      decidedAt: branch.proposal.decidedAt ? this.iso(branch.proposal.decidedAt) : undefined,
      summary: branch.proposal.summary,
    }
    return {
      branchId: branch._id,
      projectId: branch.projectId,
      name: branch.name,
      kind: branch.kind,
      headRevision: branch.headRevision,
      baseRevision: branch.baseRevision,
      forkedFromBranchId: branch.forkedFromBranchId,
      proposal,
      createdBySubject: branch.createdBySubject,
      createdAt: this.iso(branch.createdAt),
      updatedAt: this.iso(branch.updatedAt),
    }
  }

  transactionRecord(row: TransactionRow): CloudTransactionRecord {
    return {
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
      createdAt: this.iso(row.createdAt),
      transaction: row.payload,
    }
  }

  versionRecord(row: VersionRow): CloudVersionRecord {
    return {
      versionId: row._id,
      projectId: row.projectId,
      branchId: row.branchId,
      revision: row.revision,
      label: row.label,
      notes: row.notes,
      snapshotGroupId: row.snapshotGroupId,
      documentChecksum: row.documentChecksum,
      createdBySubject: row.createdBySubject,
      createdAt: this.iso(row.createdAt),
    }
  }

  memberRecord(row: MemberRow): CloudMemberRecord {
    return {
      memberId: row._id,
      projectId: row.projectId,
      subject: row.subject,
      role: row.role,
      displayName: row.displayName,
      invitedBySubject: row.invitedBySubject,
      addedAt: this.iso(row.addedAt),
    }
  }

  invitationRecord(row: InvitationRow): CloudInvitationRecord {
    return {
      invitationId: row._id,
      projectId: row.projectId,
      email: row.email,
      role: row.role,
      status: row.status === 'pending' && row.expiresAt <= this.stamp() ? 'expired' : row.status,
      deliveryStatus: row.deliveryStatus,
      deliveryAttempts: row.deliveryAttempts ?? 0,
      deliveryRetryAt: row.status === 'pending' && row.expiresAt > this.stamp() && !['queued', 'sent'].includes(row.deliveryStatus) ? this.iso(invitationRetryAt(row)) : undefined,
      deliveryReason: row.deliveryReason,
      invitedBySubject: row.invitedBySubject,
      createdAt: this.iso(row.createdAt),
      expiresAt: this.iso(row.expiresAt),
    }
  }

  commentRecord(row: CommentRow): CloudCommentRecord {
    return {
      commentId: row._id,
      projectId: row.projectId,
      branchId: row.branchId,
      authorSubject: row.authorSubject,
      authorDisplayName: row.authorDisplayName,
      body: row.body,
      anchor: row.anchor,
      status: row.status,
      replyToId: row.replyToId,
      resolvedBySubject: row.resolvedBySubject,
      resolvedAt: row.resolvedAt ? this.iso(row.resolvedAt) : undefined,
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
    }
  }

  presenceRecord(row: PresenceRow): CloudPresenceRecord {
    return {
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
      updatedAt: this.iso(row.updatedAt),
      expiresAt: this.iso(row.expiresAt),
    }
  }

  auditRecord(row: AuditRow): CloudAuditRecord {
    return {
      auditId: row._id,
      projectId: row.projectId,
      actorSubject: row.actorSubject,
      action: row.action,
      // Derived from the action, exactly as the deployment derives it for rows
      // written before the split existed.
      category: auditCategory(row.action),
      at: this.iso(row.at),
      detail: row.detail,
    }
  }

  // Exposed so mutations can stamp rows with the shared clock and id source.
  nextId(table: string): string {
    return this.id(table)
  }
  stamp(): number {
    return this.now()
  }
  toIso(at: number): string {
    return this.iso(at)
  }
}

/**
 * The identity-bound half.
 *
 * One instance per signed-in account, which is how the authorisation gates are
 * driven: `deployment.as(alice)` and `deployment.as(bob)` are two callers
 * against one deployment, exactly as two browsers would be.
 */
class FakeConvexBackend implements CloudBackend {
  constructor(
    private readonly db: FakeConvexDeployment,
    private readonly identity: FakeIdentity | null,
  ) {}

  private guard<T>(): CloudResult<T> | null {
    return this.db.offlineFailure<T>()
  }

  private authorise(projectId: string, capability: Capability) {
    return this.db.authorise(this.identity, projectId, capability)
  }

  /** Fixture pagination only. Actual index/cursor behavior is tested against
   * Convex handlers in discovery.integration.test.ts, not this array double. */
  private async page<T>(result: CloudResult<T[]>, args: CloudPageRequest, query: string): Promise<CloudResult<CloudPage<T>>> {
    if (!result.ok) return result
    const limit = args.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return fail('INVALID_ARGUMENT', 'Invalid page size.', 'Use 1 to 100 records.')
    const scope = JSON.stringify([query, this.identity?.subject])
    let offset = 0
    if (args.cursor != null) {
      try {
        const cursor = JSON.parse(args.cursor)
        if (cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error()
        offset = cursor.offset
      } catch { return fail('INVALID_ARGUMENT', 'Invalid cursor scope.', 'Restart the list.') }
    }
    const items = result.value.slice(offset, offset + limit)
    const done = offset + items.length >= result.value.length
    return { ok: true, value: { items, done, cursor: done ? null : JSON.stringify({ scope, offset: offset + items.length }) } }
  }

  async readProjectsPage(args: CloudPageRequest = {}) {
    return this.page(await this.listProjects(), args, 'projects')
  }
  async readBranchesPage(args: ProjectPageRequest) {
    return this.page(await this.listBranches(args), args, `branches:${args.projectId}`)
  }
  async readVersionsPage(args: ProjectPageRequest) {
    return this.page(await this.listVersions(args), args, `versions:${args.projectId}`)
  }
  async readMembersPage(args: ProjectPageRequest) {
    return this.page(await this.listMembers(args), args, `members:${args.projectId}`)
  }
  async readInvitationsPage(args: ProjectPageRequest) {
    return this.page(await this.listInvitations(args), args, `invitations:${args.projectId}`)
  }
  async readCommentsPage(args: CommentPageRequest) {
    const result = await this.listComments(args)
    return this.page(result.ok ? { ok: true, value: result.value.filter(row => args.partId === undefined || row.anchor.partId === args.partId) } : result,
      args, JSON.stringify(['comments', args.projectId, args.status, args.partId]))
  }

  // -- projects ------------------------------------------------------------

  async listProjects(): Promise<CloudResult<CloudProjectSummary[]>> {
    const offline = this.guard<CloudProjectSummary[]>()
    if (offline) return offline
    if (!this.identity) return { ok: false, error: UNAUTHENTICATED }
    const summaries: CloudProjectSummary[] = []
    for (const membership of this.db.members) {
      if (membership.subject !== this.identity.subject) continue
      const project = this.db.project(membership.projectId)
      if (!project) continue
      summaries.push(this.db.summarise(project, membership.role))
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { ok: true, value: summaries }
  }

  async getProject(args: { projectId: string }): Promise<CloudResult<CloudProjectSummary>> {
    const offline = this.guard<CloudProjectSummary>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    return { ok: true, value: this.db.summarise(authorised.value.project, authorised.value.role) }
  }

  async createProject(args: CreateProjectArgs): Promise<CloudResult<CloudProjectSummary>> {
    const offline = this.guard<CloudProjectSummary>()
    if (offline) return offline
    if (!this.identity) return { ok: false, error: UNAUTHENTICATED }
    const name = args.name.trim()
    if (!name) {
      return fail('INVALID_ARGUMENT', 'A project needs a name.', 'Type a name and retry.')
    }
    if (!args.localProjectId.trim() || !args.catalogVersion.trim() || args.schemaVersion !== 2) {
      return fail(args.schemaVersion !== 2 ? 'SCHEMA_MISMATCH' : 'INVALID_ARGUMENT',
        'A cloud project needs a document id, catalogue version and supported schema.',
        'Create the project from a complete schema-2 document.')
    }
    const seed = args.snapshot ? decodeSnapshotUpload(args.snapshot, args) : undefined
    if (seed && !seed.ok) return seed
    const existing = this.db.projects.find(
      (project) =>
        project.ownerSubject === this.identity?.subject &&
        project.localProjectId === args.localProjectId &&
        project.deletedAt === undefined,
    )
    if (existing) {
      if (args.resumeExisting && seed?.ok && existing.creation?.snapshotGroupId &&
          existing.creation.name === name && existing.creation.visibility === (args.visibility ?? 'private')) {
        const authorised = this.authorise(existing._id, 'transaction.write')
        if (!authorised.ok) return authorised
        const initial = this.db.readSnapshot(existing.creation.snapshotGroupId, existing._id)
        if (!initial.ok) return initial
        if (canonicalJson(initial.value.document) === canonicalJson(seed.value)) {
          const branch = this.db.branch(existing)
          if (!branch.ok) return branch
          return { ok: true, value: this.db.summarise(existing, authorised.value.role) }
        }
      }
      return fail(
        'NAME_TAKEN',
        'This account already has a cloud copy of that local project.',
        'Open the existing cloud project instead of claiming it again.',
        { projectId: existing._id },
      )
    }

    const now = this.db.stamp()
    const head = args.snapshot?.revision ?? 0
    const projectId = this.db.nextId('projects')
    const branchId = this.db.nextId('branches')
    const project: ProjectRow = {
      _id: projectId,
      ownerSubject: this.identity.subject,
      name,
      visibility: args.visibility ?? 'private',
      localProjectId: args.localProjectId,
      defaultBranchId: branchId,
      schemaVersion: args.schemaVersion,
      catalogVersion: args.catalogVersion,
      createdAt: now,
      updatedAt: now,
      creation: { name, visibility: args.visibility ?? 'private' },
    }
    if (args.snapshot) {
      const written = this.db.writeSnapshot({
        projectId,
        branchId,
        kind: 'checkpoint',
        upload: args.snapshot,
        createdBySubject: this.identity.subject,
      })
      // Expected refusals have already been validated, before any rows.
      if (!written.ok) return written
      project.creation!.snapshotGroupId = written.value
    }
    this.db.projects.push(project)
    this.db.branches.push({
      _id: branchId,
      projectId,
      name: 'main',
      headRevision: head,
      baseRevision: head,
      kind: 'main',
      createdBySubject: this.identity.subject,
      createdAt: now,
      updatedAt: now,
    })
    this.db.members.push({
      _id: this.db.nextId('members'),
      projectId,
      subject: this.identity.subject,
      role: 'owner',
      displayName: this.identity.displayName,
      addedAt: now,
    })
    this.db.audit(projectId, this.identity.subject, 'project.create', {
      headRevision: head,
      seeded: Boolean(args.snapshot),
    })
    return { ok: true, value: this.db.summarise(project, 'owner') }
  }

  async renameProject(args: { projectId: string; name: string }): Promise<CloudResult<CloudProjectSummary>> {
    const offline = this.guard<CloudProjectSummary>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.rename')
    if (!authorised.ok) return authorised
    const name = args.name.trim()
    if (!name) {
      return fail('INVALID_ARGUMENT', 'A project needs a name.', 'Type a name and retry.')
    }
    const { project, identity, role } = authorised.value
    project.name = name
    project.updatedAt = this.db.stamp()
    this.db.audit(project._id, identity.subject, 'project.rename', { nameLength: name.length })
    return { ok: true, value: this.db.summarise(project, role) }
  }

  async setVisibility(args: {
    projectId: string
    visibility: ProjectVisibility
  }): Promise<CloudResult<CloudProjectSummary>> {
    const offline = this.guard<CloudProjectSummary>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.delete')
    if (!authorised.ok) return authorised
    const { project, identity, role } = authorised.value
    project.visibility = args.visibility
    project.updatedAt = this.db.stamp()
    this.db.audit(project._id, identity.subject, 'project.setVisibility', {
      visibility: args.visibility,
    })
    return { ok: true, value: this.db.summarise(project, role) }
  }

  async deleteProject(args: {
    projectId: string
  }): Promise<CloudResult<{ projectId: string; deletedAt: string }>> {
    const offline = this.guard<{ projectId: string; deletedAt: string }>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.delete')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const now = this.db.stamp()
    project.deletedAt = now
    project.updatedAt = now
    this.db.audit(project._id, identity.subject, 'project.delete', { soft: true })
    return { ok: true, value: { projectId: project._id, deletedAt: this.db.toIso(now) } }
  }

  async saveCheckpoint(args: {
    projectId: string
    branchId?: string
    snapshot: SnapshotUpload
  }): Promise<CloudResult<{ groupId: string; revision: number }>> {
    const offline = this.guard<{ groupId: string; revision: number }>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'snapshot.write')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const branch = this.db.branch(project, args.branchId)
    if (!branch.ok) return branch
    const valid = decodeSnapshotUpload(args.snapshot, { localProjectId: project.localProjectId, schemaVersion: project.schemaVersion })
    if (!valid.ok) return valid
    if (args.snapshot.revision > branch.value.headRevision) {
      return fail('STALE_DOCUMENT', 'A checkpoint cannot precede the transactions that establish its revision.',
        'Sync the missing transactions before retrying this checkpoint; keep the local copy.',
        { headRevision: branch.value.headRevision, branchId: branch.value._id })
    }
    const written = this.db.writeSnapshot({
      projectId: project._id,
      branchId: branch.value._id,
      kind: 'checkpoint',
      upload: args.snapshot,
      createdBySubject: identity.subject,
    })
    if (!written.ok) return written
    project.updatedAt = this.db.stamp()
    this.db.audit(project._id, identity.subject, 'project.checkpoint', {
      revision: args.snapshot.revision,
      bytes: args.snapshot.bytes,
    })
    return { ok: true, value: { groupId: written.value, revision: args.snapshot.revision } }
  }

  async latestCheckpoint(args: {
    projectId: string
    branchId?: string
    atRevision?: number
  }): Promise<CloudResult<CloudSnapshotRecord | null>> {
    const offline = this.guard<CloudSnapshotRecord | null>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const branch = this.db.branch(authorised.value.project, args.branchId)
    if (!branch.ok) return branch
    const ceiling = Math.min(args.atRevision ?? branch.value.headRevision, branch.value.headRevision)
    const candidates = this.db.snapshots
      .filter(
        (row) =>
          row.projectId === authorised.value.project._id &&
          row.kind === 'checkpoint' &&
          row.chunkIndex === 0 &&
          row.revision <= ceiling &&
          row.branchId === branch.value._id,
      )
      .sort((a, b) => b.revision - a.revision || b.createdAt - a.createdAt)
    const newest = candidates[0]
    if (!newest) return { ok: true, value: null }
    return this.db.readSnapshot(newest.groupId, authorised.value.project._id)
  }

  async auditTrail(args: { projectId: string; limit?: number }): Promise<CloudResult<CloudAuditRecord[]>> {
    const offline = this.guard<CloudAuditRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'audit.read')
    if (!authorised.ok) return authorised
    const rows = this.db.auditEvents
      .filter((row) => row.projectId === authorised.value.project._id)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.min(Math.max(args.limit ?? 100, 1), 500))
    return { ok: true, value: rows.map((row) => this.db.auditRecord(row)) }
  }

  // -- transactions --------------------------------------------------------

  /**
   * Compare-and-advance, in the same order as `convex/transactions.ts`.
   *
   * Runs to completion without awaiting, so two callers at the same base
   * revision cannot interleave: the second sees the head the first advanced and
   * is refused with `STALE_DOCUMENT`.
   */
  async appendTransaction(args: AppendTransactionArgs): Promise<CloudResult<AppendTransactionValue>> {
    const offline = this.guard<AppendTransactionValue>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'transaction.write')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value

    if (!args.clientTransactionId) {
      return fail(
        'INVALID_ARGUMENT',
        'A transaction must carry the client transaction id that makes it idempotent.',
        'Send `Transaction.id` as `clientTransactionId`.',
      )
    }
    if (args.resultRevision !== args.baseRevision + 1) {
      return fail(
        'INVALID_ARGUMENT',
        `A transaction must advance the revision by one; this one went ${args.baseRevision} → ${args.resultRevision}.`,
        'Re-derive the transaction from the engine rather than renumbering it by hand.',
      )
    }
    if (args.schemaVersion !== project.schemaVersion) {
      return fail(
        'SCHEMA_MISMATCH',
        `This project is stored at document schema ${project.schemaVersion}; the transaction is schema ${args.schemaVersion}.`,
        'Reload the application so both sides agree on the document schema.',
        { expected: project.schemaVersion, actual: args.schemaVersion },
      )
    }

    const serialized = canonicalJson(args.transaction)
    const bytes = utf8Bytes(serialized)
    if (bytes > MAX_TRANSACTION_BYTES) {
      return fail(
        'PAYLOAD_TOO_LARGE',
        `That transaction is ${Math.round(bytes / 1024)} KiB; the ceiling is ${Math.round(
          MAX_TRANSACTION_BYTES / 1024,
        )} KiB.`,
        'Split the edit into smaller commits; it stays in the local log either way.',
        { bytes, limit: MAX_TRANSACTION_BYTES },
      )
    }
    const digest = checksumOfText(serialized)
    if (digest !== args.checksum) {
      return fail(
        'CHECKSUM_MISMATCH',
        'The transaction does not match the checksum sent with it.',
        'Re-queue the transaction from the local log; the payload was altered in flight.',
        { expected: args.checksum, actual: digest },
      )
    }

    const replayable = verifyHistoryRecord(args, args.baseRevision)
    if (!replayable.ok)
      return fail(
        'INVALID_ARGUMENT',
        replayable.error.message,
        'Re-derive the complete transaction from the engine; its id, revisions and patch must match the request.',
      )

    const branchResult = this.db.branch(project, args.branchId)
    if (!branchResult.ok) return branchResult
    const branch = branchResult.value

    const existing = this.db.transactions.find(
      (row) =>
        row.projectId === project._id &&
        row.branchId === branch._id &&
        row.clientTransactionId === args.clientTransactionId,
    )
    if (existing) {
      if (existing.checksum !== digest) {
        return fail(
          'INVALID_ARGUMENT',
          'That transaction id is already stored with different content.',
          'Mint a fresh transaction id; ids are not reusable.',
          { clientTransactionId: args.clientTransactionId },
        )
      }
      return {
        ok: true,
        value: {
          transactionId: existing._id,
          branchId: existing.branchId,
          headRevision: branch.headRevision,
          applied: false,
        },
      }
    }

    if (branch.headRevision !== args.baseRevision) {
      return fail(
        'STALE_DOCUMENT',
        `This edit was made against revision ${args.baseRevision}; the branch is at ${branch.headRevision}.`,
        'Rebase the local tail onto the cloud head, or keep both histories as a conflict fork.',
        { headRevision: branch.headRevision, branchId: branch._id },
      )
    }

    const now = this.db.stamp()
    const transactionId = this.db.nextId('transactions')
    this.db.transactions.push({
      _id: transactionId,
      projectId: project._id,
      branchId: branch._id,
      clientTransactionId: args.clientTransactionId,
      baseRevision: args.baseRevision,
      resultRevision: args.resultRevision,
      authorSubject: identity.subject,
      payload: args.transaction,
      checksum: digest,
      bytes,
      schemaVersion: args.schemaVersion,
      catalogVersion: args.catalogVersion,
      createdAt: now,
    })
    branch.headRevision = args.resultRevision
    branch.updatedAt = now
    project.updatedAt = now
    this.db.audit(project._id, identity.subject, 'transaction.append', {
      revision: args.resultRevision,
      bytes,
      branch: branch.name,
    })
    return {
      ok: true,
      value: {
        transactionId,
        branchId: branch._id,
        headRevision: args.resultRevision,
        applied: true,
      },
    }
  }

  async listTransactions(args: {
    projectId: string
    branchId?: string
    sinceRevision: number
    limit?: number
  }): Promise<CloudResult<CloudTransactionRecord[]>> {
    const offline = this.guard<CloudTransactionRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const branch = this.db.branch(authorised.value.project, args.branchId)
    if (!branch.ok) return branch
    const rows = this.db.transactions
      .filter((row) => row.branchId === branch.value._id && row.resultRevision > args.sinceRevision)
      .sort((a, b) => a.resultRevision - b.resultRevision)
      .slice(0, Math.min(Math.max(args.limit ?? 500, 1), 2000))
    return { ok: true, value: rows.map((row) => this.db.transactionRecord(row)) }
  }

  async readHistory(args: ReadHistoryArgs): Promise<CloudResult<CloudHistoryPage>> {
    const offline = this.guard<CloudHistoryPage>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const branch = this.db.branch(authorised.value.project, args.branchId)
    if (!branch.ok) return branch
    const db = this.db
    return readBranchHistory(
      {
        async branch(id) {
          const row = db.branches.find((row) => row._id === id)
          return row ? db.branchRecord(row) : null
        },
        async *transactions(branchId, after, through) {
          const rows = db.transactions
            .filter((row) => row.branchId === branchId && row.resultRevision > after && row.resultRevision <= through)
            .sort((a, b) => a.resultRevision - b.resultRevision)
          for (const row of rows) yield db.transactionRecord(row)
        },
      },
      db.branchRecord(branch.value),
      args,
    )
  }

  async findTransaction(args: {
    projectId: string
    branchId?: string
    clientTransactionId: string
  }): Promise<CloudResult<CloudTransactionRecord | null>> {
    const offline = this.guard<CloudTransactionRecord | null>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const branch = this.db.branch(authorised.value.project, args.branchId)
    if (!branch.ok) return branch
    const row = this.db.transactions.find(
      (candidate) =>
        candidate.projectId === authorised.value.project._id &&
        candidate.branchId === branch.value._id &&
        candidate.clientTransactionId === args.clientTransactionId,
    )
    return { ok: true, value: row ? this.db.transactionRecord(row) : null }
  }

  // -- versions and branches ----------------------------------------------

  async listBranches(args: { projectId: string }): Promise<CloudResult<CloudBranchRecord[]>> {
    const offline = this.guard<CloudBranchRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const rows = this.db.branches.filter((row) => row.projectId === authorised.value.project._id)
    return { ok: true, value: rows.map((row) => this.db.branchRecord(row)) }
  }

  async createBranch(args: CreateBranchArgs): Promise<CloudResult<CloudBranchRecord>> {
    const offline = this.guard<CloudBranchRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'branch.create')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const name = args.name.trim()
    if (!name) {
      return fail('INVALID_ARGUMENT', 'A branch needs a name.', 'Name the branch and retry.')
    }
    const parent = this.db.branch(project, args.fromBranchId)
    if (!parent.ok) return parent
    const recovery = args.recovery
    if (
      recovery &&
      (args.kind !== 'conflict' ||
        args.atRevision === undefined ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(recovery.key) ||
        recovery.snapshot.revision !== args.atRevision)
    )
      return fail(
        'INVALID_ARGUMENT',
        'Recovery needs a stable key and an exact checkpoint.',
        'Retry the original request.',
      )
    const seed = recovery
      ? decodeSnapshotUpload(recovery.snapshot, {
          localProjectId: project.localProjectId,
          schemaVersion: project.schemaVersion,
        })
      : undefined
    if (seed && !seed.ok) return seed
    if (recovery && seed?.ok) {
      const existing = this.db.branches.find(
        (row) =>
          row.projectId === project._id &&
          row.createdBySubject === identity.subject &&
          row.recoveryKey === recovery.key,
      )
      if (existing) {
        if (
          existing.kind !== 'conflict' ||
          existing.name !== name ||
          existing.forkedFromBranchId !== parent.value._id ||
          existing.baseRevision !== args.atRevision ||
          !existing.recoverySnapshotGroupId
        )
          return fail('INVALID_ARGUMENT', 'This key identifies another fork.', 'Retry the original request.')
        const original = this.db.readSnapshot(existing.recoverySnapshotGroupId, project._id)
        if (!original.ok) return original
        if (canonicalJson(original.value.document) !== canonicalJson(seed.value))
          return fail('INVALID_ARGUMENT', 'This key identifies another checkpoint.', 'Retry the original request.')
        return { ok: true, value: this.db.branchRecord(existing) }
      }
    }
    const clash = this.db.branches.find((row) => row.projectId === project._id && row.name === name)
    if (clash) {
      return fail('NAME_TAKEN', 'This project already has a branch with that name.', 'Choose another name.', {
        branchId: clash._id,
      })
    }
    const at = args.atRevision ?? parent.value.headRevision
    if (!Number.isSafeInteger(at) || at < 0 || at > parent.value.headRevision) {
      return fail(
        'INVALID_ARGUMENT',
        `A branch cannot fork at revision ${at}; ${parent.value.name} runs to ${parent.value.headRevision}.`,
        'Fork at the divergence revision or at the branch head.',
      )
    }
    const now = this.db.stamp()
    const kind = args.kind ?? 'named'
    const parentCheckpoint = this.db.snapshots
      .filter(
        (row) =>
          row.projectId === project._id &&
          row.kind === 'checkpoint' &&
          row.chunkIndex === 0 &&
          row.branchId === parent.value._id &&
          row.revision <= at,
      )
      .sort((a, b) => b.revision - a.revision)[0]
    if (!parentCheckpoint && kind !== 'conflict') {
      return fail(
        'NOT_FOUND',
        'The source branch has no checkpoint to copy, so the new branch would not open.',
        'Save the source branch once, then create the named branch.',
      )
    }
    const branch: BranchRow = {
      _id: this.db.nextId('branches'),
      projectId: project._id,
      name,
      headRevision: at,
      baseRevision: at,
      forkedFromBranchId: parent.value._id,
      kind,
      createdBySubject: identity.subject,
      recoveryKey: recovery?.key,
      createdAt: now,
      updatedAt: now,
    }
    this.db.branches.push(branch)
    if (recovery) {
      const seeded = this.db.writeSnapshot({
        projectId: project._id,
        branchId: branch._id,
        kind: 'checkpoint',
        createdBySubject: identity.subject,
        upload: recovery.snapshot,
      })
      if (!seeded.ok) {
        this.db.branches.pop()
        return seeded
      }
      branch.recoverySnapshotGroupId = seeded.value
    } else if (parentCheckpoint) {
      const chunks = this.db.snapshots.filter((row) => row.groupId === parentCheckpoint.groupId)
      if (chunks.length !== parentCheckpoint.chunkCount) {
        this.db.branches.pop()
        return fail(
          'INCOMPLETE_SNAPSHOT',
          'The parent branch checkpoint cannot be copied because it is incomplete.',
          'Save a checkpoint on the source branch and create the branch again.',
        )
      }
      const groupId = this.db.nextId('snapgroup')
      const createdAt = this.db.stamp()
      for (const chunk of chunks) {
        this.db.snapshots.push({
          ...chunk,
          _id: this.db.nextId('snapshots'),
          branchId: branch._id,
          groupId,
          createdBySubject: identity.subject,
          createdAt,
        })
      }
    }
    this.db.audit(project._id, identity.subject, 'branch.create', {
      branch: name,
      from: parent.value.name,
      atRevision: at,
    })
    return { ok: true, value: this.db.branchRecord(branch) }
  }

  async proposeMerge(args: {
    projectId: string
    branchId: string
    intoBranchId?: string
    summary: string
  }): Promise<CloudResult<CloudBranchRecord>> {
    const offline = this.guard<CloudBranchRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'branch.propose')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const source = this.db.branch(project, args.branchId)
    if (!source.ok) return source
    const target = this.db.branch(project, args.intoBranchId)
    if (!target.ok) return target
    if (source.value._id === target.value._id) {
      return fail('INVALID_ARGUMENT', 'A branch cannot be merged into itself.', 'Pick a different target branch.')
    }
    if (source.value.proposal?.status === 'open') {
      return fail(
        'INVALID_ARGUMENT',
        'That branch already has an open merge proposal.',
        'Withdraw the open proposal before opening another.',
      )
    }
    const now = this.db.stamp()
    source.value.proposal = {
      intoBranchId: target.value._id,
      status: 'open',
      proposedBySubject: identity.subject,
      proposedAt: now,
      summary: args.summary.slice(0, 500),
    }
    source.value.updatedAt = now
    this.db.audit(project._id, identity.subject, 'branch.propose', {
      branch: source.value.name,
      into: target.value.name,
    })
    return { ok: true, value: this.db.branchRecord(source.value) }
  }

  async decideMerge(args: {
    projectId: string
    branchId: string
    decision: 'merged' | 'rejected' | 'withdrawn'
  }): Promise<CloudResult<CloudBranchRecord>> {
    const offline = this.guard<CloudBranchRecord>()
    if (offline) return offline
    const capability: Capability =
      args.decision === 'withdrawn' ? 'branch.propose' : 'branch.merge'
    const authorised = this.authorise(args.projectId, capability)
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const source = this.db.branch(project, args.branchId)
    if (!source.ok) return source
    const branch = source.value
    if (!branch.proposal || branch.proposal.status !== 'open') {
      return fail('NOT_FOUND', 'That branch has no open merge proposal.', 'Open a proposal before deciding on one.')
    }
    if (args.decision === 'withdrawn' && branch.proposal.proposedBySubject !== identity.subject) {
      return fail('FORBIDDEN', 'Only the author of a proposal may withdraw it.', 'Ask an owner to reject it instead.')
    }
    const now = this.db.stamp()
    branch.proposal = {
      ...branch.proposal,
      status: args.decision,
      decidedBySubject: identity.subject,
      decidedAt: now,
    }
    branch.updatedAt = now
    this.db.audit(project._id, identity.subject, `branch.${args.decision}`, {
      branch: branch.name,
      atRevision: branch.headRevision,
      decidedAt: this.db.toIso(now),
    })
    return { ok: true, value: this.db.branchRecord(branch) }
  }

  /** Mirrors `convex/versions.ts:removeBranch`: creator or owner, nothing depending on it. */
  async removeBranch(args: { projectId: string; branchId: string }): Promise<CloudResult<{ removed: boolean }>> {
    const offline = this.guard<{ removed: boolean }>()
    if (offline) return offline
    const reader = this.authorise(args.projectId, 'project.read')
    if (!reader.ok) return reader
    const { project, identity } = reader.value
    const branch = this.db.branch(project, args.branchId)
    if (!branch.ok) return branch
    const row = branch.value
    if (row._id === project.defaultBranchId) {
      return fail(
        'FORBIDDEN',
        'The default branch cannot be deleted.',
        'Delete the project instead; every other branch forks from this one.',
      )
    }
    if (row.proposal?.status === 'open') {
      return fail(
        'FORBIDDEN',
        'That branch has an open merge proposal.',
        'Withdraw or decide the proposal first, so the decision is recorded.',
      )
    }
    if (this.db.branches.some((other) => other.forkedFromBranchId === row._id)) {
      return fail(
        'FORBIDDEN',
        'Another branch was forked from this one.',
        'Delete the branches that fork from it first; their history replays through this one.',
      )
    }
    if (this.db.versions.some((version) => version.branchId === row._id)) {
      return fail(
        'FORBIDDEN',
        'That branch holds saved versions.',
        'Delete the versions saved on it first; a version is a point in history somebody named.',
      )
    }
    if (row.createdBySubject !== identity.subject) {
      const authorised = this.authorise(args.projectId, 'project.delete')
      if (!authorised.ok) return authorised
    }
    this.db.branches.splice(this.db.branches.indexOf(row), 1)
    for (const edit of this.db.transactions.filter((entry) => entry.branchId === row._id)) {
      this.db.transactions.splice(this.db.transactions.indexOf(edit), 1)
    }
    for (const chunk of this.db.snapshots.filter((entry) => entry.branchId === row._id)) {
      this.db.snapshots.splice(this.db.snapshots.indexOf(chunk), 1)
    }
    return { ok: true, value: { removed: true } }
  }

  /** Mirrors `convex/versions.ts:remove`: creator, or an owner. */
  async removeVersion(args: { projectId: string; versionId: string }): Promise<CloudResult<{ removed: boolean }>> {
    const offline = this.guard<{ removed: boolean }>()
    if (offline) return offline
    const reader = this.authorise(args.projectId, 'project.read')
    if (!reader.ok) return reader
    const { project, identity } = reader.value
    const version = this.db.versions.find((row) => row._id === args.versionId)
    if (!version || version.projectId !== project._id) {
      return fail(
        'NOT_FOUND',
        'That version does not belong to this project.',
        'Reload the version list and choose again.',
      )
    }
    if (version.createdBySubject !== identity.subject) {
      const authorised = this.authorise(args.projectId, 'project.delete')
      if (!authorised.ok) return authorised
    }
    this.db.versions.splice(this.db.versions.indexOf(version), 1)
    for (const chunk of this.db.snapshots.filter((row) => row.groupId === version.snapshotGroupId)) {
      this.db.snapshots.splice(this.db.snapshots.indexOf(chunk), 1)
    }
    return { ok: true, value: { removed: true } }
  }

  async createVersion(args: CreateVersionArgs): Promise<CloudResult<CloudVersionRecord>> {
    const offline = this.guard<CloudVersionRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'version.create')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const label = args.label.trim()
    if (!label) {
      return fail('INVALID_ARGUMENT', 'A version needs a label.', 'Name the version and retry.')
    }
    const branch = this.db.branch(project, args.branchId)
    if (!branch.ok) return branch
    const clash = this.db.versions.find((row) => row.projectId === project._id && row.label === label)
    if (clash) {
      return fail(
        'NAME_TAKEN',
        'This project already has a version with that label.',
        'Choose a different label; versions are never overwritten.',
        { versionId: clash._id },
      )
    }
    const written = this.db.writeSnapshot({
      projectId: project._id,
      branchId: branch.value._id,
      kind: 'version',
      upload: args.snapshot,
      createdBySubject: identity.subject,
    })
    if (!written.ok) return written
    const version: VersionRow = {
      _id: this.db.nextId('versions'),
      projectId: project._id,
      branchId: branch.value._id,
      revision: args.snapshot.revision,
      label,
      notes: args.notes,
      snapshotGroupId: written.value,
      documentChecksum: args.snapshot.checksum,
      createdBySubject: identity.subject,
      createdAt: this.db.stamp(),
    }
    this.db.versions.push(version)
    this.db.audit(project._id, identity.subject, 'version.create', {
      revision: args.snapshot.revision,
      bytes: args.snapshot.bytes,
      branch: branch.value.name,
    })
    return { ok: true, value: this.db.versionRecord(version) }
  }

  async listVersions(args: { projectId: string }): Promise<CloudResult<CloudVersionRecord[]>> {
    const offline = this.guard<CloudVersionRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const rows = this.db.versions
      .filter((row) => row.projectId === authorised.value.project._id)
      .sort((a, b) => b.createdAt - a.createdAt)
    return { ok: true, value: rows.map((row) => this.db.versionRecord(row)) }
  }

  async versionDocument(args: { projectId: string; versionId: string }): Promise<CloudResult<CloudSnapshotRecord>> {
    const offline = this.guard<CloudSnapshotRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'project.read')
    if (!authorised.ok) return authorised
    const version = this.db.versions.find((row) => row._id === args.versionId)
    if (!version || version.projectId !== authorised.value.project._id) {
      return fail(
        'NOT_FOUND',
        'That version does not belong to this project.',
        'Reload the version list and choose again.',
      )
    }
    return this.db.readSnapshot(version.snapshotGroupId, authorised.value.project._id)
  }

  // -- members and invitations --------------------------------------------

  async listMembers(args: { projectId: string }): Promise<CloudResult<CloudMemberRecord[]>> {
    const offline = this.guard<CloudMemberRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'member.list')
    if (!authorised.ok) return authorised
    const rows = this.db.members.filter((row) => row.projectId === authorised.value.project._id)
    return { ok: true, value: rows.map((row) => this.db.memberRecord(row)) }
  }

  async myRole(args: { projectId: string }): Promise<CloudResult<CloudRole | null>> {
    const offline = this.guard<CloudRole | null>()
    if (offline) return offline
    if (!this.identity) return { ok: false, error: UNAUTHENTICATED }
    const project = this.db.project(args.projectId)
    if (!project) return { ok: true, value: null }
    const explicit = this.db.membership(project._id, this.identity.subject)?.role ?? null
    if (explicit) return { ok: true, value: explicit }
    return { ok: true, value: project.visibility === 'public' ? 'viewer' : null }
  }

  async setMemberRole(args: {
    projectId: string
    subject: string
    role: Exclude<CloudRole, 'owner'>
  }): Promise<CloudResult<CloudMemberRecord>> {
    const offline = this.guard<CloudMemberRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'member.setRole')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    if (args.subject === project.ownerSubject) {
      return fail(
        'FORBIDDEN',
        "The owner's role cannot be changed.",
        'The owner role stays with the account that created the project.',
      )
    }
    const membership = this.db.membership(project._id, args.subject)
    if (!membership) {
      return fail('NOT_FOUND', 'That account is not a member of this project.', 'Invite them first.')
    }
    membership.role = args.role
    this.db.audit(project._id, identity.subject, 'member.setRole', {
      subject: args.subject,
      role: args.role,
    })
    return { ok: true, value: this.db.memberRecord(membership) }
  }

  async removeMember(args: { projectId: string; subject: string }): Promise<CloudResult<{ removed: boolean }>> {
    const offline = this.guard<{ removed: boolean }>()
    if (offline) return offline
    if (!this.identity) return { ok: false, error: UNAUTHENTICATED }
    const leaving = this.identity.subject === args.subject
    const authorised = this.authorise(args.projectId, leaving ? 'project.read' : 'member.remove')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    if (args.subject === project.ownerSubject) {
      return fail(
        'FORBIDDEN',
        'The owner cannot be removed from their own project.',
        'The owner cannot leave this project. Delete it instead, or keep the owner account signed in.',
      )
    }
    const index = this.db.members.findIndex((row) => row.projectId === project._id && row.subject === args.subject)
    if (index < 0) return { ok: true, value: { removed: false } }
    this.db.members.splice(index, 1)
    for (let cursor = this.db.presence.length - 1; cursor >= 0; cursor -= 1) {
      const row = this.db.presence[cursor]
      if (row.projectId === project._id && row.subject === args.subject) {
        this.db.presence.splice(cursor, 1)
      }
    }
    this.db.audit(project._id, identity.subject, leaving ? 'member.leave' : 'member.remove', { subject: args.subject })
    return { ok: true, value: { removed: true } }
  }

  async listInvitations(args: { projectId: string }): Promise<CloudResult<CloudInvitationRecord[]>> {
    const offline = this.guard<CloudInvitationRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'member.invite')
    if (!authorised.ok) return authorised
    const rows = this.db.invitations.filter((row) => row.projectId === authorised.value.project._id)
    return { ok: true, value: rows.map((row) => this.db.invitationRecord(row)) }
  }

  async createInvitation(args: {
    projectId: string
    email: string
    role: Exclude<CloudRole, 'owner'>
  }): Promise<CloudResult<CloudInvitationRecord>> {
    const offline = this.guard<CloudInvitationRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'member.invite')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const email = args.email.trim().toLowerCase()
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail('INVALID_ARGUMENT', 'That does not look like an email address.', 'Check the address and retry.')
    }
    const duplicate = this.db.invitations.find(
      (row) => row.projectId === project._id && row.email === email && row.status === 'pending' && row.expiresAt > this.db.stamp(),
    )
    if (duplicate) {
      return fail(
        'NAME_TAKEN',
        'That address already has a pending invitation to this project.',
        'Retry delivery for the existing invitation, or revoke it before creating another.',
        { invitationId: duplicate._id },
      )
    }
    const now = this.db.stamp()
    const invitation: InvitationRow = {
      _id: this.db.nextId('invitations'),
      projectId: project._id,
      email,
      role: args.role,
      token: `${this.db.nextId('token')}_${now}`,
      invitedBySubject: identity.subject,
      createdAt: now,
      expiresAt: now + 14 * 24 * 60 * 60 * 1000,
      status: 'pending',
      // No delivery endpoint exists in-process, so the honest answer is the
      // same one the deployment gives with the variables unset.
      deliveryStatus: 'not-configured',
      deliveryGeneration: 0,
      deliveryAttempts: 1,
      deliveryRequestedAt: now,
      deliveryReason:
        'Email delivery is not configured in this in-process backend (no Hexclave or INVITATION_EMAIL_ENDPOINT transport); no external request was made.',
    }
    this.db.invitations.push(invitation)
    this.db.audit(project._id, identity.subject, 'invitation.create', { role: args.role })
    return { ok: true, value: this.db.invitationRecord(invitation) }
  }

  async retryInvitationDelivery(args: { projectId: string; invitationId: string }): Promise<CloudResult<CloudInvitationRecord>> {
    const offline = this.guard<CloudInvitationRecord>()
    if (offline) return offline
    const auth = this.authorise(args.projectId, 'member.invite')
    if (!auth.ok) return auth
    const row = this.db.invitations.find(row => row._id === args.invitationId && row.projectId === args.projectId)
    if (!row) return fail('NOT_FOUND', 'That invitation is not available.', 'Reload the invitations.')
    const now = this.db.stamp()
    if (row.status !== 'pending' || row.expiresAt <= now || ['queued', 'sent'].includes(row.deliveryStatus))
      return fail('INVALID_ARGUMENT', 'Only a pending unexpired invitation can be retried.', 'Create a new invitation if needed.')
    if (now < invitationRetryAt(row)) {
      if (['pending', 'sending'].includes(row.deliveryStatus)) return { ok: true, value: this.db.invitationRecord(row) }
      return fail('INVALID_ARGUMENT', 'Wait before retrying delivery.', 'Retry after the cooldown.')
    }
    row.deliveryGeneration = (row.deliveryGeneration ?? 0) + 1
    row.deliveryStatus = 'pending'
    row.deliveryRequestedAt = now
    row.deliveryStartedAt = undefined
    row.deliveryReason = 'Delivery retry is queued. A previous unconfirmed request may already have sent an email.'
    this.db.audit(args.projectId, auth.value.identity.subject, 'invitation.retryDelivery', { generation: row.deliveryGeneration, role: row.role })
    return { ok: true, value: this.db.invitationRecord(row) }
  }

  async revokeInvitation(args: {
    projectId: string
    invitationId: string
  }): Promise<CloudResult<{ revoked: boolean }>> {
    const offline = this.guard<{ revoked: boolean }>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'member.invite')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const invitation = this.db.invitations.find((row) => row._id === args.invitationId)
    if (!invitation || invitation.projectId !== project._id) {
      return fail('NOT_FOUND', 'That invitation does not belong to this project.', 'Reload the invitation list.')
    }
    if (invitation.status !== 'pending') return { ok: true, value: { revoked: false } }
    invitation.status = 'revoked'
    if (['pending', 'sending'].includes(invitation.deliveryStatus)) invitation.deliveryStatus = 'cancelled'
    this.db.audit(project._id, identity.subject, 'invitation.revoke', { role: invitation.role })
    return { ok: true, value: { revoked: true } }
  }

  async acceptInvitation(args: {
    token: string
  }): Promise<CloudResult<{ projectId: string; role: string }>> {
    const offline = this.guard<{ projectId: string; role: string }>()
    if (offline) return offline
    if (!this.identity) return { ok: false, error: UNAUTHENTICATED }
    const invitation = this.db.invitations.find((row) => row.token === args.token)
    if (invitation?.status === 'accepted' && invitation.acceptedBySubject === this.identity.subject) {
      const project = this.db.project(invitation.projectId)
      const member = this.db.membership(invitation.projectId, this.identity.subject)
      if (project && member) return { ok: true, value: { projectId: project._id, role: member.role } }
    }
    if (!invitation || invitation.status !== 'pending') {
      return fail(
        'NOT_FOUND',
        'That invitation link is not valid any more.',
        'Ask the project owner to send a fresh invitation.',
      )
    }
    if (invitation.expiresAt <= this.db.stamp()) {
      invitation.status = 'expired'
      return fail('NOT_FOUND', 'That invitation has expired.', 'Ask the project owner to send a fresh invitation.')
    }
    const project = this.db.project(invitation.projectId)
    if (!project) {
      return fail(
        'NOT_FOUND',
        'The project this invitation points at is no longer available.',
        'Ask the owner whether it was deleted.',
      )
    }
    const now = this.db.stamp()
    const existing = this.db.membership(project._id, this.identity.subject)
    invitation.status = 'accepted'
    if (['pending', 'sending'].includes(invitation.deliveryStatus)) invitation.deliveryStatus = 'cancelled'
    invitation.acceptedBySubject = this.identity.subject
    invitation.acceptedAt = now
    if (existing) return { ok: true, value: { projectId: project._id, role: existing.role } }
    this.db.members.push({
      _id: this.db.nextId('members'),
      projectId: project._id,
      subject: this.identity.subject,
      role: invitation.role,
      displayName: this.identity.displayName,
      invitedBySubject: invitation.invitedBySubject,
      addedAt: now,
    })
    this.db.audit(project._id, this.identity.subject, 'invitation.accept', {
      role: invitation.role,
    })
    return { ok: true, value: { projectId: project._id, role: invitation.role } }
  }

  // -- comments ------------------------------------------------------------

  async listComments(args: {
    projectId: string
    status?: 'open' | 'resolved'
  }): Promise<CloudResult<CloudCommentRecord[]>> {
    const offline = this.guard<CloudCommentRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'comment.read')
    if (!authorised.ok) return authorised
    const rows = this.db.comments
      .filter((row) => row.projectId === authorised.value.project._id)
      .filter((row) => (args.status ? row.status === args.status : true))
      .sort((a, b) => a.createdAt - b.createdAt)
    return { ok: true, value: rows.map((row) => this.db.commentRecord(row)) }
  }

  async commentsForPart(args: { projectId: string; partId: string }): Promise<CloudResult<CloudCommentRecord[]>> {
    const offline = this.guard<CloudCommentRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'comment.read')
    if (!authorised.ok) return authorised
    const rows = this.db.comments
      .filter((row) => row.projectId === authorised.value.project._id && row.anchor.partId === args.partId)
      .sort((a, b) => a.createdAt - b.createdAt)
    return { ok: true, value: rows.map((row) => this.db.commentRecord(row)) }
  }

  /** Mirrors `convex/comments.ts:remove`: author, or `comment.resolve`. */
  async removeComment(args: { projectId: string; commentId: string }): Promise<CloudResult<{ removed: number }>> {
    const offline = this.guard<{ removed: number }>()
    if (offline) return offline
    const reader = this.authorise(args.projectId, 'comment.read')
    if (!reader.ok) return reader
    const { project, identity } = reader.value
    const comment = this.db.comments.find((row) => row._id === args.commentId)
    if (!comment || comment.projectId !== project._id) {
      return fail('NOT_FOUND', 'That comment is not in this project.', 'Reload the comment list.')
    }
    if (comment.authorSubject !== identity.subject) {
      const authorised = this.authorise(args.projectId, 'comment.resolve')
      if (!authorised.ok) return authorised
    }
    const doomed = this.db.comments.filter(
      (row) => row._id === comment._id || (row.projectId === project._id && row.replyToId === comment._id),
    )
    for (const row of doomed) this.db.comments.splice(this.db.comments.indexOf(row), 1)
    return { ok: true, value: { removed: doomed.length } }
  }

  async addComment(args: AddCommentArgs): Promise<CloudResult<CloudCommentRecord>> {
    const offline = this.guard<CloudCommentRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'comment.create')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    const body = args.body.trim()
    if (!body) {
      return fail('INVALID_ARGUMENT', 'A comment needs a body.', 'Type something and retry.')
    }
    if (utf8Bytes(body) > MAX_COMMENT_BYTES) {
      return fail(
        'PAYLOAD_TOO_LARGE',
        `That comment is longer than the ${MAX_COMMENT_BYTES} byte limit.`,
        'Shorten it, or attach the detail to a build note in the document instead.',
        { limit: MAX_COMMENT_BYTES },
      )
    }
    const branch = this.db.branch(project, args.branchId)
    if (!branch.ok) return branch
    let replyToId: string | undefined
    if (args.replyToId) {
      const parent = this.db.comments.find((row) => row._id === args.replyToId)
      if (!parent || parent.projectId !== project._id) {
        return fail('NOT_FOUND', 'The comment being replied to is not in this project.', 'Reload the comment thread.')
      }
      replyToId = parent._id
    }
    const now = this.db.stamp()
    const comment: CommentRow = {
      _id: this.db.nextId('comments'),
      projectId: project._id,
      branchId: branch.value._id,
      authorSubject: identity.subject,
      authorDisplayName: identity.displayName,
      body,
      anchor: args.anchor,
      status: 'open',
      replyToId,
      createdAt: now,
      updatedAt: now,
    }
    this.db.comments.push(comment)
    this.db.audit(project._id, identity.subject, 'comment.create', {
      partId: args.anchor.partId,
      atRevision: args.anchor.revision,
    })
    return { ok: true, value: this.db.commentRecord(comment) }
  }

  async setCommentStatus(args: {
    projectId: string
    commentId: string
    status: 'open' | 'resolved'
  }): Promise<CloudResult<CloudCommentRecord>> {
    const offline = this.guard<CloudCommentRecord>()
    if (offline) return offline
    const reader = this.authorise(args.projectId, 'comment.read')
    if (!reader.ok) return reader
    const { project, identity } = reader.value
    const comment = this.db.comments.find((row) => row._id === args.commentId)
    if (!comment || comment.projectId !== project._id) {
      return fail('NOT_FOUND', 'That comment is not in this project.', 'Reload the comment list.')
    }
    if (comment.authorSubject !== identity.subject) {
      const authorised = this.authorise(args.projectId, 'comment.resolve')
      if (!authorised.ok) return authorised
    }
    const now = this.db.stamp()
    comment.status = args.status
    comment.resolvedBySubject = args.status === 'resolved' ? identity.subject : undefined
    comment.resolvedAt = args.status === 'resolved' ? now : undefined
    comment.updatedAt = now
    this.db.audit(project._id, identity.subject, `comment.${args.status}`, {
      partId: comment.anchor.partId,
    })
    return { ok: true, value: this.db.commentRecord(comment) }
  }

  // -- presence ------------------------------------------------------------

  async presenceHeartbeat(args: PresenceHeartbeatArgs): Promise<CloudResult<CloudPresenceRecord>> {
    const offline = this.guard<CloudPresenceRecord>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'presence.publish')
    if (!authorised.ok) return authorised
    const { project, identity } = authorised.value
    if (!args.sessionId) {
      return fail(
        'INVALID_ARGUMENT',
        'A presence heartbeat needs a session id.',
        'Mint one per tab and reuse it for the lifetime of the tab.',
      )
    }
    const now = this.db.stamp()
    const existing = this.db.presence.find((row) => row.projectId === project._id && row.sessionId === args.sessionId)
    if (existing && existing.subject !== identity.subject) {
      return fail('FORBIDDEN', 'That session id belongs to another account.', 'Mint a fresh session id for this tab.')
    }
    const fields = {
      projectId: project._id,
      subject: identity.subject,
      sessionId: args.sessionId,
      displayName: identity.displayName,
      color: swatchFor(identity.subject),
      revision: args.revision,
      selection: args.selection.slice(0, 200),
      cursorLdu: args.cursorLdu,
      cameraTargetLdu: args.cameraTargetLdu,
      followingSubject: args.followingSubject,
      updatedAt: now,
      expiresAt: now + PRESENCE_TTL_MS,
    }
    // Nothing below touches the project row, a branch head or a transaction.
    // Presence is ephemeral and may never become document truth.
    if (existing) {
      Object.assign(existing, fields)
      return { ok: true, value: this.db.presenceRecord(existing) }
    }
    const row: PresenceRow = { _id: this.db.nextId('presence'), ...fields }
    this.db.presence.push(row)
    return { ok: true, value: this.db.presenceRecord(row) }
  }

  async listPresence(args: { projectId: string }): Promise<CloudResult<CloudPresenceRecord[]>> {
    const offline = this.guard<CloudPresenceRecord[]>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'presence.publish')
    if (!authorised.ok) return authorised
    const at = this.db.stamp()
    const rows = this.db.presence.filter((row) => row.projectId === authorised.value.project._id && row.expiresAt > at)
    return { ok: true, value: rows.map((row) => this.db.presenceRecord(row)) }
  }

  async presenceLeave(args: { projectId: string; sessionId: string }): Promise<CloudResult<{ left: boolean }>> {
    const offline = this.guard<{ left: boolean }>()
    if (offline) return offline
    const authorised = this.authorise(args.projectId, 'presence.publish')
    if (!authorised.ok) return authorised
    const index = this.db.presence.findIndex(
      (row) =>
        row.projectId === authorised.value.project._id &&
        row.sessionId === args.sessionId &&
        row.subject === authorised.value.identity.subject,
    )
    if (index < 0) return { ok: true, value: { left: false } }
    this.db.presence.splice(index, 1)
    return { ok: true, value: { left: true } }
  }
}
