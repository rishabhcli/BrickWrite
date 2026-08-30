import { applyMutations } from '../cad/patch'
import {
  ProjectRepository,
  type ProjectSummary,
  type StorageDriver,
  type StoredCheckpoint,
  type StoredTransaction,
} from '../cad/persistence'
import type { ModelDocument, Transaction } from '../cad/types'
import {
  cloudFailure,
  type CloudBackend,
  type CloudBranchRecord,
  type CloudCommentRecord,
  type CloudErrorShape,
  type CloudInvitationRecord,
  type CloudMemberRecord,
  type CloudProjectSummary,
  type CloudResult,
  type CloudRole,
  type CloudVersionRecord,
  type CommentAnchor,
  type ProjectVisibility,
  type StaleDocumentDetails,
} from './protocol'
import { claimLocalProject, type ClaimOutcome } from './claim'
import { Outbox, type SyncState } from './outbox'
import { executeConflictFork, planRebase, type ConflictFork, type ScopeOverlap } from './rebase'
import { canonicalJson, snapshotUploadFor, transactionChecksum } from './serialize'
import { readCompleteHistory } from './history'
import { incompleteHistory } from '../../convex/model/history'
import { validateTransactionPayload } from '../../convex/model/transactionValidation'

/**
 * One project interface, two implementations.
 *
 * `src/cad/persistence.ts` defines what a project *is*: a checkpoint plus the
 * transaction log that follows it. This file states that shape as an interface
 * and implements it twice — once over the existing IndexedDB repository, once
 * over the Convex data plane — so that the editor talks to a project the same
 * way whether or not anybody is signed in.
 *
 * The local implementation wraps `ProjectRepository`; it does not restate it.
 * The one thing it adds is a head comparison on append, because the cloud
 * refuses a stale write and a store that behaves differently offline would only
 * surface the difference at the worst moment.
 *
 * Collaboration operations — branches, versions, members, comments — are
 * refused by the local store with `UNCONFIGURED` and a reason, rather than
 * answered with an empty list. "There are no versions" and "versions do not
 * exist here" are different facts and the UI needs to tell them apart.
 */

export interface StoredProjectSummary {
  /** The id this store is addressed by: a document id locally, a row id in the cloud. */
  projectId: string
  /** The `ModelDocument.id`, which is the same on both sides. */
  localProjectId: string
  name: string
  revision: number
  savedAt: string
  /** Null in the cloud, which does not read a document to list projects. */
  partCount: number | null
  origin: 'local' | 'cloud'
  /** Null locally: a project nobody shares has no roles. */
  role: CloudRole | null
  visibility: ProjectVisibility | null
}

/** Mirrors `LoadedProject` in `src/cad/persistence.ts`. */
export interface StoredLoadedProject {
  document: ModelDocument
  replayed: Transaction[]
  checkpointRevision: number
}

export interface AppendOutcome {
  headRevision: number
  /** False when the append matched an existing client transaction id. */
  applied: boolean
  transactionId?: string
  /** Local durability succeeded even when the replica queue refused the entry. */
  syncError?: CloudErrorShape
}

export interface CheckpointOutcome {
  revision: number
  /** Local durability succeeded even when the replica queue refused the entry. */
  syncError?: CloudErrorShape
}

export interface ProjectStore {
  readonly kind: 'local' | 'cloud' | 'mirrored'

  listProjects(): Promise<CloudResult<StoredProjectSummary[]>>
  /**
   * Rebuilds a project from its checkpoint plus every later transaction.
   *
   * `branchId` selects which history to rebuild. The local store has one, so it
   * ignores the option; the cloud store must be told, because a conflict fork
   * has its own checkpoint and its own log.
   */
  loadProject(projectId: string, options?: { branchId?: string }): Promise<CloudResult<StoredLoadedProject | null>>
  appendTransaction(projectId: string, transaction: Transaction): Promise<CloudResult<AppendOutcome>>
  saveCheckpoint(document: ModelDocument): Promise<CloudResult<CheckpointOutcome>>
  deleteProject(projectId: string): Promise<CloudResult<{ deleted: boolean }>>
  renameProject(projectId: string, name: string): Promise<CloudResult<StoredProjectSummary>>

  listBranches(projectId: string): Promise<CloudResult<CloudBranchRecord[]>>
  createBranch(
    projectId: string,
    name: string,
    options?: { kind?: 'named' | 'conflict'; fromBranchId?: string; atRevision?: number },
  ): Promise<CloudResult<CloudBranchRecord>>

  listVersions(projectId: string): Promise<CloudResult<CloudVersionRecord[]>>
  createVersion(
    projectId: string,
    label: string,
    document: ModelDocument,
    options?: { notes?: string; branchId?: string },
  ): Promise<CloudResult<CloudVersionRecord>>
  versionDocument(projectId: string, versionId: string): Promise<CloudResult<ModelDocument>>

  listMembers(projectId: string): Promise<CloudResult<CloudMemberRecord[]>>
  setMemberRole(
    projectId: string,
    subject: string,
    role: Exclude<CloudRole, 'owner'>,
  ): Promise<CloudResult<CloudMemberRecord>>
  removeMember(projectId: string, subject: string): Promise<CloudResult<{ removed: boolean }>>
  myRole(projectId: string): Promise<CloudResult<CloudRole | null>>
  setVisibility(projectId: string, visibility: ProjectVisibility): Promise<CloudResult<StoredProjectSummary>>
  listInvitations(projectId: string): Promise<CloudResult<CloudInvitationRecord[]>>
  createInvitation(
    projectId: string,
    email: string,
    role: Exclude<CloudRole, 'owner'>,
  ): Promise<CloudResult<CloudInvitationRecord>>
  retryInvitationDelivery(projectId: string, invitationId: string): Promise<CloudResult<CloudInvitationRecord>>
  revokeInvitation(projectId: string, invitationId: string): Promise<CloudResult<{ revoked: boolean }>>

