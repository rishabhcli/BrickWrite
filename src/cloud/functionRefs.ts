import { makeFunctionReference } from 'convex/server'
import type {
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
} from './protocol'

/**
 * Typed references to the deployment's functions.
 *
 * `npx convex codegen` normally produces an `api` object with these exact
 * types, and no Convex account is logged in for this build, so the references
 * are constructed with `makeFunctionReference` — Convex's own supported way to
 * name a function that codegen has not described yet. Every reference is
 * parameterised with its argument and return types, so a call site that passes
 * the wrong shape still fails to compile; what is not checked is the *name*.
 *
 * The names below are `module:export`, matching the files under `convex/`. Once
 * codegen has run, `docs/integration/cloud-projects.md` records the one-line
 * swap that replaces this module with the generated `api` and makes the names
 * checked too.
 *
 * Importing the generated `api` directly instead was rejected for a concrete
 * reason: it would pull `convex/schema.ts` and every function module into the
 * browser project's typecheck, which nine other workstreams run.
 */

type Empty = Record<string, never>
const q = <Args extends Record<string, unknown>, Result>(name: string) =>
  makeFunctionReference<'query', Args, Result>(name)
const m = <Args extends Record<string, unknown>, Result>(name: string) =>
  makeFunctionReference<'mutation', Args, Result>(name)

export const refs = {
  projects: {
    list: q<Empty, CloudResult<CloudProjectSummary[]>>('projects:list'),
    get: q<{ projectId: string }, CloudResult<CloudProjectSummary>>('projects:get'),
    branches: q<{ projectId: string }, CloudResult<CloudBranchRecord[]>>('projects:branches'),
    create: m<CreateProjectArgs, CloudResult<CloudProjectSummary>>('projects:create'),
    rename: m<{ projectId: string; name: string }, CloudResult<CloudProjectSummary>>('projects:rename'),
    setVisibility: m<{ projectId: string; visibility: ProjectVisibility }, CloudResult<CloudProjectSummary>>(
      'projects:setVisibility',
    ),
    remove: m<{ projectId: string }, CloudResult<{ projectId: string; deletedAt: string }>>('projects:remove'),
    saveCheckpoint: m<
      { projectId: string; branchId?: string; snapshot: SnapshotUpload },
      CloudResult<{ groupId: string; revision: number }>
    >('projects:saveCheckpoint'),
    latestCheckpoint: q<
      { projectId: string; branchId?: string; atRevision?: number },
      CloudResult<CloudSnapshotRecord | null>
    >('projects:latestCheckpoint'),
    auditTrail: q<{ projectId: string; limit?: number }, CloudResult<CloudAuditRecord[]>>('projects:auditTrail'),
  },
  transactions: {
    appendBatch: m<AppendTransactionsArgs, CloudResult<AppendTransactionsValue>>('transactions:appendBatch'),
    history: q<ReadHistoryArgs, CloudResult<CloudHistoryPage>>('transactions:history'),
    append: m<AppendTransactionArgs, CloudResult<AppendTransactionValue>>('transactions:append'),
    listSince: q<
      { projectId: string; branchId?: string; sinceRevision: number; limit?: number },
      CloudResult<CloudTransactionRecord[]>
    >('transactions:listSince'),
    findByClientId: q<
      { projectId: string; branchId?: string; clientTransactionId: string },
      CloudResult<CloudTransactionRecord | null>
    >('transactions:findByClientId'),
  },
  versions: {
    create: m<CreateVersionArgs, CloudResult<CloudVersionRecord>>('versions:create'),
    list: q<{ projectId: string }, CloudResult<CloudVersionRecord[]>>('versions:list'),
    document: q<{ projectId: string; versionId: string }, CloudResult<CloudSnapshotRecord>>('versions:document'),
    createBranch: m<CreateBranchArgs, CloudResult<CloudBranchRecord>>('versions:createBranch'),
    proposeMerge: m<
      { projectId: string; branchId: string; intoBranchId?: string; summary: string },
      CloudResult<CloudBranchRecord>
    >('versions:proposeMerge'),
    decideMerge: m<
      { projectId: string; branchId: string; decision: 'merged' | 'rejected' | 'withdrawn' },
      CloudResult<CloudBranchRecord>
    >('versions:decideMerge'),
  },
  members: {
    list: q<{ projectId: string }, CloudResult<CloudMemberRecord[]>>('members:list'),
    myRole: q<{ projectId: string }, CloudResult<CloudRole | null>>('members:myRole'),
    setRole: m<
      { projectId: string; subject: string; role: Exclude<CloudRole, 'owner'> },
      CloudResult<CloudMemberRecord>
    >('members:setRole'),
    remove: m<{ projectId: string; subject: string }, CloudResult<{ removed: boolean }>>('members:remove'),
  },
  invitations: {
    list: q<{ projectId: string }, CloudResult<CloudInvitationRecord[]>>('invitations:list'),
    create: m<
      { projectId: string; email: string; role: Exclude<CloudRole, 'owner'> },
      CloudResult<CloudInvitationRecord>
    >('invitations:create'),
    revoke: m<{ projectId: string; invitationId: string }, CloudResult<{ revoked: boolean }>>('invitations:revoke'),
    accept: m<{ token: string }, CloudResult<{ projectId: string; role: string }>>('invitations:accept'),
  },
  comments: {
    list: q<{ projectId: string; status?: 'open' | 'resolved' }, CloudResult<CloudCommentRecord[]>>('comments:list'),
    forPart: q<{ projectId: string; partId: string }, CloudResult<CloudCommentRecord[]>>('comments:forPart'),
    add: m<AddCommentArgs, CloudResult<CloudCommentRecord>>('comments:add'),
    setStatus: m<
      { projectId: string; commentId: string; status: 'open' | 'resolved' },
      CloudResult<CloudCommentRecord>
    >('comments:setStatus'),
  },
  presence: {
    heartbeat: m<PresenceHeartbeatArgs, CloudResult<CloudPresenceRecord>>('presence:heartbeat'),
    list: q<{ projectId: string }, CloudResult<CloudPresenceRecord[]>>('presence:list'),
    leave: m<{ projectId: string; sessionId: string }, CloudResult<{ left: boolean }>>('presence:leave'),
  },
} as const
