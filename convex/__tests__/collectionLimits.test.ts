// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { COLLECTION_LIMITS } from '../model/limits'
import { codeOf, expectOk, harness, person, seedProject, snapshotUpload, subjectOf, type Harness } from './harness'

/**
 * Read and write ceilings have to agree.
 *
 * Every list query bounds itself with `.take(n)` and refuses the whole list past
 * `n`. Without a matching guard on the write side, an editor or a commenter —
 * not an owner — can grow a collection past `n` and the list stops answering for
 * everybody, with nothing the client can do to shrink it back. The assertion in
 * each case is therefore not just that the write is refused: it is that the list
 * still answers at the boundary.
 */

const fill = async (t: Harness, count: number, insert: (ctx: never, index: number) => Promise<unknown>) =>
  t.run(async (ctx) => {
    for (let index = 0; index < count; index += 1) await insert(ctx as never, index)
  })

/** Rows a seeded project already has, so `fill` lands exactly on the ceiling. */
const seededComments = (t: Harness, projectId: Id<'projects'>) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('comments')
          .withIndex('by_project_created', (q) => q.eq('projectId', projectId))
          .collect()
      ).length,
  )

const seededBranches = (t: Harness, projectId: Id<'projects'>) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('branches')
          .withIndex('by_project', (q) => q.eq('projectId', projectId))
          .collect()
      ).length,
  )

describe('comments', () => {
  test('refuses the comment that would break the project thread, and the list still reads', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const now = Date.now()
    const existing = await seededComments(t, seeded.projectId)
    await fill(t, COLLECTION_LIMITS.commentsPerProject - existing, async (ctx, index) =>
      (ctx as unknown as { db: { insert: (table: string, row: unknown) => Promise<unknown> } }).db.insert('comments', {
        projectId: seeded.projectId,
        branchId: seeded.branchId,
        authorSubject: subjectOf('owner'),
        body: `seeded ${index}`,
        // Spread across anchors so the per-part ceiling is not what refuses.
        anchor: { partId: `part_${index}`, revision: 0, poseChecksum: 'x' },
        status: 'open',
        createdAt: now + index,
        updatedAt: now + index,
      }),
    )

    const refused = await t.withIdentity(person('editor')).mutation(api.comments.add, {
      projectId: seeded.projectId,
      body: 'one too many',
      anchor: { partId: 'part_new', revision: 0, poseChecksum: 'x' },
    })
    expect(codeOf(refused)).toBe('COLLECTION_FULL')

    // The point: at the ceiling the list still answers, so refusing the write is
    // what keeps it readable rather than merely capping its size.
    const listed = expectOk(
      await t.withIdentity(person('owner')).query(api.comments.list, { projectId: seeded.projectId }),
    )
    expect(listed).toHaveLength(COLLECTION_LIMITS.commentsPerProject)
  })

  test('refuses a thread that would outgrow the per-part window', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const now = Date.now()
    await fill(t, COLLECTION_LIMITS.commentsPerPart, async (ctx, index) =>
      (ctx as unknown as { db: { insert: (table: string, row: unknown) => Promise<unknown> } }).db.insert('comments', {
        projectId: seeded.projectId,
        branchId: seeded.branchId,
        authorSubject: subjectOf('owner'),
        body: `seeded ${index}`,
        anchor: { partId: 'part_hot', revision: 0, poseChecksum: 'x' },
        status: 'open',
        createdAt: now + index,
        updatedAt: now + index,
      }),
    )

    const refused = await t.withIdentity(person('editor')).mutation(api.comments.add, {
      projectId: seeded.projectId,
      body: 'one too many on one brick',
      anchor: { partId: 'part_hot', revision: 0, poseChecksum: 'x' },
    })
    // The project total is nowhere near its ceiling; only the anchor is full.
    expect(codeOf(refused)).toBe('COLLECTION_FULL')
    expectOk(
      await t.withIdentity(person('owner')).query(api.comments.forPart, {
        projectId: seeded.projectId,
        partId: 'part_hot',
      }),
    )
  })
})