  listComments(projectId: string): Promise<CloudResult<CloudCommentRecord[]>>
  addComment(
    projectId: string,
    body: string,
    anchor: CommentAnchor,
    options?: { replyToId?: string; branchId?: string },
  ): Promise<CloudResult<CloudCommentRecord>>
  setCommentStatus(
    projectId: string,
    commentId: string,
    status: 'open' | 'resolved',
  ): Promise<CloudResult<CloudCommentRecord>>
}

const localOnly = <T>(subject: string): CloudResult<T> =>
  cloudFailure(
    'UNCONFIGURED',
    `${subject} live in the cloud; this project is stored only in this browser.`,
    'Sign in and claim the project to the cloud to use this.',
  )

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

/**
 * The local-first store.
 *
 * Holds the driver as well as the repository because two operations need the
 * raw checkpoint row that `ProjectRepository` does not publish: the head
 * comparison on append, and the lossless claim in `claim.ts`, which has to
 * upload the checkpoint document itself rather than a replayed reconstruction
 * of it.
 */
export class LocalProjectStore implements ProjectStore {
  readonly kind = 'local' as const
  readonly repository: ProjectRepository

  constructor(readonly driver: StorageDriver) {
    this.repository = new ProjectRepository(driver)
  }

  private summarise(summary: ProjectSummary): StoredProjectSummary {
    return {
      projectId: summary.projectId,
      localProjectId: summary.projectId,
      name: summary.name,
      revision: summary.revision,
      savedAt: summary.savedAt,
      partCount: summary.partCount,
      origin: 'local',
      role: null,
      visibility: null,
    }
  }

  async listProjects(): Promise<CloudResult<StoredProjectSummary[]>> {
    const projects = await this.repository.listProjects()
    return { ok: true, value: projects.map((summary) => this.summarise(summary)) }
  }

  async loadProject(projectId: string): Promise<CloudResult<StoredLoadedProject | null>> {
    const loaded = await this.repository.loadProject(projectId)
    return { ok: true, value: loaded }
  }

  /** The checkpoint row itself, for the claim path. Null when nothing is stored. */
  async readCheckpoint(projectId: string): Promise<StoredCheckpoint | null> {
    return (await this.driver.get<StoredCheckpoint>('checkpoints', projectId)) ?? null
  }

  /** Every logged transaction after the checkpoint, oldest first. */
  async readLog(projectId: string): Promise<StoredTransaction[]> {
    return this.driver.range<StoredTransaction>('transactions', `${projectId}:`)
  }

  /**
   * The highest revision this browser holds for a project.
   *
   * Derived from the checkpoint and the tail of the log rather than cached,
   * because the autosave in `src/cad/persistence.ts` writes the log directly
   * and a cached head would be wrong the moment anything else appended.
   */
  async headRevision(projectId: string): Promise<number | null> {
    const checkpoint = await this.readCheckpoint(projectId)
    if (!checkpoint) return null
    const log = await this.readLog(projectId)
    return log.reduce((head, entry) => Math.max(head, entry.resultRevision), checkpoint.revision)
  }

  async appendTransaction(projectId: string, transaction: Transaction): Promise<CloudResult<AppendOutcome>> {
    const head = await this.headRevision(projectId)
    if (head === null) {
      return cloudFailure(
        'NOT_FOUND',
        'That project has no checkpoint in this browser.',
        'Save a checkpoint before appending to its log.',
      )
    }
    const log = await this.readLog(projectId)
    // Idempotency, matching the deployment: a retry of a transaction already in
    // the log is answered with the original outcome, not a second revision.
    const existing = log.find((entry) => entry.transaction.id === transaction.id)
    if (existing) {
      return { ok: true, value: { headRevision: head, applied: false } }
    }
    if (transaction.baseRevision !== head) {
      const details: StaleDocumentDetails = { headRevision: head, branchId: 'local' }
      return cloudFailure(
        'STALE_DOCUMENT',
        `This edit was made against revision ${transaction.baseRevision}; the local log is at ${head}.`,
        'Reload the project so the editor is on the current revision.',
        details,
      )
    }
    await this.repository.appendTransaction(projectId, transaction)
    return { ok: true, value: { headRevision: transaction.resultRevision, applied: true } }
  }

  async saveCheckpoint(document: ModelDocument): Promise<CloudResult<CheckpointOutcome>> {
    await this.repository.saveCheckpoint(document)
    return { ok: true, value: { revision: document.revision } }
  }

  async deleteProject(projectId: string): Promise<CloudResult<{ deleted: boolean }>> {
    const existing = await this.readCheckpoint(projectId)
    await this.repository.deleteProject(projectId)
    return { ok: true, value: { deleted: existing !== null } }
  }

