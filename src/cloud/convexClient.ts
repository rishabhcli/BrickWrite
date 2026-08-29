import { ConvexClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { refs } from './functionRefs'
import type {
  AddCommentArgs,
  AppendTransactionArgs,
  AppendTransactionValue,
  CloudAuditRecord,
  CloudBackend,
  CloudBranchRecord,
  CloudCommentRecord,
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
  CreateBranchArgs,
  CreateProjectArgs,
  CreateVersionArgs,
  PresenceHeartbeatArgs,
  ProjectVisibility,
  SnapshotUpload,
} from './protocol'

/**
 * Constructing the Convex client, or explaining why there isn't one.
 *
 * `unconfigured` is a first-class, non-throwing state, not an error path. A
 * signed-out visitor, a developer running `vite` bare, the browser smoke
 * harness and anyone who simply has not set `VITE_CONVEX_URL` all get a CAD
 * editor that works: local projects, local history, local undo. This module
 * returns a `Result` and lets the caller decide, in the same register as
 * `src/hexclave/client.ts`, and for the same reason — an unconfigured account
 * or cloud layer is a degraded start, not a failure of the kernel.
 *
 * Identity is supplied, not imported. Ownership is keyed by the Hexclave user
 * id, and the token that carries it comes from the Hexclave client app, but
 * this module takes a token source rather than reaching into another
 * workstream's directory. `docs/integration/cloud-projects.md` records the
 * one-liner that connects the two.
 */

/** Matches Convex's `AuthTokenFetcher`, which is what `setAuth` expects. */
export type AccessTokenSource = (args: {
  forceRefreshToken: boolean
}) => Promise<string | null | undefined>

export interface ConvexCloudReady {
  status: 'ready'
  url: string
  client: ConvexClient
  backend: CloudBackend
  /**
   * Attaches — or detaches — the signed-in identity.
   *
   * Passing null clears it, which is what sign-out must do: a client left
   * holding a stale token would keep reading a project the browser's user no
   * longer is.
   */
  setIdentity(source: AccessTokenSource | null): void
  close(): Promise<void>
}

export interface ConvexCloudUnconfigured {
  status: 'unconfigured'
  /** Always populated. An unconfigured cloud says why, every time. */
  reason: string
}

export type ConvexCloudResult = ConvexCloudReady | ConvexCloudUnconfigured

/** Reads the URL without assuming `import.meta.env` exists in every runtime. */
export function convexUrlFromEnv(): string | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  const url = env?.VITE_CONVEX_URL?.trim()
  return url ? url : null
}

export interface ConvexCloudOptions {
  /** Overrides the environment, for a test or a self-hosted deployment. */
  url?: string
  tokenSource?: AccessTokenSource
}