describe('branches', () => {
  test('refuses the branch that would break the branch list, and the list still reads', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const existing = await seededBranches(t, seeded.projectId)
    const now = Date.now()
    await fill(t, COLLECTION_LIMITS.branchesPerProject - existing, async (ctx, index) =>
      (ctx as unknown as { db: { insert: (table: string, row: unknown) => Promise<unknown> } }).db.insert('branches', {
        projectId: seeded.projectId,
        name: `seeded-${index}`,
        headRevision: 0,
        baseRevision: 0,
        kind: 'named',
        createdBySubject: subjectOf('owner'),
        createdAt: now,
        updatedAt: now,
      }),
    )

    const refused = await t.withIdentity(person('editor')).mutation(api.versions.createBranch, {
      projectId: seeded.projectId,
      name: 'one-too-many',
    })
    expect(codeOf(refused)).toBe('COLLECTION_FULL')

    const listed = expectOk(
      await t.withIdentity(person('owner')).query(api.projects.branches, { projectId: seeded.projectId }),
    )
    expect(listed.length).toBe(COLLECTION_LIMITS.branchesPerProject)
  })
})

describe('versions', () => {
  test('refuses the version that would break the version list', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const now = Date.now()
    await fill(t, COLLECTION_LIMITS.versionsPerProject, async (ctx, index) =>
      (ctx as unknown as { db: { insert: (table: string, row: unknown) => Promise<unknown> } }).db.insert('versions', {
        projectId: seeded.projectId,
        branchId: seeded.branchId,
        revision: index,
        label: `v${index}`,
        snapshotGroupId: `group-${index}`,
        documentChecksum: 'x',
        createdBySubject: subjectOf('owner'),
        createdAt: now + index,
      }),
    )

    const refused = await t.withIdentity(person('editor')).mutation(api.versions.create, {
      projectId: seeded.projectId,
      label: 'one too many',
      snapshot: snapshotUpload({ localProjectId: 'local-owner', revision: 0 }),
    })
    expect(codeOf(refused)).toBe('COLLECTION_FULL')
    expectOk(await t.withIdentity(person('owner')).query(api.versions.list, { projectId: seeded.projectId }))
  })
})

describe('projects per account', () => {
  test('refuses the claim that would make the account unable to list its own projects', async () => {
    const t = harness()
    const subject = subjectOf('collector')
    const now = Date.now()
    await fill(t, COLLECTION_LIMITS.membershipsPerAccount, async (ctx, index) => {
      const db = (ctx as unknown as { db: { insert: (table: string, row: unknown) => Promise<never> } }).db
      const projectId = await db.insert('projects', {
        ownerSubject: subject,
        name: `p${index}`,
        visibility: 'private',
        localProjectId: `local-${index}`,
        schemaVersion: 2,
        catalogVersion: 'fixture-1',
        createdAt: now,
        updatedAt: now,
      })
      await db.insert('members', { projectId, subject, role: 'owner', addedAt: now })
    })

    const refused = await t.withIdentity(person('collector')).mutation(api.projects.create, {
      localProjectId: 'doc-new',
      name: 'One too many',
      schemaVersion: 2,
      catalogVersion: 'fixture-1',
    })
    expect(codeOf(refused)).toBe('COLLECTION_FULL')

    // The point of refusing: this account can still see what it already has.
    const listed = expectOk(await t.withIdentity(person('collector')).query(api.projects.list, {}))
    expect(listed).toHaveLength(COLLECTION_LIMITS.membershipsPerAccount)
  })
})