  /**
   * Renames by rewriting the checkpoint.
   *
   * A rename through the kernel would be a `document.rename` transaction, which
   * is the right path while a project is open. This one exists for a project
   * that is not open, where there is no engine to run the operation through.
   */
  async renameProject(projectId: string, name: string): Promise<CloudResult<StoredProjectSummary>> {
    const trimmed = name.trim()
    if (!trimmed) {
      return cloudFailure('INVALID_ARGUMENT', 'A project needs a name.', 'Type a name and retry.')
    }
    const checkpoint = await this.readCheckpoint(projectId)
    if (!checkpoint) {
      return cloudFailure('NOT_FOUND', 'That project is no longer in local storage.', 'Reload the project list.')
    }
    await this.repository.saveCheckpoint({ ...checkpoint.document, name: trimmed })
    const summaries = await this.repository.listProjects()
    const summary = summaries.find((entry) => entry.projectId === projectId)
    if (!summary) {
      return cloudFailure('NOT_FOUND', 'That project vanished during the rename.', 'Reload.')
    }
    return { ok: true, value: this.summarise(summary) }
  }

  /**
   * Replaces a project's history with a checkpoint and an exact tail.
   *
   * The only local operation that removes transactions the operator has not
   * deleted, and it exists for exactly one caller: reconciling a divergence,
   * where the tail is either being adopted from the cloud or renumbered onto
   * it. `saveCheckpoint` drops the log at or below the checkpoint revision; the
   * sweep afterwards drops anything above it, so what remains is what is
   * written here and nothing else.
   */
  async replaceHistory(base: ModelDocument, tail: readonly Transaction[]): Promise<void> {
    await this.repository.saveCheckpoint(base)
    for (const entry of await this.readLog(base.id)) {
      await this.driver.delete('transactions', entry.key)
    }
    for (const transaction of tail) {
      await this.repository.appendTransaction(base.id, transaction)
    }
  }

  async listBranches(): Promise<CloudResult<CloudBranchRecord[]>> {
    return localOnly('Branches')
  }
  async createBranch(): Promise<CloudResult<CloudBranchRecord>> {
    return localOnly('Branches')
  }
  async listVersions(): Promise<CloudResult<CloudVersionRecord[]>> {
    return localOnly('Versions')
  }
  async createVersion(): Promise<CloudResult<CloudVersionRecord>> {
    return localOnly('Versions')
  }
  async versionDocument(): Promise<CloudResult<ModelDocument>> {
    return localOnly('Versions')
  }
  async listMembers(): Promise<CloudResult<CloudMemberRecord[]>> {
    return localOnly('Collaborators')
  }
  async setMemberRole(): Promise<CloudResult<CloudMemberRecord>> {
    return localOnly('Collaborators')
  }
  async removeMember(): Promise<CloudResult<{ removed: boolean }>> {
    return localOnly('Collaborators')
  }
  async myRole(): Promise<CloudResult<CloudRole | null>> {
    return localOnly('Collaborators')
  }
  async setVisibility(): Promise<CloudResult<StoredProjectSummary>> {
    return localOnly('Sharing')
  }
  async listInvitations(): Promise<CloudResult<CloudInvitationRecord[]>> {
    return localOnly('Invitations')
  }
  async createInvitation(): Promise<CloudResult<CloudInvitationRecord>> {
    return localOnly('Invitations')
  }
  async retryInvitationDelivery(): Promise<CloudResult<CloudInvitationRecord>> {
    return localOnly('Invitations')
  }
  async revokeInvitation(): Promise<CloudResult<{ revoked: boolean }>> {
    return localOnly('Invitations')
  }
  async listComments(): Promise<CloudResult<CloudCommentRecord[]>> {
    return localOnly('Comments')
  }
  async addComment(): Promise<CloudResult<CloudCommentRecord>> {
    return localOnly('Comments')
  }
  async setCommentStatus(): Promise<CloudResult<CloudCommentRecord>> {
    return localOnly('Comments')
  }
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

/**
 * The cloud replica, addressed the same way as the local store.
 *
 * `loadProject` reproduces `ProjectRepository.loadProject` exactly, including
 * its refusal to replay a transaction whose base revision does not match the
 * document in hand: replaying out of order would produce a document no operator
 * ever saw, and that is no more acceptable over the network than it is on disk.
 */
export class CloudProjectStore implements ProjectStore {
  readonly kind = 'cloud' as const
  /** localProjectId → cloud project id, filled in by `listProjects`. */
  private byLocalId = new Map<string, string>()
  /** cloud project id → last seen summary, for the schema and catalogue versions. */
  private summaries = new Map<string, CloudProjectSummary>()

  constructor(private readonly backend: CloudBackend) {}

  private remember(summaries: CloudProjectSummary[]) {
    for (const summary of summaries) {
      this.byLocalId.set(summary.localProjectId, summary.projectId)
      this.summaries.set(summary.projectId, summary)
    }
  }

  private storedSummary(summary: CloudProjectSummary): StoredProjectSummary {
    return {
      projectId: summary.projectId,
      localProjectId: summary.localProjectId,
      name: summary.name,
      revision: summary.headRevision,
      savedAt: summary.updatedAt,
      partCount: null,
      origin: 'cloud',
      role: summary.role,
      visibility: summary.visibility,
    }
  }

  /**
   * The project's stored schema and catalogue versions.
   *
   * An append has to declare which document schema it was produced against, and
   * the deployment refuses a mismatch. Guessing a version would defeat that
   * check, so an unseen project is fetched rather than assumed.
   */
  private async summaryFor(projectId: string): Promise<CloudResult<CloudProjectSummary>> {
    const cached = this.summaries.get(projectId)
    if (cached) return { ok: true, value: cached }
    const fetched = await this.backend.getProject({ projectId })
    if (!fetched.ok) return fetched
    this.remember([fetched.value])
    return fetched
  }

