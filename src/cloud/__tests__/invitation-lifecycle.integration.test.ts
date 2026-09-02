// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import schema from '../../../convex/schema'
import { internal } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { ConvexCloudBackend } from '../convexClient'
import type { CloudResult } from '../protocol'
import { snapshotUploadFor } from '../serialize'
import { blankProject } from './harness'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-30T12:00:00Z'))
  for (const key of [
    'INVITATION_EMAIL_ENDPOINT',
    'INVITATION_EMAIL_TOKEN',
    'INVITATION_LINK_ORIGIN',
    'HEXCLAVE_PROJECT_ID',
    'HEXCLAVE_SECRET_SERVER_KEY',
    'HEXCLAVE_API_URL_SERVER',
    'HEXCLAVE_API_URL',
  ])
    vi.stubEnv(key, '')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function setup() {
  const deployment = convexTest(schema, modules)
  const alice = deployment.withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const bob = deployment.withIdentity({ subject: 'bob', tokenIdentifier: 'hexclave|bob' })
  const backend = new ConvexCloudBackend(alice as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const bobBackend = new ConvexCloudBackend(bob as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const base = blankProject('invitation-lifecycle')
  const project = value(
    await backend.createProject({
      localProjectId: base.id,
      name: base.name,
      schemaVersion: base.schemaVersion,
      catalogVersion: base.catalogVersion,
      snapshot: snapshotUploadFor(base),
    }),
  )
  const invite = () =>
    backend.createInvitation({ projectId: project.projectId, email: 'builder@example.test', role: 'editor' })
  const row = (id: string) => alice.run((ctx) => ctx.db.get(id as Id<'invitations'>))
  const counts = () =>
    alice.run(async (ctx) => ({
      invitations: (await ctx.db.query('invitations').collect()).length,
      members: (await ctx.db.query('members').collect()).length,
      audits: (await ctx.db.query('auditEvents').collect()).length,
    }))
  return { deployment, alice, bob, backend, bobBackend, project, invite, row, counts }
}

describe('invitation lifecycle (actual Convex handlers)', () => {
  it('allows replacing a pending invite whose expiry has passed', async () => {
    const h = await setup()
    const first = value(await h.invite())
    await h.alice.run((ctx) => ctx.db.patch(first.invitationId as Id<'invitations'>, { expiresAt: Date.now() }))
    const second = value(await h.invite())
    expect(second.invitationId).not.toBe(first.invitationId)
  })

  it('acknowledges acceptance retries by the same current member without more writes', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const stored = (await h.row(invitation.invitationId))!
    const accepted = value(await h.bobBackend.acceptInvitation({ token: stored.token }))
    const before = await h.counts()
    expect(value(await h.bobBackend.acceptInvitation({ token: stored.token }))).toEqual(accepted)
    expect(await h.counts()).toEqual(before)
  })

  it('does not give a revoked invitation to the delivery worker', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    value(await h.backend.revokeInvitation({ projectId: h.project.projectId, invitationId: invitation.invitationId }))
    expect(
      await h.alice.query(internal.invitations.deliveryContext, {
        invitationId: invitation.invitationId as Id<'invitations'>,
      }),
    ).toBeNull()
  })
})

const configure = () => {
  vi.stubEnv('INVITATION_EMAIL_ENDPOINT', 'https://mail.example.test/invitations')
  vi.stubEnv('INVITATION_EMAIL_TOKEN', 'server-only-secret')
  vi.stubEnv('INVITATION_LINK_ORIGIN', 'https://brickwrite.example.test')
}
const deliver = (h: Awaited<ReturnType<typeof setup>>, invitationId: string, generation = 0) =>
  h.alice.action(internal.invitations.deliver, { invitationId: invitationId as Id<'invitations'>, generation })
const patch = (h: Awaited<ReturnType<typeof setup>>, invitationId: string, updates: Record<string, unknown>) =>
  h.alice.run((ctx) => ctx.db.patch(invitationId as Id<'invitations'>, updates))
const retry = (h: Awaited<ReturnType<typeof setup>>, invitationId: string) =>
  h.backend.retryInvitationDelivery({ projectId: h.project.projectId, invitationId })