describe('invitations', () => {
  test('refuses the invitation that would break the invitee list', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    const now = Date.now()
    await fill(t, COLLECTION_LIMITS.invitationsPerProject, async (ctx, index) =>
      (ctx as unknown as { db: { insert: (table: string, row: unknown) => Promise<unknown> } }).db.insert(
        'invitations',
        {
          projectId: seeded.projectId,
          email: `person${index}@example.test`,
          role: 'viewer',
          token: `token-${index}`,
          invitedBySubject: subjectOf('owner'),
          createdAt: now,
          expiresAt: now + 86_400_000,
          status: 'pending',
          deliveryStatus: 'sent',
        },
      ),
    )

    const refused = await t.withIdentity(person('owner')).mutation(api.invitations.create, {
      projectId: seeded.projectId,
      email: 'one.too.many@example.test',
      role: 'viewer',
    })
    expect(codeOf(refused)).toBe('COLLECTION_FULL')
    expectOk(await t.withIdentity(person('owner')).query(api.invitations.list, { projectId: seeded.projectId }))
  })
})

describe('deleting a comment', () => {
  const anchor = { partId: 'part_1', revision: 0, poseChecksum: 'x' }

  test('lets a project at its ceiling add another comment', async () => {
    // The ceiling's repair hint told the caller to delete a comment, and there
    // was no way to. A ceiling whose only escape does not exist is permanent.
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const now = Date.now()
    const existing = await seededComments(t, seeded.projectId)
    let last: Id<'comments'> | null = null
    await t.run(async (ctx) => {
      for (let index = 0; index < COLLECTION_LIMITS.commentsPerProject - existing; index += 1) {
        last = await ctx.db.insert('comments', {
          projectId: seeded.projectId,
          branchId: seeded.branchId,
          authorSubject: subjectOf('editor'),
          body: `seeded ${index}`,
          anchor: { ...anchor, partId: `part_${index}` },
          status: 'open',
          createdAt: now + index,
          updatedAt: now + index,
        })
      }
    })

    const add = () =>
      t.withIdentity(person('editor')).mutation(api.comments.add, {
        projectId: seeded.projectId,
        body: 'one more',
        anchor: { ...anchor, partId: 'part_new' },
      })
    expect(codeOf(await add())).toBe('COLLECTION_FULL')

    expectOk(
      await t
        .withIdentity(person('editor'))
        .mutation(api.comments.remove, { projectId: seeded.projectId, commentId: last! }),
    )
    expect(codeOf(await add())).toBe('ok')
  })

  test('takes the replies with it', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const parent = expectOk(
      await t
        .withIdentity(person('editor'))
        .mutation(api.comments.add, { projectId: seeded.projectId, body: 'Is this right?', anchor }),
    )
    expectOk(
      await t.withIdentity(person('editor')).mutation(api.comments.add, {
        projectId: seeded.projectId,
        body: 'No.',
        anchor,
        replyToId: parent.commentId,
      }),
    )

    // A thread is the unit a person means; answers to a deleted question are
    // answers nobody can read.
    const removed = expectOk(
      await t
        .withIdentity(person('editor'))
        .mutation(api.comments.remove, { projectId: seeded.projectId, commentId: parent.commentId }),
    )
    expect(removed.removed).toBe(2)
    const left = expectOk(
      await t.withIdentity(person('owner')).query(api.comments.forPart, {
        projectId: seeded.projectId,
        partId: anchor.partId,
      }),
    )
    expect(left).toEqual([])
  })

  test('lets a commenter remove their own but not somebody else’s', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { talker: 'commenter' } })
    const mine = expectOk(
      await t
        .withIdentity(person('talker'))
        .mutation(api.comments.add, { projectId: seeded.projectId, body: 'Mine.', anchor }),
    )
    const theirs = expectOk(
      await t
        .withIdentity(person('owner'))
        .mutation(api.comments.add, { projectId: seeded.projectId, body: 'Theirs.', anchor }),
    )

    expectOk(
      await t
        .withIdentity(person('talker'))
        .mutation(api.comments.remove, { projectId: seeded.projectId, commentId: mine.commentId }),
    )
    // `comment.resolve` is what governs acting on another person's thread, and a
    // commenter does not hold it.
    expect(
      codeOf(
        await t
          .withIdentity(person('talker'))
          .mutation(api.comments.remove, { projectId: seeded.projectId, commentId: theirs.commentId }),
      ),
    ).toBe('FORBIDDEN')
  })

  test('refuses a comment from another project', async () => {
    const t = harness()
    const mine = await seedProject(t, { owner: 'owner' })
    const other = await seedProject(t, { owner: 'stranger' })
    const theirs = expectOk(
      await t
        .withIdentity(person('stranger'))
        .mutation(api.comments.add, { projectId: other.projectId, body: 'Elsewhere.', anchor }),
    )
    expect(
      codeOf(
        await t
          .withIdentity(person('owner'))
          .mutation(api.comments.remove, { projectId: mine.projectId, commentId: theirs.commentId }),
      ),
    ).toBe('NOT_FOUND')
  })
})