  /** Accepts either a cloud project id or the `ModelDocument.id` it mirrors. */
  resolveId(projectId: string): string {
    return this.byLocalId.get(projectId) ?? projectId
  }

  async listProjects(): Promise<CloudResult<StoredProjectSummary[]>> {
    const result = await this.backend.listProjects()
    if (!result.ok) return result
    this.remember(result.value)
    return {
      ok: true,
      value: result.value.map((summary) => this.storedSummary(summary)),
    }
  }

  async loadProject(
    projectId: string,
    options?: { branchId?: string },
  ): Promise<CloudResult<StoredLoadedProject | null>> {
    const id = this.resolveId(projectId)
    const checkpoint = await this.backend.latestCheckpoint({
      projectId: id,
      branchId: options?.branchId,
    })
    if (!checkpoint.ok) return checkpoint
    if (!checkpoint.value) return { ok: true, value: null }
    if (checkpoint.value.projectId !== id || (options?.branchId && checkpoint.value.branchId !== options.branchId)) {
      return incompleteHistory('The checkpoint belongs to a different project or branch.')
    }

    let document = checkpoint.value.document
    const log = await readCompleteHistory(this.backend, {
      projectId: id,
      branchId: checkpoint.value.branchId ?? options?.branchId,
      sinceRevision: checkpoint.value.revision,
    })
    if (!log.ok) return log
    if (document.revision !== checkpoint.value.revision || document.revision > log.value.headRevision) {
      return incompleteHistory('The checkpoint does not match the branch history.')
    }

    const replayed: Transaction[] = []
    for (const record of log.value.transactions) {
      if (record.schemaVersion !== document.schemaVersion) {
        return cloudFailure(
          'SCHEMA_MISMATCH',
          'The history uses a different document schema than its checkpoint.',
          'Reload the application or restore a complete version; no partial model was opened.',
        )
      }
      const transaction = record.transaction
      document = applyMutations(document, transaction.patch.forward)
      document = {
        ...document,
        revision: transaction.resultRevision,
        updatedAt: transaction.timestamp,
      }
      replayed.push(transaction)
    }
    return {
      ok: true,
      value: { document, replayed, checkpointRevision: checkpoint.value.revision },
    }
  }