describe('leased invitation delivery', () => {
  it('uses Hexclave natively when only its server credentials and link origin are configured', async () => {
    vi.stubEnv('HEXCLAVE_PROJECT_ID', 'hexclave-fixture-project')
    vi.stubEnv('HEXCLAVE_SECRET_SERVER_KEY', 'hexclave-fixture-secret')
    vi.stubEnv('INVITATION_LINK_ORIGIN', 'https://brickwrite.example.test')
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const h = await setup()
    const invitation = value(await h.invite())
    await h.deployment.finishAllScheduledFunctions(vi.runAllTimers)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('https://api.hexclave.com/api/v1/emails/send-email')
    expect(JSON.parse(fetcher.mock.calls[0][1].body).emails).toEqual(['builder@example.test'])
    /*
     * The expiry the row actually carries, not a duration the message restated.
     * It said "14 days" against a seventy-two hour lifetime, so a recipient
     * reading it on day five found a dead link and no explanation. Asserted
     * here, through the real `deliver` action, because the delivery module can
     * be correct while the context handed to it is not.
     */
    const row = (await h.row(invitation.invitationId))!
    expect(JSON.parse(fetcher.mock.calls[0][1].body).html).toContain(
      new Date(row.expiresAt).toISOString().replace('T', ' ').slice(0, 16),
    )
    const listed = value(await h.backend.listInvitations({ projectId: h.project.projectId }))[0]
    expect(listed).toMatchObject({
      invitationId: invitation.invitationId,
      deliveryStatus: 'queued',
      deliveryAttempts: 1,
    })
    expect(listed.deliveryReason).toContain('Hexclave accepted')
    expect(JSON.stringify(listed)).not.toContain('hexclave-fixture-secret')
  })

  it('hides legacy error payloads and prevents old unleased workers from reading new invitations', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    expect(
      await h.alice.query(internal.invitations.deliveryContext, {
        invitationId: invitation.invitationId as Id<'invitations'>,
      }),
    ).toBeNull()
    await patch(h, invitation.invitationId, {
      deliveryGeneration: undefined,
      deliveryReason: 'secret-provider-url-and-invitation-token',
    })
    expect(
      await h.alice.query(internal.invitations.deliveryContext, {
        invitationId: invitation.invitationId as Id<'invitations'>,
      }),
    ).toBeNull()
    const listed = value(await h.backend.listInvitations({ projectId: h.project.projectId }))[0]
    expect(listed.deliveryReason).toContain('Legacy delivery record')
    expect(JSON.stringify(listed)).not.toContain('secret-provider-url-and-invitation-token')
  })

  it('claims old scheduled arguments and legacy rows safely after an additive deployment', async () => {
    configure()
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    const h = await setup()
    const invitation = value(await h.invite())
    await patch(h, invitation.invitationId, {
      deliveryGeneration: undefined,
      deliveryAttempts: undefined,
      deliveryRequestedAt: undefined,
    })
    await h.alice.action(internal.invitations.deliver, { invitationId: invitation.invitationId as Id<'invitations'> })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await h.row(invitation.invitationId)).toMatchObject({
      deliveryStatus: 'queued',
      deliveryGeneration: 0,
      deliveryAttempts: 1,
    })
  })

  it('preserves confirmed provider acceptance when an unused invitation expires', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const token = (await h.row(invitation.invitationId))!.token
    await patch(h, invitation.invitationId, { deliveryStatus: 'queued', expiresAt: Date.now() })
    expect(await h.bobBackend.acceptInvitation({ token })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await h.row(invitation.invitationId)).toMatchObject({ status: 'expired', deliveryStatus: 'queued' })
  })

  it('submits once, reports endpoint acceptance rather than inbox delivery, and hides credentials', async () => {
    configure()
    const fetcher = vi.fn().mockResolvedValue(new Response('private provider response', { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    const h = await setup()
    const invitation = value(await h.invite())
    await Promise.all([deliver(h, invitation.invitationId), deliver(h, invitation.invitationId)])
    await deliver(h, invitation.invitationId)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('https://mail.example.test/invitations')
    expect(options.redirect).toBe('manual')
    expect(options.headers.authorization).toBe('Bearer server-only-secret')
    expect(options.headers['idempotency-key']).toContain(invitation.invitationId)
    const row = (await h.row(invitation.invitationId))!
    expect(JSON.parse(options.body).invitationUrl).toBe(`https://brickwrite.example.test/invite/${row.token}`)
    expect(row.deliveryAttempts).toBe(1)
    const list = value(await h.backend.listInvitations({ projectId: h.project.projectId }))
    expect(list[0]).toMatchObject({ deliveryStatus: 'queued', deliveryAttempts: 1 })
    expect(JSON.stringify(list)).not.toMatch(/server-only-secret|private provider response/)
    expect(JSON.stringify(list)).not.toContain(row.token)
    expect(list[0].deliveryRetryAt).toBeUndefined()
  })

  it.each(['revoked', 'accepted', 'expired', 'deleted'] as const)(
    'skips %s work before contacting the provider',
    async (state) => {
      configure()
      const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
      vi.stubGlobal('fetch', fetcher)
      const h = await setup()
      const invitation = value(await h.invite())
      if (state === 'revoked')
        value(
          await h.backend.revokeInvitation({ projectId: h.project.projectId, invitationId: invitation.invitationId }),
        )
      if (state === 'accepted')
        value(await h.bobBackend.acceptInvitation({ token: (await h.row(invitation.invitationId))!.token }))
      if (state === 'expired') await patch(h, invitation.invitationId, { expiresAt: Date.now() })
      if (state === 'deleted') value(await h.backend.deleteProject({ projectId: h.project.projectId }))
      await deliver(h, invitation.invitationId)
      expect(fetcher).not.toHaveBeenCalled()
      expect((await h.row(invitation.invitationId))!.deliveryStatus).toBe('cancelled')
    },
  )

  it('marks missing configuration without attempting an external request', async () => {
    for (const key of ['INVITATION_EMAIL_ENDPOINT', 'INVITATION_EMAIL_TOKEN', 'INVITATION_LINK_ORIGIN'])
      vi.stubEnv(key, '')
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const h = await setup()
    const invitation = value(await h.invite())
    await deliver(h, invitation.invitationId)
    expect((await h.row(invitation.invitationId))!.deliveryStatus).toBe('not-configured')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'accepted', 'expired', 'deleted'] as const)(
    'does not let late completion override %s state',
    async (state) => {
      const h = await setup()
      const invitation = value(await h.invite())
      const id = invitation.invitationId as Id<'invitations'>
      expect(
        await h.alice.mutation(internal.invitations.claimDelivery, { invitationId: id, generation: 0 }),
      ).not.toBeNull()
      if (state === 'revoked')
        value(await h.backend.revokeInvitation({ projectId: h.project.projectId, invitationId: id }))
      if (state === 'accepted') value(await h.bobBackend.acceptInvitation({ token: (await h.row(id))!.token }))
      if (state === 'expired') await patch(h, id, { expiresAt: Date.now() })
      if (state === 'deleted') value(await h.backend.deleteProject({ projectId: h.project.projectId }))
      await h.alice.mutation(internal.invitations.markDelivery, {
        invitationId: id,
        generation: 0,
        deliveryStatus: 'queued',
      })
      expect((await h.row(id))!.deliveryStatus).toBe('cancelled')
    },
  )

  it('ignores completion from an old unleased worker', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const id = invitation.invitationId as Id<'invitations'>
    await h.alice.mutation(internal.invitations.claimDelivery, { invitationId: id, generation: 0 })
    await h.alice.mutation(internal.invitations.markDelivery, { invitationId: id, deliveryStatus: 'sent' })
    expect((await h.row(id))!.deliveryStatus).toBe('sending')
  })
})