export function createConvexCloud(options: ConvexCloudOptions = {}): ConvexCloudResult {
  const url = options.url?.trim() || convexUrlFromEnv()
  if (!url) {
    return {
      status: 'unconfigured',
      reason:
        'VITE_CONVEX_URL is not set, so there is no cloud deployment to talk to. Projects are saved in this browser only.',
    }
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      status: 'unconfigured',
      reason: `VITE_CONVEX_URL is "${url}", which is not an http(s) URL. Projects are saved in this browser only.`,
    }
  }

  let client: ConvexClient
  try {
    client = new ConvexClient(url)
  } catch (cause: unknown) {
    // Deliberately not rethrown: a cloud that cannot be constructed must not
    // take the editor down with it.
    return {
      status: 'unconfigured',
      reason: `The Convex client could not be constructed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    }
  }
  if (options.tokenSource) client.setAuth(options.tokenSource)

  return {
    status: 'ready',
    url,
    client,
    backend: new ConvexCloudBackend(client),
    setIdentity(source) {
      if (source) client.setAuth(source)
      else client.setAuth(async () => null)
    },
    close: () => client.close(),
  }
}

/**
 * Builds a token source from the Hexclave client app.
 *
 * Structurally typed against the one method it needs, so this module compiles
 * without importing `src/hexclave/client.ts` and does not break when that
 * workstream changes shape around it.
 */
export function hexclaveTokenSource(app: {
  getAccessToken: () => Promise<string | null>
}): AccessTokenSource {
  return async () => app.getAccessToken()
}

/** Strips undefined-valued keys; Convex's argument encoder rejects them. */
function compact<T extends Record<string, unknown>>(args: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) result[key] = value
  }
  return result as T
}

export const classifyTransportFailure = (cause: unknown): CloudErrorShape => {
  const message = cause instanceof Error ? cause.message : String(cause)
  // Convex's client surfaces connectivity problems as thrown errors. The outbox
  // branches on the code, so an offline failure has to arrive as `OFFLINE` and
  // not as an unhandled rejection, or a lost connection would look permanent.
  const offline =
    /network|fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|offline|socket/i.test(message)
  return offline
    ? {
        code: 'OFFLINE',
        message: `The cloud is unreachable: ${message}`,
        repair: 'Keep working; queued changes are sent when the connection returns.',
      }
    : {
        code: 'TRANSPORT_FAILED',
        message: `The cloud request failed: ${message}`,
        repair: 'Retry. Your work is saved in this browser either way.',
      }
}

/**
 * The `CloudBackend` implementation over a live deployment.
 *
 * Every method returns a `CloudResult` and never throws: a thrown transport
 * error becomes `OFFLINE` or `TRANSPORT_FAILED` so the outbox can tell a retry
 * from a refusal. The functions themselves already return `CloudResult`, so a
 * refusal arrives typed and is passed straight through.
 */
export class ConvexCloudBackend implements CloudBackend {
  constructor(private readonly client: ConvexClient) {}

  private async ask<Args extends Record<string, unknown>, Value>(
    reference: FunctionReference<'query', 'public', Args, CloudResult<Value>>,
    args: Args,
  ): Promise<CloudResult<Value>> {
    try {
      return await this.client.query(reference, compact(args))
    } catch (cause: unknown) {
      return { ok: false, error: classifyTransportFailure(cause) }
    }
  }

  private async tell<Args extends Record<string, unknown>, Value>(
    reference: FunctionReference<'mutation', 'public', Args, CloudResult<Value>>,
    args: Args,
  ): Promise<CloudResult<Value>> {
    try {
      return await this.client.mutation(reference, compact(args))
    } catch (cause: unknown) {
      return { ok: false, error: classifyTransportFailure(cause) }
    }
  }

  listProjects(): Promise<CloudResult<CloudProjectSummary[]>> {
    return this.ask(refs.projects.list, {})
  }
  getProject(args: { projectId: string }): Promise<CloudResult<CloudProjectSummary>> {
    return this.ask(refs.projects.get, args)
  }
  createProject(args: CreateProjectArgs): Promise<CloudResult<CloudProjectSummary>> {
    return this.tell(refs.projects.create, args)
  }
  renameProject(args: {
    projectId: string
    name: string
  }): Promise<CloudResult<CloudProjectSummary>> {
    return this.tell(refs.projects.rename, args)
  }
  setVisibility(args: {
    projectId: string
    visibility: ProjectVisibility
  }): Promise<CloudResult<CloudProjectSummary>> {
    return this.tell(refs.projects.setVisibility, args)
  }
  deleteProject(args: {
    projectId: string
  }): Promise<CloudResult<{ projectId: string; deletedAt: string }>> {
    return this.tell(refs.projects.remove, args)
  }
  saveCheckpoint(args: {
    projectId: string
    branchId?: string
    snapshot: SnapshotUpload
  }): Promise<CloudResult<{ groupId: string; revision: number }>> {
    return this.tell(refs.projects.saveCheckpoint, args)
  }
  latestCheckpoint(args: {
    projectId: string
    branchId?: string
    atRevision?: number
  }): Promise<CloudResult<CloudSnapshotRecord | null>> {
    return this.ask(refs.projects.latestCheckpoint, args)
  }
  auditTrail(args: {
    projectId: string
    limit?: number
  }): Promise<CloudResult<CloudAuditRecord[]>> {
    return this.ask(refs.projects.auditTrail, args)
  }

  appendTransaction(args: AppendTransactionArgs): Promise<CloudResult<AppendTransactionValue>> {
    return this.tell(refs.transactions.append, args)
  }
  listTransactions(args: {
    projectId: string
    branchId?: string
    sinceRevision: number
    limit?: number
  }): Promise<CloudResult<CloudTransactionRecord[]>> {
    return this.ask(refs.transactions.listSince, args)
  }
  findTransaction(args: {
    projectId: string
    clientTransactionId: string
  }): Promise<CloudResult<CloudTransactionRecord | null>> {
    return this.ask(refs.transactions.findByClientId, args)
  }

  listBranches(args: { projectId: string }): Promise<CloudResult<CloudBranchRecord[]>> {
    return this.ask(refs.projects.branches, args)
  }
  createBranch(args: CreateBranchArgs): Promise<CloudResult<CloudBranchRecord>> {
    return this.tell(refs.versions.createBranch, args)
  }
  proposeMerge(args: {
    projectId: string
    branchId: string
    intoBranchId?: string
    summary: string
  }): Promise<CloudResult<CloudBranchRecord>> {
    return this.tell(refs.versions.proposeMerge, args)
  }
  decideMerge(args: {
    projectId: string
    branchId: string
    decision: 'merged' | 'rejected' | 'withdrawn'
  }): Promise<CloudResult<CloudBranchRecord>> {
    return this.tell(refs.versions.decideMerge, args)
  }
  createVersion(args: CreateVersionArgs): Promise<CloudResult<CloudVersionRecord>> {
    return this.tell(refs.versions.create, args)
  }
  listVersions(args: { projectId: string }): Promise<CloudResult<CloudVersionRecord[]>> {
    return this.ask(refs.versions.list, args)
  }
  versionDocument(args: {
    projectId: string
    versionId: string
  }): Promise<CloudResult<CloudSnapshotRecord>> {
    return this.ask(refs.versions.document, args)
  }

  listMembers(args: { projectId: string }): Promise<CloudResult<CloudMemberRecord[]>> {
    return this.ask(refs.members.list, args)
  }
  myRole(args: { projectId: string }): Promise<CloudResult<CloudRole | null>> {
    return this.ask(refs.members.myRole, args)
  }
  setMemberRole(args: {
    projectId: string
    subject: string
    role: Exclude<CloudRole, 'owner'>
  }): Promise<CloudResult<CloudMemberRecord>> {
    return this.tell(refs.members.setRole, args)
  }
  removeMember(args: {
    projectId: string
    subject: string
  }): Promise<CloudResult<{ removed: boolean }>> {
    return this.tell(refs.members.remove, args)
  }
  listInvitations(args: { projectId: string }): Promise<CloudResult<CloudInvitationRecord[]>> {
    return this.ask(refs.invitations.list, args)
  }
  createInvitation(args: {
    projectId: string
    email: string
    role: Exclude<CloudRole, 'owner'>
  }): Promise<CloudResult<CloudInvitationRecord>> {
    // The address travels to the deployment and no further: delivery happens in
    // an internal Convex action, so nothing in this bundle ever sends an email.
    return this.tell(refs.invitations.create, args)
  }
  revokeInvitation(args: {
    projectId: string
    invitationId: string
  }): Promise<CloudResult<{ revoked: boolean }>> {
    return this.tell(refs.invitations.revoke, args)
  }
  acceptInvitation(args: {
    token: string
  }): Promise<CloudResult<{ projectId: string; role: string }>> {
    return this.tell(refs.invitations.accept, args)
  }

  listComments(args: {
    projectId: string
    status?: 'open' | 'resolved'
  }): Promise<CloudResult<CloudCommentRecord[]>> {
    return this.ask(refs.comments.list, args)
  }
  commentsForPart(args: {
    projectId: string
    partId: string
  }): Promise<CloudResult<CloudCommentRecord[]>> {
    return this.ask(refs.comments.forPart, args)
  }
  addComment(args: AddCommentArgs): Promise<CloudResult<CloudCommentRecord>> {
    return this.tell(refs.comments.add, args)
  }
  setCommentStatus(args: {
    projectId: string
    commentId: string
    status: 'open' | 'resolved'
  }): Promise<CloudResult<CloudCommentRecord>> {
    return this.tell(refs.comments.setStatus, args)
  }

  presenceHeartbeat(args: PresenceHeartbeatArgs): Promise<CloudResult<CloudPresenceRecord>> {
    return this.tell(refs.presence.heartbeat, args)
  }
  listPresence(args: { projectId: string }): Promise<CloudResult<CloudPresenceRecord[]>> {
    return this.ask(refs.presence.list, args)
  }
  presenceLeave(args: {
    projectId: string
    sessionId: string
  }): Promise<CloudResult<{ left: boolean }>> {
    return this.tell(refs.presence.leave, args)
  }
}
