// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { COLLECTION_LIMITS } from '../model/limits'
import { codeOf, expectOk, harness, person, seedProject, subjectOf, type Harness } from './harness'

/**
 * Rows that stop meaning anything are removed.
 *
 * Both tables here were only ever filtered on read: a dead presence row and a
 * lapsed invitation were correctly excluded from every answer and then kept
 * forever. Neither read was wrong, so nothing failed — the tables just grew,
 * and in the invitation case the growth reached the per-project ceiling and
 * turned into a refusal to invite anybody ever again.
 */

const DAY = 24 * 60 * 60 * 1000

const presenceRows = (t: Harness, projectId: Id<'projects'>): Promise<number> =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('presence')
          .withIndex('by_project_expiry', (q) => q.eq('projectId', projectId))
          .collect()
      ).length,
  )

const invitationRows = (t: Harness, projectId: Id<'projects'>): Promise<number> =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('invitations')
          .withIndex('by_project', (q) => q.eq('projectId', projectId))
          .collect()
      ).length,
  )

describe('presence', () => {
  test('removes leases that ran out when a new session arrives', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    await t.run(async (ctx) => {
      for (let index = 0; index < 20; index += 1) {
        await ctx.db.insert('presence', {
          projectId: seeded.projectId,
          subject: subjectOf('owner'),
          sessionId: `dead-${index}`,
          color: '#f0a202',
          revision: 0,
          selection: [],
          updatedAt: Date.now() - 60_000,
          // A tab that crashed: `leave` never ran and the lease lapsed.
          expiresAt: Date.now() - 30_000,
        })
      }
    })
    expect(await presenceRows(t, seeded.projectId)).toBe(20)

    const join = (sessionId: string) =>
      t.withIdentity(person('owner')).mutation(api.presence.heartbeat, {
        projectId: seeded.projectId,
        sessionId,
        revision: 0,
        selection: [],
      })

    expectOk(await join('live-tab'))
    const afterOne = await presenceRows(t, seeded.projectId)
    expect(afterOne).toBeLessThan(21)

    // Each pass is bounded, so the property that matters is convergence: a
    // handful of new sessions leaves only the live rows behind.
    expectOk(await join('second-tab'))
    expectOk(await join('third-tab'))
    expect(await presenceRows(t, seeded.projectId)).toBe(3)
  })

  test('never removes a lease that is still live', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner', members: { peer: 'editor' } })
    expectOk(
      await t.withIdentity(person('peer')).mutation(api.presence.heartbeat, {
        projectId: seeded.projectId,
        sessionId: 'peer-tab',
        revision: 0,
        selection: [],
      }),
    )
    expectOk(
      await t.withIdentity(person('owner')).mutation(api.presence.heartbeat, {
        projectId: seeded.projectId,
        sessionId: 'owner-tab',
        revision: 0,
        selection: [],
      }),
    )

    const live = expectOk(
      await t.withIdentity(person('owner')).query(api.presence.list, { projectId: seeded.projectId }),
    )
    expect(live).toHaveLength(2)
  })

  test('a heartbeat on an existing session does no sweeping work', async () => {
    // The sweep is tied to a new session id, which is the only thing that
    // creates a row. Running it on every heartbeat would put it on the
    // interactive path for no gain.
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    const beat = () =>
      t.withIdentity(person('owner')).mutation(api.presence.heartbeat, {
        projectId: seeded.projectId,
        sessionId: 'one-tab',
        revision: 0,
        selection: [],
      })
    expectOk(await beat())
    await t.run(async (ctx) => {
      await ctx.db.insert('presence', {
        projectId: seeded.projectId,
        subject: subjectOf('owner'),
        sessionId: 'dead',
        color: '#f0a202',
        revision: 0,
        selection: [],
        updatedAt: Date.now() - 60_000,
        expiresAt: Date.now() - 30_000,
      })
    })
    expectOk(await beat())
    expect(await presenceRows(t, seeded.projectId)).toBe(2)
  })
})

describe('invitations', () => {
  const seedInvitations = (t: Harness, projectId: Id<'projects'>, count: number, expiresAt: number) =>
    t.run(async (ctx) => {
      for (let index = 0; index < count; index += 1) {
        await ctx.db.insert('invitations', {
          projectId,
          email: `person${index}@example.test`,
          role: 'viewer',
          token: `token-${index}-${expiresAt}`,
          invitedBySubject: subjectOf('owner'),
          createdAt: 0,
          expiresAt,
          status: 'expired',
          deliveryStatus: 'sent',
        })
      }
    })

  test('a project that has invited its ceiling over its lifetime can still invite', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    // Long dead: sent and lapsed well before the grace period ended.
    await seedInvitations(t, seeded.projectId, COLLECTION_LIMITS.invitationsPerProject, Date.now() - 30 * DAY)

    const sent = await t.withIdentity(person('owner')).mutation(api.invitations.create, {
      projectId: seeded.projectId,
      email: 'new.person@example.test',
      role: 'viewer',
    })
    expect(codeOf(sent)).toBe('ok')
    // The rows are actually reclaimed, not merely discounted: the ceiling would
    // still admit the write if the count were adjusted and nothing deleted, and
    // the storage would keep growing.
    expect(await invitationRows(t, seeded.projectId)).toBeLessThan(COLLECTION_LIMITS.invitationsPerProject)
  })

  test('still refuses when the ceiling is reached by live invitations', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    await seedInvitations(t, seeded.projectId, COLLECTION_LIMITS.invitationsPerProject, Date.now() + 30 * DAY)

    const sent = await t.withIdentity(person('owner')).mutation(api.invitations.create, {
      projectId: seeded.projectId,
      email: 'new.person@example.test',
      role: 'viewer',
    })
    expect(codeOf(sent)).toBe('COLLECTION_FULL')
  })

  test('keeps a recently lapsed invitation, so an owner can see it lapsed', async () => {
    const t = harness()
    const seeded = await seedProject(t, { owner: 'owner' })
    await seedInvitations(t, seeded.projectId, 1, Date.now() - 60_000)

    expectOk(
      await t.withIdentity(person('owner')).mutation(api.invitations.create, {
        projectId: seeded.projectId,
        email: 'new.person@example.test',
        role: 'viewer',
      }),
    )
    expect(await invitationRows(t, seeded.projectId)).toBe(2)
  })
})
