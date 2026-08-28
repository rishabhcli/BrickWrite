import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * The cloud replica of the local-first project model.
 *
 * `src/cad/persistence.ts` stores a project as a periodic checkpoint plus the
 * transaction log that follows it. This schema mirrors that shape rather than
 * inventing a second one: `snapshots` are checkpoints, `transactions` are the
 * log, and a `branches` row holds the head revision that the log advances. The
 * head lives on the branch — not on the project and not derived by scanning the
 * log — because compare-and-advance has to be one indexed read and one patch
 * inside a single mutation.
 *
 * Every stored document carries `schemaVersion` and `catalogVersion`. A replica
 * written by a build with a different catalogue is still readable, but the
 * client can tell that it may not be placeable, which is the same judgement
 * `Session.usable()` makes locally.
 *
 * Ownership and membership are keyed by the Hexclave user id (`subject`, the
 * `sub` claim of the access token). Email appears in exactly one table —
 * `invitations`, because an invitation has to be delivered somewhere — and is
 * never copied into audit events, presence or comments.
 */

/** Redacted audit payload: scalars only, so content can never leak into it. */
const auditDetail = v.record(v.string(), v.union(v.string(), v.number(), v.boolean()))

export default defineSchema({
  projects: defineTable({
    /** Hexclave user id of the owner. Never an email. */
    ownerSubject: v.string(),
    name: v.string(),
    /**
     * `private` is the default and the one the authorisation tests pin: a
     * non-member may not learn that the project exists.
     */
    visibility: v.union(v.literal('private'), v.literal('unlisted'), v.literal('public')),
    /**
     * The `ModelDocument.id` this project came from, so a claimed project can be
     * matched back to the browser's IndexedDB copy after a reinstall instead of
     * being imported twice.
     */
    localProjectId: v.string(),
    /** Optional only for the instant between inserting the project and its main branch. */
    defaultBranchId: v.optional(v.id('branches')),
    schemaVersion: v.number(),
    catalogVersion: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** Soft delete: history is never destroyed by a click in a project list. */
    deletedAt: v.optional(v.number()),
  })
    .index('by_owner', ['ownerSubject'])
    .index('by_owner_local', ['ownerSubject', 'localProjectId'])
    .index('by_visibility', ['visibility', 'updatedAt']),

  branches: defineTable({
    projectId: v.id('projects'),
    name: v.string(),
    /** The compare-and-advance target. Advanced only by `appendTransaction`. */
    headRevision: v.number(),
    /** Revision this branch forked at, so a merge knows the common ancestor. */
    baseRevision: v.number(),
    forkedFromBranchId: v.optional(v.id('branches')),
    kind: v.union(v.literal('main'), v.literal('named'), v.literal('conflict')),
    createdBySubject: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /**
     * An open merge proposal. Held on the branch rather than in its own table so
     * a branch can only ever have one live proposal; every transition is
     * additionally written to `auditEvents`.
     */
    proposal: v.optional(
      v.object({
        intoBranchId: v.id('branches'),
        status: v.union(
          v.literal('open'),
          v.literal('merged'),
          v.literal('withdrawn'),
          v.literal('rejected'),
        ),
        proposedBySubject: v.string(),
        proposedAt: v.number(),
        decidedBySubject: v.optional(v.string()),
        decidedAt: v.optional(v.number()),
        summary: v.string(),
      }),
    ),
  })
    .index('by_project', ['projectId'])
    .index('by_project_name', ['projectId', 'name']),

  transactions: defineTable({
    projectId: v.id('projects'),
    branchId: v.id('branches'),
    /**
     * The idempotency key: the `Transaction.id` minted by the client kernel.
     * A retry after a dropped response re-presents the same id and is answered
     * with the original outcome instead of creating a second revision.
     *
     * Scoped to the branch, not to the project. A conflict fork replays the
     * local tail onto its own branch, and those transactions keep their ids so
     * their provenance survives; a project-wide key would make the replay look
     * like a retry and the fork would come out empty.
     */
    clientTransactionId: v.string(),
    baseRevision: v.number(),
    resultRevision: v.number(),
    authorSubject: v.string(),
    /** The serialized `Transaction`, opaque to the server. */
    payload: v.any(),
    /** FNV-1a over the canonical JSON of `payload`, checked on replay. */
    checksum: v.string(),
    bytes: v.number(),
    schemaVersion: v.number(),
    catalogVersion: v.string(),
    createdAt: v.number(),
  })
    .index('by_client_txn', ['projectId', 'branchId', 'clientTransactionId'])
    .index('by_branch_revision', ['branchId', 'resultRevision'])
    .index('by_project_revision', ['projectId', 'resultRevision']),

  /**
   * Checkpoint and version documents, stored in chunks.
   *
   * A Convex document is capped at 1 MiB and a large model exceeds that, so a
   * snapshot is split across rows in one mutation. `chunkCount` is recorded on
   * every chunk: a read that finds fewer chunks than that reports a typed error
   * rather than returning a document with parts missing.
   */
  snapshots: defineTable({
    projectId: v.id('projects'),
    branchId: v.optional(v.id('branches')),
    /** Ties the chunks of one document together. */
    groupId: v.string(),
    kind: v.union(v.literal('checkpoint'), v.literal('version')),
    revision: v.number(),
    chunkIndex: v.number(),
    chunkCount: v.number(),
    data: v.string(),
    /** Checksum of the whole serialized document, not of this chunk. */
    checksum: v.string(),
    /** Byte length of the whole serialized document. */
    bytes: v.number(),
    schemaVersion: v.number(),
    catalogVersion: v.string(),
    createdBySubject: v.string(),
    createdAt: v.number(),
  })
    .index('by_group', ['groupId', 'chunkIndex'])
    .index('by_project_kind_revision', ['projectId', 'kind', 'revision'])
    .index('by_project_revision', ['projectId', 'revision']),

  /**
   * Named, immutable points in history.
   *
   * A version row is inserted once and never patched, and it points at a
   * snapshot group that is likewise never rewritten. Restoring a version writes
   * a new transaction on top of the head; it does not move the version.
   */
  versions: defineTable({
    projectId: v.id('projects'),
    branchId: v.id('branches'),
    revision: v.number(),
    label: v.string(),
    notes: v.optional(v.string()),
    snapshotGroupId: v.string(),
    documentChecksum: v.string(),
    createdBySubject: v.string(),
    createdAt: v.number(),
  })
    .index('by_project_created', ['projectId', 'createdAt'])
    .index('by_project_revision', ['projectId', 'revision'])
    .index('by_project_label', ['projectId', 'label']),

  members: defineTable({
    projectId: v.id('projects'),
    /** Hexclave user id. The only identifier authorisation is ever keyed on. */
    subject: v.string(),
    role: v.union(
      v.literal('owner'),
      v.literal('editor'),
      v.literal('commenter'),
      v.literal('viewer'),
    ),
    /** Display name copied from the token for member lists. Never an email. */
    displayName: v.optional(v.string()),
    invitedBySubject: v.optional(v.string()),
    addedAt: v.number(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_subject', ['projectId', 'subject'])
    .index('by_subject', ['subject']),

  /**
   * Pending invitations.
   *
   * The one place an email address is stored, because an invitation has to be
   * delivered somewhere. Delivery runs in an internal action with a server key;
   * the browser can create an invitation but can never see or send the message,
   * and `deliveryStatus` reports `not-configured` rather than claiming a send
   * that did not happen.
   */
  invitations: defineTable({
    projectId: v.id('projects'),
    email: v.string(),
    role: v.union(v.literal('editor'), v.literal('commenter'), v.literal('viewer')),
    token: v.string(),
    invitedBySubject: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    status: v.union(
      v.literal('pending'),
      v.literal('accepted'),
      v.literal('revoked'),
      v.literal('expired'),
    ),
    deliveryStatus: v.union(
      v.literal('pending'),
      v.literal('sent'),
      v.literal('not-configured'),
      v.literal('failed'),
    ),
    deliveryReason: v.optional(v.string()),
    acceptedBySubject: v.optional(v.string()),
    acceptedAt: v.optional(v.number()),
  })
    .index('by_project', ['projectId'])
    .index('by_token', ['token'])
    .index('by_email_status', ['email', 'status']),

  /**
   * Ephemeral collaborator state.
   *
   * Presence rows expire and are never read by anything that produces a
   * document: nothing in this table may become model truth, so a lost heartbeat
   * costs an avatar, never an edit.
   */
  presence: defineTable({
    projectId: v.id('projects'),
    subject: v.string(),
    sessionId: v.string(),
    displayName: v.optional(v.string()),
    /** Deterministic swatch derived from the subject, for cursors. */
    color: v.string(),
    /** The revision this session is looking at — advisory only. */
    revision: v.number(),
    selection: v.array(v.string()),
    cursorLdu: v.optional(v.object({ x: v.number(), y: v.number(), z: v.number() })),
    cameraTargetLdu: v.optional(v.object({ x: v.number(), y: v.number(), z: v.number() })),
    /** Subject this session is following, for follow-mode. */
    followingSubject: v.optional(v.string()),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index('by_project_expiry', ['projectId', 'expiresAt'])
    .index('by_project_session', ['projectId', 'sessionId'])
    .index('by_project_subject', ['projectId', 'subject']),

  /**
   * Revision-anchored spatial comments.
   *
   * The anchor records which part was being discussed and the revision at which
   * it was pinned, plus a checksum of that part's pose. That is what lets the
   * client say "this note was about a brick that has since moved" instead of
   * pointing at empty space or silently retargeting.
   */
  comments: defineTable({
    projectId: v.id('projects'),
    branchId: v.optional(v.id('branches')),
    authorSubject: v.string(),
    authorDisplayName: v.optional(v.string()),
    body: v.string(),
    anchor: v.object({
      partId: v.string(),
      revision: v.number(),
      /** Checksum of the anchor part's pose at `revision`. */
      poseChecksum: v.string(),
      pointLdu: v.optional(v.object({ x: v.number(), y: v.number(), z: v.number() })),
    }),
    status: v.union(v.literal('open'), v.literal('resolved')),
    replyToId: v.optional(v.id('comments')),
    resolvedBySubject: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_project_created', ['projectId', 'createdAt'])
    .index('by_project_status', ['projectId', 'status'])
    .index('by_project_anchor', ['projectId', 'anchor.partId']),

  /**
   * Append-only audit trail.
   *
   * `detail` is a record of scalars filtered through `model/audit.ts`, so a
   * caller cannot smuggle document content or an email address into the log by
   * passing a rich object. What happened, to which project, by which subject —
   * never what the model contains.
   */
  auditEvents: defineTable({
    projectId: v.id('projects'),
    actorSubject: v.string(),
    action: v.string(),
    at: v.number(),
    detail: auditDetail,
  })
    .index('by_project_at', ['projectId', 'at'])
    .index('by_actor_at', ['actorSubject', 'at']),
})