describe('deleting a project', () => {
  /** Membership rows for one account, live or not. */
  const grants = (t: Harness, subject: string): Promise<number> =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('members')
          .withIndex('by_subject', (q) => q.eq('subject', subject))
          .collect()
      ).length,
    )

  const claim = (t: Harness, as: string, localProjectId: string) =>
    t.withIdentity(person(as)).mutation(api.projects.create, {
      localProjectId,
      name: localProjectId,
      schemaVersion: 2,
      catalogVersion: 'fixture-1',
    })

  test('gives the account its slot back', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner', 'doc-1'))
    expect(await grants(t, subjectOf('owner'))).toBe(1)

    expectOk(await t.withIdentity(person('owner')).mutation(api.projects.remove, { projectId: created.projectId }))
    // The project stays as history; the grant to open it does not, because
    // nothing can open it any more.
    expect(await grants(t, subjectOf('owner'))).toBe(0)
    const still = await t.run(async (ctx) => (await ctx.db.get(created.projectId as Id<'projects'>)) !== null)
    expect(still).toBe(true)
  })

  test('lets an account that filled its ceiling with deleted projects keep working', async () => {
    /*
     * The failure this exists for. `projects.list` bounds its read on
     * memberships and only then skips deleted projects, so an account that had
     * created and deleted its ceiling could list none of its projects and was
     * refused a new one. Deleting and creating are ordinary things to do.
     */
    const t = harness()
    const subject = subjectOf('collector')
    const now = Date.now()
    // One past the list's window, which is where the read starts refusing.
    await t.run(async (ctx) => {
      for (let index = 0; index <= COLLECTION_LIMITS.membershipsPerAccount; index += 1) {
        const projectId = await ctx.db.insert('projects', {
          ownerSubject: subject,
          name: `p${index}`,
          visibility: 'private',
          localProjectId: `local-${index}`,
          schemaVersion: 2,
          catalogVersion: 'fixture-1',
          createdAt: now,
          updatedAt: now,
          // Written before `remove` dropped the grant with the project.
          deletedAt: now,
        })
        await ctx.db.insert('members', { projectId, subject, role: 'owner', addedAt: now })
      }
    })
    expect(codeOf(await t.withIdentity(person('collector')).query(api.projects.list, {}))).toBe('INCOMPLETE_LIST')

    expect(codeOf(await claim(t, 'collector', 'doc-new'))).toBe('ok')
    // And the account can see what it has again.
    expect(expectOk(await t.withIdentity(person('collector')).query(api.projects.list, {}))).toHaveLength(1)
  })

  test('still refuses an account holding its ceiling in live projects', async () => {
    const t = harness()
    const subject = subjectOf('collector')
    const now = Date.now()
    await t.run(async (ctx) => {
      for (let index = 0; index < COLLECTION_LIMITS.membershipsPerAccount; index += 1) {
        const projectId = await ctx.db.insert('projects', {
          ownerSubject: subject,
          name: `p${index}`,
          visibility: 'private',
          localProjectId: `local-${index}`,
          schemaVersion: 2,
          catalogVersion: 'fixture-1',
          createdAt: now,
          updatedAt: now,
        })
        await ctx.db.insert('members', { projectId, subject, role: 'owner', addedAt: now })
      }
    })
    expect(codeOf(await claim(t, 'collector', 'doc-new'))).toBe('COLLECTION_FULL')
  })

  test('does not touch another account’s grants', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    expect(await grants(t, subjectOf('editor'))).toBe(1)

    expectOk(await t.withIdentity(person('owner')).mutation(api.projects.remove, { projectId: seeded.projectId }))
    // Removed with the project they were for, not left pointing at it.
    expect(await grants(t, subjectOf('editor'))).toBe(0)
    const other = await seedProject(t, { owner: 'other', members: { editor: 'editor' } })
    expect(other.projectId).toBeTruthy()
    expect(await grants(t, subjectOf('editor'))).toBe(1)
  })
})