  async appendTransaction(projectId: string, transaction: Transaction): Promise<CloudResult<AppendOutcome>> {
    const id = this.resolveId(projectId)
    const summary = await this.summaryFor(id)
    if (!summary.ok) return summary
    const result = await this.backend.appendTransaction({
      projectId: id,
      clientTransactionId: transaction.id,
      baseRevision: transaction.baseRevision,
      resultRevision: transaction.resultRevision,
      transaction,
      checksum: transactionChecksum(transaction),
      schemaVersion: summary.value.schemaVersion,
      catalogVersion: summary.value.catalogVersion,
    })
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        headRevision: result.value.headRevision,
        applied: result.value.applied,
        transactionId: result.value.transactionId,
      },
    }
  }

  async saveCheckpoint(document: ModelDocument): Promise<CloudResult<CheckpointOutcome>> {
    const id = this.byLocalId.get(document.id)
    if (!id) {
      return cloudFailure(
        'NOT_FOUND',
        'This document has no cloud replica yet.',
        'Claim the project to the cloud before checkpointing it there.',
        { localProjectId: document.id },
      )
    }
    const result = await this.backend.saveCheckpoint({
      projectId: id,
      snapshot: snapshotUploadFor(document),
    })
    if (!result.ok) return result
    return { ok: true, value: { revision: result.value.revision } }
  }

  async deleteProject(projectId: string): Promise<CloudResult<{ deleted: boolean }>> {
    const result = await this.backend.deleteProject({ projectId: this.resolveId(projectId) })
    if (!result.ok) return result
    return { ok: true, value: { deleted: true } }
  }

  async renameProject(projectId: string, name: string): Promise<CloudResult<StoredProjectSummary>> {
    const result = await this.backend.renameProject({
      projectId: this.resolveId(projectId),
      name,
    })
    if (!result.ok) return result
    this.remember([result.value])
    return { ok: true, value: this.storedSummary(result.value) }
  }

  listBranches(projectId: string): Promise<CloudResult<CloudBranchRecord[]>> {
    return this.backend.listBranches({ projectId: this.resolveId(projectId) })
  }

  createBranch(
    projectId: string,
    name: string,
    options?: { kind?: 'named' | 'conflict'; fromBranchId?: string; atRevision?: number },
  ): Promise<CloudResult<CloudBranchRecord>> {
    return this.backend.createBranch({
      projectId: this.resolveId(projectId),
      name,
      kind: options?.kind,
      fromBranchId: options?.fromBranchId,
      atRevision: options?.atRevision,
    })
  }

  listVersions(projectId: string): Promise<CloudResult<CloudVersionRecord[]>> {
    return this.backend.listVersions({ projectId: this.resolveId(projectId) })
  }

  createVersion(
    projectId: string,
    label: string,
    document: ModelDocument,
    options?: { notes?: string; branchId?: string },
  ): Promise<CloudResult<CloudVersionRecord>> {
    return this.backend.createVersion({
      projectId: this.resolveId(projectId),
      branchId: options?.branchId,
      label,
      notes: options?.notes,
      snapshot: snapshotUploadFor(document),
    })
  }

  async versionDocument(projectId: string, versionId: string): Promise<CloudResult<ModelDocument>> {
    const result = await this.backend.versionDocument({
      projectId: this.resolveId(projectId),
      versionId,
    })
    if (!result.ok) return result
    return { ok: true, value: result.value.document }
  }

  listMembers(projectId: string): Promise<CloudResult<CloudMemberRecord[]>> {
    return this.backend.listMembers({ projectId: this.resolveId(projectId) })
  }

  setMemberRole(
    projectId: string,
    subject: string,
    role: Exclude<CloudRole, 'owner'>,
  ): Promise<CloudResult<CloudMemberRecord>> {
    return this.backend.setMemberRole({ projectId: this.resolveId(projectId), subject, role })
  }

  removeMember(projectId: string, subject: string): Promise<CloudResult<{ removed: boolean }>> {
    return this.backend.removeMember({ projectId: this.resolveId(projectId), subject })
  }

  myRole(projectId: string): Promise<CloudResult<CloudRole | null>> {
    return this.backend.myRole({ projectId: this.resolveId(projectId) })
  }

  async setVisibility(projectId: string, visibility: ProjectVisibility): Promise<CloudResult<StoredProjectSummary>> {
    const result = await this.backend.setVisibility({ projectId: this.resolveId(projectId), visibility })
    if (!result.ok) return result
    this.remember([result.value])
    return { ok: true, value: this.storedSummary(result.value) }
  }

  listInvitations(projectId: string): Promise<CloudResult<CloudInvitationRecord[]>> {
    return this.backend.listInvitations({ projectId: this.resolveId(projectId) })
  }

  createInvitation(
    projectId: string,
    email: string,
    role: Exclude<CloudRole, 'owner'>,
  ): Promise<CloudResult<CloudInvitationRecord>> {
    return this.backend.createInvitation({ projectId: this.resolveId(projectId), email, role })
  }

  retryInvitationDelivery(projectId: string, invitationId: string): Promise<CloudResult<CloudInvitationRecord>> {
    return this.backend.retryInvitationDelivery({ projectId: this.resolveId(projectId), invitationId })
  }
  revokeInvitation(projectId: string, invitationId: string): Promise<CloudResult<{ revoked: boolean }>> {
    return this.backend.revokeInvitation({ projectId: this.resolveId(projectId), invitationId })
  }

  listComments(projectId: string): Promise<CloudResult<CloudCommentRecord[]>> {
    return this.backend.listComments({ projectId: this.resolveId(projectId) })
  }

  addComment(
    projectId: string,
    body: string,
    anchor: CommentAnchor,
    options?: { replyToId?: string; branchId?: string },
  ): Promise<CloudResult<CloudCommentRecord>> {
    return this.backend.addComment({
      projectId: this.resolveId(projectId),
      body,
      anchor,
      replyToId: options?.replyToId,
      branchId: options?.branchId,
    })
  }

  setCommentStatus(
    projectId: string,
    commentId: string,
    status: 'open' | 'resolved',
  ): Promise<CloudResult<CloudCommentRecord>> {
    return this.backend.setCommentStatus({
      projectId: this.resolveId(projectId),
      commentId,
      status,
    })
  }
}

// ---------------------------------------------------------------------------
// Mirrored
// ---------------------------------------------------------------------------

/**
 * The link between a browser's copy of a project and its cloud replica.
 *
 * Stored in the existing `meta` object store, so nothing in
 * `src/cad/persistence.ts` has to change to hold it.
 */
export interface ProjectLink {
  localProjectId: string
  cloudProjectId: string
  branchId: string
  claimedAt: string
  /** Highest revision this browser has confirmed the cloud holds. */
  syncedRevision: number
}

const LINK_PREFIX = 'cloudlink:'

export class ProjectLinks {
  constructor(private readonly driver: StorageDriver) {}

  get(localProjectId: string): Promise<ProjectLink | undefined> {
    return this.driver.get<ProjectLink>('meta', `${LINK_PREFIX}${localProjectId}`)
  }

  async put(link: ProjectLink): Promise<void> {
    await this.driver.put('meta', `${LINK_PREFIX}${link.localProjectId}`, link)
  }

  async remove(localProjectId: string): Promise<void> {
    await this.driver.delete('meta', `${LINK_PREFIX}${localProjectId}`)
  }

  all(): Promise<ProjectLink[]> {
    return this.driver.range<ProjectLink>('meta', LINK_PREFIX)
  }
}

export interface DivergenceOutcome {
  kind: 'up-to-date' | 'fast-forward' | 'rebase' | 'conflict-fork'
  /** The document the editor should adopt, when one changed. */
  document?: ModelDocument
  /** Present for `rebase`: the local tail as it was renumbered. */
  rebased?: Transaction[]
  /** Present for `conflict-fork`. */
  fork?: ConflictFork
  remoteDocument?: ModelDocument
  overlap?: ScopeOverlap
}

/**
 * Local-first, cloud-replicated.
 *
 * Every write lands in IndexedDB first and is only then queued for the cloud,
 * so an edit is durable before the network is consulted and a failed sync can
 * never cost work. Reads of project data come from the local store for the same
 * reason: the editor must open a project at the same speed offline as online.
 *
 * Collaboration data — branches, versions, members, comments — has no local
 * copy and is read straight from the cloud. A project that has not been claimed
 * answers those with `UNCONFIGURED` and a reason, exactly as the bare local
 * store does.
 */
