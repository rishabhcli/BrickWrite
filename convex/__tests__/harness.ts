import { convexTest } from 'convex-test'
import type { Id } from '../_generated/dataModel'
import schema from '../schema'
import type { CloudRole } from '../model/capabilities'
import type { CloudResult } from '../model/protocol'
import { checksumOf, checksumOfText, utf8Bytes } from '../model/checksum'

/*
 * `import.meta.glob` is Vite's, and `vite/client` is deliberately absent from
 * `convex/tsconfig.json`: adding it there would also hand deployment code
 * `import.meta.env`, which does not exist in the Convex runtime. Declared here
 * instead, so the seam is one line in one test file rather than a capability
 * granted to every function in the deployment.
 */
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

/**
 * The real Convex handlers, under test.
 *
 * `src/cloud/__tests__/fakeBackend.ts` re-implements this deployment's
 * authorisation rules so the client suite has something to run against. That
 * fake is 1,896 lines and it is the only thing those rules were ever asserted
 * against — which means the suite agreed with the copy, and the 4,787 lines
 * that actually enforce anything had no test at all. Everything in this
 * directory runs against `convex/`'s own handlers through `convex-test`, so a
 * rule that changes here fails here.
 *
 * The glob has to reach `_generated`: `convex-test` locates the module root by
 * finding that directory in the keys, and silently cannot boot without it.
 */
const modules = import.meta.glob('../**/*.*s')

export const harness = () => convexTest(schema, modules)

export type Harness = ReturnType<typeof harness>

/**
 * A signed-in principal.
 *
 * `tokenIdentifier` is issuer-qualified and `readIdentity` prefers it over
 * `subject`, so it is what a membership row is keyed on. Tests that assert on a
 * subject must use this same string rather than the bare id.
 */
/** What `t.withIdentity` accepts: Convex's `UserIdentity`, partially filled. */
export type Identity = Parameters<Harness['withIdentity']>[0]

export function person(id: string): Identity {
  return { subject: id, tokenIdentifier: subjectOf(id), name: id }
}

/** The subject a membership row for `person(id)` is stored under. */
export const subjectOf = (id: string): string => `https://hexclave.test/${id}`

/** A token that is cryptographically valid but not a principal we write as. */
export const anonymous = (id: string): Identity => ({ ...person(id), is_anonymous: true })
export const restricted = (id: string): Identity => ({ ...person(id), is_restricted: true })