describe('deleting a version', () => {
  const chunksFor = (t: Harness, projectId: Id<'projects'>): Promise<number> =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('snapshots')
          .withIndex('by_project_kind_revision', (q) => q.eq('projectId', projectId).eq('kind', 'version'))
          .collect()
      ).length,
    )

  const claim = (t: Harness, as: string) =>
    t.withIdentity(person(as)).mutation(api.projects.create, {
      localProjectId: 'doc-1',
      name: 'My build',
      schemaVersion: 2,
      catalogVersion: 'fixture-1',
    })

  /** `localProjectId` must match the project's, or the upload is refused. */
  const save = (t: Harness, as: string, projectId: string, label: string, localProjectId = 'doc-1') =>
    t.withIdentity(person(as)).mutation(api.versions.create, {
      projectId,
      label,
      snapshot: snapshotUpload({ localProjectId, revision: 0 }),
    })

  test('reclaims the document it pinned, and leaves the log alone', async () => {
    // The only way to get a named snapshot back: automatic checkpoints are
    // pruned to a window, a named one is kept forever by design.
    const t = harness()
    const project = expectOk(await claim(t, 'owner'))
    const version = expectOk(await save(t, 'owner', project.projectId, 'milestone'))
    expect(await chunksFor(t, project.projectId as Id<'projects'>)).toBeGreaterThan(0)

    const before = expectOk(
      await t.withIdentity(person('owner')).query(api.transactions.listSince, {
        projectId: project.projectId,
        sinceRevision: 0,
      }),
    ).length
    expectOk(
      await t
        .withIdentity(person('owner'))
        .mutation(api.versions.remove, { projectId: project.projectId, versionId: version.versionId }),
    )
    await t.finishAllScheduledFunctions(() => {})

    expect(await chunksFor(t, project.projectId as Id<'projects'>)).toBe(0)
    // A version is a name for a revision, not the revision.
    expect(
      expectOk(
        await t.withIdentity(person('owner')).query(api.transactions.listSince, {
          projectId: project.projectId,
          sinceRevision: 0,
        }),
      ).length,
    ).toBe(before)
  })

  test('lets a project at its ceiling save another', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const now = Date.now()
    let last: Id<'versions'> | null = null
    await t.run(async (ctx) => {
      for (let index = 0; index < COLLECTION_LIMITS.versionsPerProject; index += 1) {
        last = await ctx.db.insert('versions', {
          projectId: seeded.projectId,
          branchId: seeded.branchId,
          revision: index,
          label: `v${index}`,
          snapshotGroupId: `group-${index}`,
          documentChecksum: 'x',
          createdBySubject: subjectOf('owner'),
          createdAt: now + index,
        })
      }
    })
    expect(codeOf(await save(t, 'owner', seeded.projectId, 'one more', 'local-owner'))).toBe('COLLECTION_FULL')

    expectOk(
      await t
        .withIdentity(person('owner'))
        .mutation(api.versions.remove, { projectId: seeded.projectId, versionId: last! }),
    )
    expect(codeOf(await save(t, 'owner', seeded.projectId, 'one more', 'local-owner'))).toBe('ok')
  })

  test('lets an editor remove their own but not somebody else’s', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    const mine = expectOk(await save(t, 'editor', seeded.projectId, 'mine', 'local-owner'))
    const theirs = expectOk(await save(t, 'owner', seeded.projectId, 'theirs', 'local-owner'))

    expectOk(
      await t
        .withIdentity(person('editor'))
        .mutation(api.versions.remove, { projectId: seeded.projectId, versionId: mine.versionId }),
    )
    // A version is how a collaborator refers to a point in history, so taking
    // one away is an owner's decision rather than any editor's.
    expect(
      codeOf(
        await t
          .withIdentity(person('editor'))
          .mutation(api.versions.remove, { projectId: seeded.projectId, versionId: theirs.versionId }),
      ),
    ).toBe('FORBIDDEN')
    expectOk(
      await t
        .withIdentity(person('owner'))
        .mutation(api.versions.remove, { projectId: seeded.projectId, versionId: theirs.versionId }),
    )
  })

  test('never reaches a checkpoint through the version path', async () => {
    // `kind` is checked per chunk rather than trusted, so a group id passed to
    // the version pruner cannot empty the checkpoint a branch opens from.
    const t = harness()
    const project = expectOk(await claim(t, 'owner'))
    await t.run(async (ctx) => {
      const branch = (await ctx.db.get(project.projectId as Id<'projects'>))!.defaultBranchId!
      await ctx.db.insert('snapshots', {
        projectId: project.projectId as Id<'projects'>,
        branchId: branch,
        groupId: 'shared-group',
        kind: 'checkpoint',
        revision: 0,
        chunkIndex: 0,
        chunkCount: 1,
        data: '{}',
        checksum: 'x',
        bytes: 2,
        schemaVersion: 2,
        catalogVersion: 'fixture-1',
        createdBySubject: subjectOf('owner'),
        createdAt: Date.now(),
      })
    })
    await t.mutation(internal.versions.pruneVersionSnapshot, { groupId: 'shared-group' })

    const left = await t.run(async (ctx) =>
      (await ctx.db.query('snapshots').withIndex('by_group', (q) => q.eq('groupId', 'shared-group')).collect()).length,
    )
    expect(left).toBe(1)
  })
})