export class MirroredProjectStore implements ProjectStore {
  readonly kind = 'mirrored' as const
  readonly links: ProjectLinks
  private readonly localChanges = new Map<string, Promise<void>>()

  /** Serialize only local writes/finalization, never wait on fork uploads here. */
  private withLocalChange<T>(projectId: string, change: () => Promise<T>): Promise<T> {
    const result = (this.localChanges.get(projectId) ?? Promise.resolve()).then(change)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.localChanges.set(projectId, settled)
    return result.finally(() => {
      if (this.localChanges.get(projectId) === settled) this.localChanges.delete(projectId)
    })
  }

  constructor(
    readonly local: LocalProjectStore,
    readonly cloud: CloudProjectStore,
    readonly outbox: Outbox,
    private readonly backend: CloudBackend,
  ) {
    this.links = new ProjectLinks(local.driver)
  }

  get syncState(): SyncState {
    return this.outbox.getState()
  }

  subscribeSync(listener: (state: SyncState) => void): () => void {
    return this.outbox.subscribe(listener)
  }

  private async requireLink(localProjectId: string): Promise<CloudResult<ProjectLink>> {
    const link = await this.links.get(localProjectId)
    if (!link) {
      return cloudFailure(
        'UNCONFIGURED',
        'This project has not been claimed into the cloud.',
        'Sign in and claim the project to share, branch or comment on it.',
        { localProjectId },
      )
    }
    return { ok: true, value: link }
  }

  async listProjects(): Promise<CloudResult<StoredProjectSummary[]>> {
    const local = await this.local.listProjects()
    if (!local.ok) return local
    const links = await this.links.all()
    const byLocalId = new Map(links.map((link) => [link.localProjectId, link]))
    return {
      ok: true,
      value: local.value.map((summary) =>
        byLocalId.has(summary.projectId) ? { ...summary, origin: 'cloud' as const } : summary,
      ),
    }
  }

  loadProject(projectId: string): Promise<CloudResult<StoredLoadedProject | null>> {
    // Reads come from local storage: the editor must open a project at the same
    // speed offline as online, and the local copy is never behind.
    return this.local.loadProject(projectId)
  }

  /**
   * Commits locally, then queues for the cloud.
   *
   * The local append is the answer: if it succeeds the caller is told the edit
   * is durable, whatever the network is doing. A queue refusal is reported in
   * the sync state rather than as a failed edit, because the edit did not fail.
   */
  async appendTransaction(projectId: string, transaction: Transaction): Promise<CloudResult<AppendOutcome>> {
    return this.withLocalChange(projectId, async () => {
      const local = await this.local.appendTransaction(projectId, transaction)
      if (!local.ok) return local

      const link = await this.links.get(projectId)
      if (link && local.value.applied) {
        const checkpoint = await this.local.readCheckpoint(projectId)
        if (checkpoint) {
          const queued = await this.outbox.queueTransaction(link.cloudProjectId, checkpoint.document, transaction)
          if (!queued.ok) {
            return { ok: true, value: { ...local.value, syncError: queued.error } }
          }
        }
      }
      return local
    })
  }

  async saveCheckpoint(document: ModelDocument): Promise<CloudResult<CheckpointOutcome>> {
    return this.withLocalChange(document.id, async () => {
      const local = await this.local.saveCheckpoint(document)
      if (!local.ok) return local
      const link = await this.links.get(document.id)
      if (link) {
        const queued = await this.outbox.queueCheckpoint(link.cloudProjectId, document)
        if (!queued.ok) return { ok: true, value: { ...local.value, syncError: queued.error } }
      }
      return local
    })
  }

  async deleteProject(projectId: string): Promise<CloudResult<{ deleted: boolean }>> {
    const { local, link } = await this.withLocalChange(projectId, async () => {
      const link = await this.links.get(projectId)
      const local = await this.local.deleteProject(projectId)
      if (local.ok && link) {
        await this.outbox.clearProject(link.cloudProjectId)
        await this.links.remove(projectId)
      }
      return { local, link }
    })
    // Network latency must not hold the local-write lock.
    if (local.ok && link) await this.backend.deleteProject({ projectId: link.cloudProjectId })
    return local
  }

  async renameProject(projectId: string, name: string): Promise<CloudResult<StoredProjectSummary>> {
    const { local, link } = await this.withLocalChange(projectId, async () => ({
      local: await this.local.renameProject(projectId, name),
      link: await this.links.get(projectId),
    }))
    if (local.ok && link) await this.backend.renameProject({ projectId: link.cloudProjectId, name })
    return local
  }

  /** Claims the project into the cloud and records the link. */
  async claim(
    localProjectId: string,
    options?: { name?: string; visibility?: ProjectVisibility },
  ): Promise<CloudResult<ClaimOutcome>> {
    const existing = await this.links.get(localProjectId)
    if (existing) {
      return cloudFailure(
        'NAME_TAKEN',
        'This local project is already linked to a cloud copy.',
        'Open or sync the linked project instead of claiming it again.',
        { projectId: existing.cloudProjectId },
      )
    }
    const claimed = await claimLocalProject({
      local: this.local,
      backend: this.backend,
      localProjectId,
      name: options?.name,
      visibility: options?.visibility,
    })
    if (!claimed.ok) return claimed
    await this.links.put({
      localProjectId,
      cloudProjectId: claimed.value.projectId,
      branchId: claimed.value.branchId,
      claimedAt: new Date().toISOString(),
      syncedRevision: claimed.value.headRevision,
    })
    await this.cloud.listProjects()
    return claimed
  }

