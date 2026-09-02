// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
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