/** Unwraps a `CloudResult`, failing the test with the server's message. */
export function expectOk<T>(result: CloudResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** The error code from a `CloudResult`, or `'ok'` when it succeeded. */
export const codeOf = (result: CloudResult<unknown>): string => (result.ok ? 'ok' : result.error.code)

export interface SeededProject {
  projectId: Id<'projects'>
  /** The project's `main` branch. */
  branchId: Id<'branches'>
  /** A side branch with no proposal, so `proposeMerge` has somewhere to land. */
  sideBranchId: Id<'branches'>
  /** A side branch carrying an open proposal, so `decideMerge` has one to decide. */
  proposedBranchId: Id<'branches'>
  /** A comment authored by the owner, so `setStatus` reaches `comment.resolve`. */
  commentId: Id<'comments'>
}

/**
 * Inserts a project directly, bypassing `projects.create`.
 *
 * Fixture state, not a path under test — `projects.create` has its own tests.
 * Going through the database keeps a role fixture to one write and lets a test
 * pin a visibility or a deletion that the public mutation would not produce.
 */
export async function seedProject(
  t: Harness,
  options: {
    owner: string
    visibility?: 'private' | 'unlisted' | 'public'
    members?: Partial<Record<string, CloudRole>>
    deleted?: boolean
  },
): Promise<SeededProject> {
  return t.run(async (ctx) => {
    const now = Date.now()
    const ownerSubject = subjectOf(options.owner)
    const projectId = await ctx.db.insert('projects', {
      ownerSubject,
      name: 'Seeded project',
      visibility: options.visibility ?? 'private',
      localProjectId: `local-${options.owner}`,
      schemaVersion: 2,
      catalogVersion: 'fixture-1',
      createdAt: now,
      updatedAt: now,
      ...(options.deleted ? { deletedAt: now } : {}),
    })
    const branchId = await ctx.db.insert('branches', {
      projectId,
      name: 'main',
      headRevision: 0,
      baseRevision: 0,
      kind: 'main',
      createdBySubject: ownerSubject,
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.patch(projectId, { defaultBranchId: branchId })
    await ctx.db.insert('members', {
      projectId,
      subject: ownerSubject,
      role: 'owner',
      displayName: options.owner,
      invitedBySubject: ownerSubject,
      addedAt: now,
    })
    for (const [id, role] of Object.entries(options.members ?? {})) {
      if (!role) continue
      await ctx.db.insert('members', {
        projectId,
        subject: subjectOf(id),
        role,
        displayName: id,
        invitedBySubject: ownerSubject,
        addedAt: now,
      })
    }

    const sideBranch = { projectId, headRevision: 0, baseRevision: 0, kind: 'named' as const, createdBySubject: ownerSubject, createdAt: now, updatedAt: now, forkedFromBranchId: branchId }
    const sideBranchId = await ctx.db.insert('branches', { ...sideBranch, name: 'side' })
    const proposedBranchId = await ctx.db.insert('branches', {
      ...sideBranch,
      name: 'proposed',
      // Proposed by the owner, never by the actor under test: `decideMerge`
      // lets an author withdraw their own proposal without `branch.merge`, so a
      // self-proposed fixture would let the probe pass through the wrong door.
      proposal: {
        intoBranchId: branchId,
        status: 'open' as const,
        proposedBySubject: ownerSubject,
        proposedAt: now,
        summary: 'Seeded proposal',
      },
    })
    // Authored by the owner for the same reason: `setStatus` skips the
    // `comment.resolve` check entirely when the caller wrote the comment.
    const commentId = await ctx.db.insert('comments', {
      projectId,
      branchId,
      authorSubject: ownerSubject,
      authorDisplayName: options.owner,
      body: 'Seeded comment',
      anchor: { partId: 'part-1', revision: 0, poseChecksum: 'seed' },
      status: 'open',
      createdAt: now,
      updatedAt: now,
    })

    return { projectId, branchId, sideBranchId, proposedBranchId, commentId }
  })
}

/**
 * A schema-2 document the snapshot validator will accept.
 *
 * `decodeSnapshotUpload` parses the reassembled chunks, checks them against
 * `documentShape`, and compares the envelope's revision, schema and catalogue
 * against the document's own. A stub that skips any of that is rejected before
 * the property under test is reached.
 */
export function document(options: { localProjectId: string; revision?: number; name?: string }) {
  const at = new Date(1_700_000_000_000).toISOString()
  return {
    schemaVersion: 2 as const,
    id: options.localProjectId,
    name: options.name ?? 'Seeded document',
    revision: options.revision ?? 0,
    catalogVersion: 'fixture-1',
    createdAt: at,
    updatedAt: at,
    parts: {},
    connections: {},
    subassemblies: {},
    steps: [],
    notes: [],
    constraints: [],
  }
}

/**
 * A snapshot upload whose checksum and byte count the server will re-derive to
 * the same values. The server recomputes both rather than trusting them, so a
 * hand-written pair fails on write rather than on the assertion.
 */
export function snapshotUpload(options: { localProjectId: string; revision?: number; name?: string; chunks?: number } = { localProjectId: 'local-owner-account' }) {
  const serialized = JSON.stringify(document(options))
  const size = Math.ceil(serialized.length / (options.chunks ?? 1))
  const chunks: string[] = []
  for (let at = 0; at < serialized.length; at += size) chunks.push(serialized.slice(at, at + size))
  return {
    revision: options.revision ?? 0,
    chunks,
    checksum: checksumOfText(serialized),
    bytes: utf8Bytes(serialized),
    schemaVersion: 2,
    catalogVersion: 'fixture-1',
  }
}

/**
 * A transaction the append path will accept.
 *
 * `appendTransactionBatch` re-derives the checksum and re-validates the whole
 * `Transaction` shape, so a hand-written stub is rejected long before the
 * property under test is reached. This builds the real envelope — matching id,
 * paired revisions, a patch whose inverse covers exactly its forward targets —
 * and checksums it the way the server will.
 */
export function transaction(options: { id: string; baseRevision?: number; label?: string }) {
  const baseRevision = options.baseRevision ?? 0
  const payload = {
    id: options.id,
    author: 'human' as const,
    label: options.label ?? 'Seeded edit',
    baseRevision,
    resultRevision: baseRevision + 1,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    operations: [],
    patch: { baseRevision, forward: [], inverse: [], touched: { partIds: [], subassemblyIds: [] } },
    affectedPartIds: [],
  }
  return {
    clientTransactionId: options.id,
    baseRevision,
    resultRevision: baseRevision + 1,
    transaction: payload,
    checksum: checksumOf(payload),
    schemaVersion: 2,
    catalogVersion: 'fixture-1',
  }
}