  /**
   * Re-derives queue entries from the local log.
   *
   * The documented recovery path from a full outbox. The local log is complete
   * and authoritative, so anything the cloud is missing can always be rebuilt
   * from it — which is what makes refusing an enqueue a safe policy rather than
   * a lossy one.
   */
  async backfill(localProjectId: string): Promise<CloudResult<{ queued: number }>> {
    const link = await this.requireLink(localProjectId)
    if (!link.ok) return link
    const remote = await this.backend.getProject({ projectId: link.value.cloudProjectId })
    if (!remote.ok) return remote

    const checkpoint = await this.local.readCheckpoint(localProjectId)
    if (!checkpoint) {
      return cloudFailure(
        'NOT_FOUND',
        'That project has no local checkpoint to backfill from.',
        'Open the project so a checkpoint is written.',
      )
    }
    const queuedIds = new Set(
      this.outbox.pending
        .filter((entry) => entry.payload.kind === 'transaction')
        .map((entry) => (entry.payload.kind === 'transaction' ? entry.payload.transaction.id : '')),
    )
    const missing = (await this.local.readLog(localProjectId))
      .filter((entry) => entry.resultRevision > remote.value.headRevision)
      .filter((entry) => !queuedIds.has(entry.transaction.id))
      .sort((a, b) => a.resultRevision - b.resultRevision)

    let queued = 0
    for (const entry of missing) {
      const result = await this.outbox.queueTransaction(
        link.value.cloudProjectId,
        checkpoint.document,
        entry.transaction,
      )
      if (!result.ok) return result
      queued += 1
    }
    return { ok: true, value: { queued } }
  }

  /**
   * Reconciles a divergence, deciding by the rule in `rebase.ts`.
   *
   * The common ancestor is taken to be the local checkpoint: the claim seeds
   * the cloud with exactly that document, and later checkpoints are queued, so
   * both sides share it. When the cloud is behind it the remote tail is empty
   * and there is nothing to reconcile — the outbox pushes instead.
   */
  async resolveDivergence(localProjectId: string): Promise<CloudResult<DivergenceOutcome>> {
    const link = await this.requireLink(localProjectId)
    if (!link.ok) return link

    const checkpoint = await this.local.readCheckpoint(localProjectId)
    if (!checkpoint) {
      return cloudFailure(
        'NOT_FOUND',
        'That project has no local checkpoint to reconcile against.',
        'Open the project so a checkpoint is written.',
      )
    }
    const remote = await readCompleteHistory(this.backend, {
      projectId: link.value.cloudProjectId,
      branchId: link.value.branchId,
      sinceRevision: checkpoint.revision,
    })
    if (!remote.ok) return remote

    const localTail = (await this.local.readLog(localProjectId))
      .filter((entry) => entry.resultRevision > checkpoint.revision)
      .sort((a, b) => a.resultRevision - b.resultRevision)
      .map((entry) => entry.transaction)

    // Never let incomplete touched/undo data drive a disjoint-rebase decision
    // or clear the queue. Keep the original local log available for recovery.
    let localRevision = checkpoint.revision
    const localIds = new Set<string>()
    for (const transaction of localTail) {
      const valid = validateTransactionPayload(transaction)
      if (!valid.ok) return incompleteHistory(valid.error.message, valid.error.details)
      if (
        transaction.baseRevision !== localRevision ||
        transaction.resultRevision !== localRevision + 1 ||
        localIds.has(transaction.id)
      )
        return incompleteHistory('The local history has a revision gap or duplicate transaction id.')
      localRevision += 1
      localIds.add(transaction.id)
    }
    const plan = planRebase({
      base: checkpoint.document,
      localTail,
      remoteTail: remote.value.transactions.map((record) => record.transaction),
    })

    const checkpointJson = canonicalJson(checkpoint.document)
    const tailJson = localTail.map((transaction) => canonicalJson(transaction))
    const finish = (change: () => Promise<CloudResult<DivergenceOutcome>>) =>
      this.withLocalChange(localProjectId, async () => {
        const currentCheckpoint = await this.local.readCheckpoint(localProjectId)
        const currentLink = await this.links.get(localProjectId)
        const currentTail = (await this.local.readLog(localProjectId))
          .filter((entry) => entry.resultRevision > checkpoint.revision)
          .sort((a, b) => a.resultRevision - b.resultRevision)
        if (
          !currentCheckpoint ||
          currentCheckpoint.revision !== checkpoint.revision ||
          canonicalJson(currentCheckpoint.document) !== checkpointJson ||
          currentLink?.cloudProjectId !== link.value.cloudProjectId ||
          currentLink?.branchId !== link.value.branchId ||
          currentTail.length !== tailJson.length ||
          currentTail.some((entry, index) => canonicalJson(entry.transaction) !== tailJson[index])
        ) {
          return cloudFailure(
            'STALE_DOCUMENT',
            'The local project changed during recovery; its newer work is retained.',
            'Retry recovery from the current local history. Any completed fork is already safe in the cloud.',
          )
        }
        return change()
      })

    if (plan.kind === 'up-to-date') return { ok: true, value: { kind: 'up-to-date' } }

    if (plan.kind === 'fast-forward') {
      return finish(async () => {
        await this.outbox.clearProject(link.value.cloudProjectId)
        await this.local.replaceHistory(checkpoint.document, plan.adopted)
        await this.links.put({ ...link.value, syncedRevision: plan.headRevision })
        return { ok: true, value: { kind: 'fast-forward', document: plan.document } }
      })
    }

    if (plan.kind === 'rebase') {
      return finish(async () => {
        // The queued entries carry the pre-rebase revisions and would now be
        // refused forever, so they are replaced rather than left to fail.
        await this.outbox.clearProject(link.value.cloudProjectId)
        await this.local.replaceHistory(checkpoint.document, [...plan.adoptedRemote, ...plan.rebased])
        for (const transaction of plan.rebased) {
          const queued = await this.outbox.queueTransaction(link.value.cloudProjectId, checkpoint.document, transaction)
          if (!queued.ok) return queued
        }
        return {
          ok: true,
          value: { kind: 'rebase', document: plan.document, rebased: plan.rebased },
        }
      })
    }

    const fork = await executeConflictFork(this.backend, {
      projectId: link.value.cloudProjectId,
      fromBranchId: remote.value.branchId,
      plan,
    })
    if (!fork.ok) return fork
    return finish(async () => {
      // The parked pre-fork tail has already been materialised on the conflict
      // branch. Leaving it queued would resend it to main and recreate the same
      // stale-document conflict immediately.
      await this.outbox.clearProject(link.value.cloudProjectId)
      // Both histories now exist. The local copy adopts its selected cloud branch;
      // the operator's own tail is
      // not lost, it is on the conflict branch and one click away.
      await this.local.replaceHistory(checkpoint.document, plan.remoteTail)
      await this.links.put({ ...link.value, syncedRevision: plan.remoteDocument.revision })
      return {
        ok: true,
        value: {
          kind: 'conflict-fork',
          fork: fork.value,
          document: plan.remoteDocument,
          remoteDocument: plan.remoteDocument,
          overlap: plan.overlap,
        },
      }
    })
  }