describe('deleting a branch', () => {
  /** A fork copies the source branch's newest checkpoint, so one has to exist. */
  const checkpoint = (t: Harness, projectId: string) =>
    t.withIdentity(person('owner')).mutation(api.projects.saveCheckpoint, {
      projectId,
      snapshot: snapshotUpload({ localProjectId: 'local-owner', revision: 0 }),
    })

  const fork = (t: Harness, as: string, projectId: string, name: string, fromBranchId?: string) =>
    t.withIdentity(person(as)).mutation(api.versions.createBranch, {
      projectId,
      name,
      ...(fromBranchId ? { fromBranchId } : {}),
    })

  const branchCount = (t: Harness, projectId: Id<'projects'>): Promise<number> =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('branches')
          .withIndex('by_project', (q) => q.eq('projectId', projectId))
          .collect()
      ).length,
    )

  test('lets a project at its ceiling open another branch', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    expectOk(await checkpoint(t, seeded.projectId))
    const existing = await seededBranches(t, seeded.projectId)
    const now = Date.now()
    let last: Id<'branches'> | null = null
    await t.run(async (ctx) => {
      for (let index = 0; index < COLLECTION_LIMITS.branchesPerProject - existing; index += 1) {
        last = await ctx.db.insert('branches', {
          projectId: seeded.projectId,
          name: `seeded-${index}`,
          headRevision: 0,
          baseRevision: 0,
          kind: 'named',
          createdBySubject: subjectOf('editor'),
          createdAt: now,
          updatedAt: now,
        })
      }
    })
    expect(codeOf(await fork(t, 'editor', seeded.projectId, 'one-too-many'))).toBe('COLLECTION_FULL')

    expectOk(
      await t
        .withIdentity(person('editor'))
        .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId: last! }),
    )
    expect(codeOf(await fork(t, 'editor', seeded.projectId, 'one-too-many'))).toBe('ok')
  })

  test('refuses the default branch, whose absence closes the project', async () => {
    // A freshly claimed project has only `main`, so nothing forks from it and
    // this is the only check standing between it and an unopenable project.
    const t = harness()
    const project = expectOk(
      await t.withIdentity(person('owner')).mutation(api.projects.create, {
        localProjectId: 'doc-1',
        name: 'Only main',
        schemaVersion: 2,
        catalogVersion: 'fixture-1',
      }),
    )
    const refused = await t
      .withIdentity(person('owner'))
      .mutation(api.versions.removeBranch, { projectId: project.projectId, branchId: project.defaultBranchId })
    expect(codeOf(refused)).toBe('FORBIDDEN')
    expect(await branchCount(t, project.projectId as Id<'projects'>)).toBe(1)
    // Still openable, which is the thing the refusal protects.
    expectOk(await t.withIdentity(person('owner')).query(api.projects.get, { projectId: project.projectId }))
  })

  test('refuses a branch something forked from, whose history replays through it', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    expectOk(await checkpoint(t, seeded.projectId))
    const parent = expectOk(await fork(t, 'owner', seeded.projectId, 'parent'))
    expectOk(await fork(t, 'owner', seeded.projectId, 'child', parent.branchId))

    const refused = await t
      .withIdentity(person('owner'))
      .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId: parent.branchId })
    expect(codeOf(refused)).toBe('FORBIDDEN')
  })

  test('refuses a branch under an open proposal, so the decision is recorded', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    const refused = await t
      .withIdentity(person('owner'))
      .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId: seeded.proposedBranchId })
    expect(codeOf(refused)).toBe('FORBIDDEN')
  })

  test('refuses a branch holding a named version, and allows it once that goes', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    expectOk(await checkpoint(t, seeded.projectId))
    const side = expectOk(await fork(t, 'owner', seeded.projectId, 'with-versions'))
    const version = expectOk(
      await t.withIdentity(person('owner')).mutation(api.versions.create, {
        projectId: seeded.projectId,
        branchId: side.branchId,
        label: 'pinned',
        snapshot: snapshotUpload({ localProjectId: 'local-owner', revision: 0 }),
      }),
    )
    expect(
      codeOf(
        await t
          .withIdentity(person('owner'))
          .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId: side.branchId }),
      ),
    ).toBe('FORBIDDEN')

    // The two deletes compose: named history goes by its own path first.
    expectOk(
      await t
        .withIdentity(person('owner'))
        .mutation(api.versions.remove, { projectId: seeded.projectId, versionId: version.versionId }),
    )
    expectOk(
      await t
        .withIdentity(person('owner'))
        .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId: side.branchId }),
    )
  })

  test('takes the branch’s log and checkpoints with it', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    expectOk(await checkpoint(t, seeded.projectId))
    const side = expectOk(await fork(t, 'owner', seeded.projectId, 'doomed'))
    const branchId = side.branchId as Id<'branches'>
    const rows = () =>
      t.run(async (ctx) => ({
        edits: (
          await ctx.db
            .query('transactions')
            .withIndex('by_branch_revision', (q) => q.eq('branchId', branchId))
            .collect()
        ).length,
        chunks: (
          await ctx.db
            .query('snapshots')
            .withIndex('by_branch_kind_revision', (q) => q.eq('branchId', branchId).eq('kind', 'checkpoint'))
            .collect()
        ).length,
      }))
    expect((await rows()).chunks).toBeGreaterThan(0)

    expectOk(
      await t
        .withIdentity(person('owner'))
        .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId }),
    )
    await t.finishAllScheduledFunctions(() => {})
    expect(await rows()).toEqual({ edits: 0, chunks: 0 })
  })

  test('lets an editor remove their own but not somebody else’s', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { editor: 'editor' } })
    expectOk(await checkpoint(t, seeded.projectId))
    const mine = expectOk(await fork(t, 'editor', seeded.projectId, 'mine'))
    const theirs = expectOk(await fork(t, 'owner', seeded.projectId, 'theirs'))

    expectOk(
      await t
        .withIdentity(person('editor'))
        .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId: mine.branchId }),
    )
    expect(
      codeOf(
        await t
          .withIdentity(person('editor'))
          .mutation(api.versions.removeBranch, { projectId: seeded.projectId, branchId: theirs.branchId }),
      ),
    ).toBe('FORBIDDEN')
  })
})
