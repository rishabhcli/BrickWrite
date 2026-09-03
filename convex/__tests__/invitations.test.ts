// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { codeOf, expectOk, harness, person, seedProject, subjectOf, type Harness, type SeededProject } from './harness.setup'

/**
 * The invitation lifecycle, against the real handlers.
 *
 * An invitation is the only bearer credential this deployment mints and the
 * only place it stores an email address, so the properties worth pinning are
 * the ones that decide who ends up inside a project: single use, expiry, no
 * silent role change, and an audit trail that never carries the address.
 */

async function invite(t: Harness, seed: SeededProject, as: string, email: string, role: 'editor' | 'commenter' | 'viewer' = 'viewer') {
  return expectOk(
    await t.withIdentity(person(as)).mutation(api.invitations.create, { projectId: seed.projectId, email, role }),
  )
}

/** The token, which the record deliberately does not expose to the client. */
async function tokenFor(t: Harness, invitationId: string): Promise<string> {
  return t.run(async (ctx) => {
    const row = (await ctx.db.get(invitationId as never)) as Doc<'invitations'> | null
    if (!row) throw new Error('invitation vanished')
    return row.token
  })
}

describe('creating an invitation', () => {
  test('an owner may invite and the record carries no token', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'Guest@Example.test', 'editor')
    expect(record.role).toBe('editor')
    expect(record.status).toBe('pending')
    // Lower-cased on the way in, so duplicate detection cannot be bypassed by
    // changing the case of an address.
    expect(record.email).toBe('guest@example.test')
    expect(JSON.stringify(record)).not.toContain('token')
  })

  test('a second pending invitation to the same address is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    await invite(t, seed, 'owner-account', 'guest@example.test')
    const again = await t
      .withIdentity(person('owner-account'))
      .mutation(api.invitations.create, { projectId: seed.projectId, email: 'GUEST@example.test', role: 'viewer' })
    expect(codeOf(again)).toBe('NAME_TAKEN')
  })

  test('a malformed address is refused before anything is written', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    for (const email of ['not-an-address', 'no@domain', 'two@@at.test', `${'a'.repeat(250)}@example.test`]) {
      const result = await t
        .withIdentity(person('owner-account'))
        .mutation(api.invitations.create, { projectId: seed.projectId, email, role: 'viewer' })
      expect(codeOf(result)).toBe('INVALID_ARGUMENT')
    }
    const rows = await t.run(async (ctx) => ctx.db.query('invitations').collect())
    expect(rows).toHaveLength(0)
  })

  test('the audit trail records the role and never the address', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    await invite(t, seed, 'owner-account', 'secret.person@example.test', 'commenter')
    const trail = expectOk(
      await t.withIdentity(person('owner-account')).query(api.projects.auditTrail, { projectId: seed.projectId }),
    )
    const created = trail.find((entry) => entry.action === 'invitation.create')
    expect(created).toBeDefined()
    expect(JSON.stringify(trail)).not.toContain('secret.person')
  })
})

describe('accepting an invitation', () => {
  test('a signed-in invitee becomes a member at the invited role', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test', 'editor')
    const token = await tokenFor(t, record.invitationId)

    const accepted = expectOk(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))
    expect(accepted.role).toBe('editor')

    const role = expectOk(await t.withIdentity(person('guest')).query(api.members.myRole, { projectId: seed.projectId }))
    expect(role).toBe('editor')
  })

  test('the token is single use', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)

    expectOk(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))
    // A different account presenting the spent token gets nothing.
    const second = await t.withIdentity(person('interloper')).mutation(api.invitations.accept, { token })
    expect(codeOf(second)).toBe('NOT_FOUND')
    const role = expectOk(
      await t.withIdentity(person('interloper')).query(api.members.myRole, { projectId: seed.projectId }),
    )
    expect(role).toBeNull()
  })

  test('the same account may replay its own acceptance', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test', 'editor')
    const token = await tokenFor(t, record.invitationId)

    expectOk(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))
    const replay = expectOk(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))
    expect(replay.role).toBe('editor')
    const members = expectOk(
      await t.withIdentity(person('owner-account')).query(api.members.list, { projectId: seed.projectId }),
    )
    expect(members.filter((row) => row.subject === subjectOf('guest'))).toHaveLength(1)
  })

  test('a replay never restores a member who was removed', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test', 'editor')
    const token = await tokenFor(t, record.invitationId)
    expectOk(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))

    expectOk(
      await t
        .withIdentity(person('owner-account'))
        .mutation(api.members.remove, { projectId: seed.projectId, subject: subjectOf('guest') }),
    )
    const replay = await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token })
    expect(codeOf(replay)).toBe('NOT_FOUND')
  })

  test('a stale viewer invitation never demotes an existing editor', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { guest: 'editor' } })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test', 'viewer')
    const token = await tokenFor(t, record.invitationId)

    const accepted = expectOk(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))
    expect(accepted.role).toBe('editor')
  })

  test('an expired invitation is refused and marked expired', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)
    await t.run(async (ctx) => ctx.db.patch(record.invitationId as never, { expiresAt: Date.now() - 1 }))

    expect(codeOf(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))).toBe('NOT_FOUND')
    const status = await t.run(async (ctx) => ((await ctx.db.get(record.invitationId as never)) as Doc<'invitations'>).status)
    expect(status).toBe('expired')
  })

  test('a revoked invitation is refused', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)
    expectOk(
      await t
        .withIdentity(person('owner-account'))
        .mutation(api.invitations.revoke, { projectId: seed.projectId, invitationId: record.invitationId }),
    )
    expect(codeOf(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))).toBe('NOT_FOUND')
  })

  test('an unknown token is refused without confirming the project exists', async () => {
    const t = harness()
    await seedProject(t, { owner: 'owner-account' })
    const result = await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token: 'not-a-token' })
    expect(codeOf(result)).toBe('NOT_FOUND')
  })

  test('an invitation to a deleted project cannot be accepted', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)
    expectOk(await t.withIdentity(person('owner-account')).mutation(api.projects.remove, { projectId: seed.projectId }))
    expect(codeOf(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))).toBe('NOT_FOUND')
  })

  test('acceptance needs a signed-in identity', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)
    expect(codeOf(await t.mutation(api.invitations.accept, { token }))).toBe('UNAUTHENTICATED')
  })
})