  private async cloudDelegate<T>(
    projectId: string,
    call: (cloudProjectId: string) => Promise<CloudResult<T>>,
  ): Promise<CloudResult<T>> {
    const link = await this.requireLink(projectId)
    if (!link.ok) return link
    return call(link.value.cloudProjectId)
  }

  listBranches(projectId: string): Promise<CloudResult<CloudBranchRecord[]>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.listBranches(id))
  }

  createBranch(
    projectId: string,
    name: string,
    options?: { kind?: 'named' | 'conflict'; fromBranchId?: string; atRevision?: number },
  ): Promise<CloudResult<CloudBranchRecord>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.createBranch(id, name, options))
  }

  listVersions(projectId: string): Promise<CloudResult<CloudVersionRecord[]>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.listVersions(id))
  }

  createVersion(
    projectId: string,
    label: string,
    document: ModelDocument,
    options?: { notes?: string; branchId?: string },
  ): Promise<CloudResult<CloudVersionRecord>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.createVersion(id, label, document, options))
  }

  versionDocument(projectId: string, versionId: string): Promise<CloudResult<ModelDocument>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.versionDocument(id, versionId))
  }

  listMembers(projectId: string): Promise<CloudResult<CloudMemberRecord[]>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.listMembers(id))
  }

  setMemberRole(
    projectId: string,
    subject: string,
    role: Exclude<CloudRole, 'owner'>,
  ): Promise<CloudResult<CloudMemberRecord>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.setMemberRole(id, subject, role))
  }

  removeMember(projectId: string, subject: string): Promise<CloudResult<{ removed: boolean }>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.removeMember(id, subject))
  }

  myRole(projectId: string): Promise<CloudResult<CloudRole | null>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.myRole(id))
  }

  setVisibility(projectId: string, visibility: ProjectVisibility): Promise<CloudResult<StoredProjectSummary>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.setVisibility(id, visibility))
  }

  listInvitations(projectId: string): Promise<CloudResult<CloudInvitationRecord[]>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.listInvitations(id))
  }

  createInvitation(
    projectId: string,
    email: string,
    role: Exclude<CloudRole, 'owner'>,
  ): Promise<CloudResult<CloudInvitationRecord>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.createInvitation(id, email, role))
  }

  retryInvitationDelivery(projectId: string, invitationId: string): Promise<CloudResult<CloudInvitationRecord>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.retryInvitationDelivery(id, invitationId))
  }
  revokeInvitation(projectId: string, invitationId: string): Promise<CloudResult<{ revoked: boolean }>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.revokeInvitation(id, invitationId))
  }

  listComments(projectId: string): Promise<CloudResult<CloudCommentRecord[]>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.listComments(id))
  }

  addComment(
    projectId: string,
    body: string,
    anchor: CommentAnchor,
    options?: { replyToId?: string; branchId?: string },
  ): Promise<CloudResult<CloudCommentRecord>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.addComment(id, body, anchor, options))
  }

  setCommentStatus(
    projectId: string,
    commentId: string,
    status: 'open' | 'resolved',
  ): Promise<CloudResult<CloudCommentRecord>> {
    return this.cloudDelegate(projectId, (id) => this.cloud.setCommentStatus(id, commentId, status))
  }
}