describe('owner-controlled retry', () => {
  it('retries the original token after failure and makes repeated queue requests idempotent', async () => {
    configure()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    const h = await setup()
    const invitation = value(await h.invite())
    const original = (await h.row(invitation.invitationId))!
    await deliver(h, invitation.invitationId)
    expect((await h.row(invitation.invitationId))!.deliveryStatus).toBe('failed')
    expect(await retry(h, invitation.invitationId)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    vi.setSystemTime(Date.now() + 30_000)
    const requested = value(await retry(h, invitation.invitationId))
    const before = await h.counts()
    expect(value(await retry(h, invitation.invitationId))).toEqual(requested)
    expect(await h.counts()).toEqual(before)
    await deliver(h, invitation.invitationId, 0) // stale queued job
    expect(fetcher).toHaveBeenCalledTimes(1)
    await deliver(h, invitation.invitationId, 1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await h.row(invitation.invitationId)).toMatchObject({
      token: original.token,
      expiresAt: original.expiresAt,
      role: original.role,
      deliveryStatus: 'queued',
      deliveryAttempts: 2,
    })
  })

  it.each(['pending', 'sending'] as const)(
    'recovers a stranded %s lease and ignores its stale worker',
    async (state) => {
      const h = await setup()
      const invitation = value(await h.invite())
      const id = invitation.invitationId as Id<'invitations'>
      if (state === 'sending')
        await h.alice.mutation(internal.invitations.claimDelivery, { invitationId: id, generation: 0 })
      const before = await h.counts()
      value(await retry(h, id)) // fresh work: no additional scheduling/audit
      expect(await h.counts()).toEqual(before)
      vi.setSystemTime(Date.now() + 60_000)
      value(await retry(h, id))
      expect((await h.row(id))!.deliveryGeneration).toBe(1)
      expect(await h.alice.mutation(internal.invitations.claimDelivery, { invitationId: id, generation: 0 })).toBeNull()
      await h.alice.mutation(internal.invitations.markDelivery, {
        invitationId: id,
        generation: 0,
        deliveryStatus: 'queued',
      })
      expect((await h.row(id))!.deliveryStatus).toBe('pending')
      expect(
        await h.alice.mutation(internal.invitations.claimDelivery, { invitationId: id, generation: 1 }),
      ).not.toBeNull()
    },
  )

  it.each(['revoked', 'accepted', 'expired', 'queued', 'sent'] as const)(
    'does not retry %s invitations',
    async (state) => {
      const h = await setup()
      const invitation = value(await h.invite())
      await patch(
        h,
        invitation.invitationId,
        ['queued', 'sent'].includes(state) ? { deliveryStatus: state } : { status: state },
      )
      const before = await h.counts()
      expect(await retry(h, invitation.invitationId)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
      expect(await h.counts()).toEqual(before)
    },
  )

  it.each(['anonymous', 'outsider', 'viewer', 'editor'] as const)('refuses delivery retry by %s', async (role) => {
    const h = await setup()
    const invitation = value(await h.invite())
    if (role === 'viewer' || role === 'editor')
      await h.alice.run((ctx) =>
        ctx.db.insert('members', {
          projectId: h.project.projectId as Id<'projects'>,
          subject: 'hexclave|bob',
          role,
          addedAt: Date.now(),
        }),
      )
    const client = role === 'anonymous' ? h.deployment : h.bob
    const backend = new ConvexCloudBackend(client as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
    const before = await h.counts()
    expect(
      await backend.retryInvitationDelivery({ projectId: h.project.projectId, invitationId: invitation.invitationId }),
    ).toMatchObject({
      ok: false,
      error: { code: role === 'anonymous' ? 'UNAUTHENTICATED' : role === 'outsider' ? 'NOT_FOUND' : 'FORBIDDEN' },
    })
    expect(await h.counts()).toEqual(before)
  })
})

describe('single-use acceptance receipts', () => {
  it('reports the current role on retry instead of restoring the invited role', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const token = (await h.row(invitation.invitationId))!.token
    value(await h.bobBackend.acceptInvitation({ token }))
    value(await h.backend.setMemberRole({ projectId: h.project.projectId, subject: 'hexclave|bob', role: 'viewer' }))
    const before = await h.counts()
    expect(value(await h.bobBackend.acceptInvitation({ token })).role).toBe('viewer')
    expect(await h.counts()).toEqual(before)
  })

  it('does not resurrect membership removed after acceptance', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const token = (await h.row(invitation.invitationId))!.token
    value(await h.bobBackend.acceptInvitation({ token }))
    value(await h.backend.removeMember({ projectId: h.project.projectId, subject: 'hexclave|bob' }))
    const before = await h.counts()
    expect(await h.bobBackend.acceptInvitation({ token })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await h.counts()).toEqual(before)
  })

  it('does not let another identity reuse an accepted token', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const token = (await h.row(invitation.invitationId))!.token
    value(await h.bobBackend.acceptInvitation({ token }))
    const before = await h.counts()
    expect(await h.backend.acceptInvitation({ token })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await h.counts()).toEqual(before)
  })

  it('refuses at the exact expiry instant but acknowledges a previously accepted receipt after expiry', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const token = (await h.row(invitation.invitationId))!.token
    await patch(h, invitation.invitationId, { expiresAt: Date.now() })
    expect(await h.bobBackend.acceptInvitation({ token })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const fresh = value(await h.invite())
    const freshToken = (await h.row(fresh.invitationId))!.token
    value(await h.bobBackend.acceptInvitation({ token: freshToken }))
    vi.setSystemTime(Date.now() + 15 * 24 * 60 * 60 * 1000)
    expect(value(await h.bobBackend.acceptInvitation({ token: freshToken })).role).toBe('editor')
  })

  it('does not acknowledge a receipt after the project is deleted', async () => {
    const h = await setup()
    const invitation = value(await h.invite())
    const token = (await h.row(invitation.invitationId))!.token
    value(await h.bobBackend.acceptInvitation({ token }))
    value(await h.backend.deleteProject({ projectId: h.project.projectId }))
    expect(await h.bobBackend.acceptInvitation({ token })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

it('does not miss duplicates behind invitations for the same address in other projects', async () => {
  const h = await setup()
  const template = value(await h.invite())
  const row = (await h.row(template.invitationId))!
  await h.alice.run(async (ctx) => {
    // These predate the target invite in the old global email/status index.
    await ctx.db.delete(template.invitationId as Id<'invitations'>)
    const foreignId = await ctx.db.insert('projects', {
      ownerSubject: 'hexclave|alice',
      name: 'Other project',
      visibility: 'private',
      localProjectId: 'other',
      schemaVersion: 2,
      catalogVersion: 'fixture',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const copy = { ...row }
    Reflect.deleteProperty(copy, '_id')
    Reflect.deleteProperty(copy, '_creationTime')
    for (let i = 0; i < 33; i++) {
      await ctx.db.insert('invitations', { ...copy, projectId: foreignId, token: `other-${i}` })
    }
  })
  const actual = value(await h.invite())
  const before = await h.counts()
  expect(await h.invite()).toMatchObject({
    ok: false,
    error: { code: 'NAME_TAKEN', details: { invitationId: actual.invitationId } },
  })
  expect(await h.counts()).toEqual(before)
})

it('lists the newest invitations and projects expiry truthfully without exposing tokens', async () => {
  const h = await setup()
  const first = value(await h.invite())
  await patch(h, first.invitationId, { expiresAt: Date.now() })
  const second = value(await h.invite())
  const list = value(await h.backend.listInvitations({ projectId: h.project.projectId }))
  expect(list.map((row) => row.invitationId)).toEqual([second.invitationId, first.invitationId])
  expect(list[1].status).toBe('expired')
  expect(list[1].deliveryRetryAt).toBeUndefined()
  expect(JSON.stringify(list)).not.toContain((await h.row(second.invitationId))!.token)
})

it('rejects oversized email addresses without writing an invitation or audit', async () => {
  const h = await setup()
  const before = await h.counts()
  expect(
    await h.backend.createInvitation({
      projectId: h.project.projectId,
      email: `${'a'.repeat(255)}@example.test`,
      role: 'viewer',
    }),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  expect(await h.counts()).toEqual(before)
})

it('executes the worker scheduled by invitation creation', async () => {
  configure()
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
  vi.stubGlobal('fetch', fetcher)
  const h = await setup()
  const invitation = value(await h.invite())
  await h.alice.finishAllScheduledFunctions(vi.runAllTimers)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect((await h.row(invitation.invitationId))!.deliveryStatus).toBe('queued')
})