describe('the invitation list', () => {
  test('only a member with member.invite may read it', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { helper: 'editor' } })
    await invite(t, seed, 'owner-account', 'guest@example.test')
    expect(codeOf(await t.withIdentity(person('helper')).query(api.invitations.list, { projectId: seed.projectId }))).toBe(
      'FORBIDDEN',
    )
    expect(
      codeOf(await t.withIdentity(person('stranger')).query(api.invitations.list, { projectId: seed.projectId })),
    ).toBe('NOT_FOUND')
    expect(
      expectOk(await t.withIdentity(person('owner-account')).query(api.invitations.list, { projectId: seed.projectId })),
    ).toHaveLength(1)
  })
})

describe('binding an invitation to the address it was sent to', () => {
  /**
   * Acceptance is by token, and `invitations.ts` explains why: every other
   * decision in this deployment is keyed on the Hexclave user id, and putting an
   * email in the authorisation path would make it the exception.
   *
   * That reasoning holds for what authorises acceptance. It does not extend to
   * ignoring a *contradiction*. When the token carries a verified address and it
   * is not the address invited, the two facts disagree, and the safe reading of
   * a disagreement is that the link was forwarded. The guard therefore fires
   * only on positive evidence of a mismatch — an unverified or absent claim
   * still accepts, exactly as before.
   */
  const withEmail = (id: string, email: string, verified = true) => ({
    ...person(id),
    email,
    emailVerified: verified,
  })

  test('an invitee whose verified address matches is admitted', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test', 'editor')
    const token = await tokenFor(t, record.invitationId)

    const accepted = expectOk(
      await t.withIdentity(withEmail('guest', 'Guest@Example.test')).mutation(api.invitations.accept, { token }),
    )
    expect(accepted.role).toBe('editor')
  })

  test('a forwarded invitation is refused when the recipient’s address is verified and different', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)

    const result = await t
      .withIdentity(withEmail('colleague', 'somebody.else@example.test'))
      .mutation(api.invitations.accept, { token })
    expect(codeOf(result)).toBe('FORBIDDEN')

    // Refused, and not consumed: the intended recipient can still accept.
    const role = expectOk(
      await t.withIdentity(person('colleague')).query(api.members.myRole, { projectId: seed.projectId }),
    )
    expect(role).toBeNull()
    expect(
      expectOk(await t.withIdentity(withEmail('guest', 'guest@example.test')).mutation(api.invitations.accept, { token }))
        .role,
    ).toBe('viewer')
  })

  test('an unverified address is not evidence of anything, and does not block', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)

    const accepted = expectOk(
      await t
        .withIdentity(withEmail('guest', 'different@example.test', false))
        .mutation(api.invitations.accept, { token }),
    )
    expect(accepted.role).toBe('viewer')
  })

  test('a token carrying no address at all still accepts', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')
    const token = await tokenFor(t, record.invitationId)
    expect(codeOf(await t.withIdentity(person('guest')).mutation(api.invitations.accept, { token }))).toBe('ok')
  })

  test('the refusal never echoes either address back', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'private.address@example.test')
    const token = await tokenFor(t, record.invitationId)

    const result = await t
      .withIdentity(withEmail('colleague', 'my.address@example.test'))
      .mutation(api.invitations.accept, { token })
    const text = JSON.stringify(result)
    expect(text).not.toContain('private.address')
    expect(text).not.toContain('my.address')
  })
})

describe('how long an invitation lives', () => {
  test('expires within three days, not two weeks', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const record = await invite(t, seed, 'owner-account', 'guest@example.test')

    const row = await t.run(async (ctx) => (await ctx.db.get(record.invitationId as never)) as Doc<'invitations'>)
    const hours = (row.expiresAt - row.createdAt) / (60 * 60 * 1000)
    // A bearer credential sitting in an inbox. Fourteen days is a long time for
    // one; three is enough for somebody to get to their email.
    expect(hours).toBeLessThanOrEqual(72)
    expect(hours).toBeGreaterThan(24)
  })
})
