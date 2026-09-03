// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import { codeOf, document, expectOk, harness, person, seedProject, snapshotUpload, subjectOf, transaction } from './harness.setup'

/**
 * Project lifecycle and checkpoint integrity.
 *
 * `projects.create` is the claim path: it turns a browser's local document into
 * a cloud replica exactly once, and a dropped response must not produce a second
 * replica racing the first. `saveCheckpoint` is the durability path: the server
 * re-derives the checksum rather than trusting the client's, because a truncated
 * document stored with a matching digest is discovered far too late.
 */

const claim = (t: ReturnType<typeof harness>, as: string, args: Record<string, unknown>) =>
  t.withIdentity(person(as)).mutation(api.projects.create, {
    localProjectId: 'doc-1',
    name: 'My build',
    schemaVersion: 2,
    catalogVersion: 'fixture-1',
    ...args,
  })

describe('claiming a local project', () => {
  test('creates the project, its main branch and an owner membership', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner-account', {}))
    expect(created.name).toBe('My build')
    expect(created.role).toBe('owner')

    const role = expectOk(
      await t.withIdentity(person('owner-account')).query(api.members.myRole, { projectId: created.projectId }),
    )
    expect(role).toBe('owner')
    const branches = expectOk(
      await t.withIdentity(person('owner-account')).query(api.projects.branches, { projectId: created.projectId }),
    )
    expect(branches.map((branch) => branch.name)).toEqual(['main'])
  })

  test('claiming the same local document twice is refused', async () => {
    const t = harness()
    expectOk(await claim(t, 'owner-account', {}))
    const again = await claim(t, 'owner-account', {})
    expect(codeOf(again)).toBe('NAME_TAKEN')
  })

  test('two accounts may each claim their own copy of the same local id', async () => {
    const t = harness()
    expectOk(await claim(t, 'owner-account', {}))
    expect(codeOf(await claim(t, 'other-account', {}))).toBe('ok')
  })

  test('a dropped response can be resumed without creating a second replica', async () => {
    const t = harness()
    const snapshot = snapshotUpload({ localProjectId: 'doc-1' })
    const first = expectOk(await claim(t, 'owner-account', { snapshot }))
    const resumed = expectOk(await claim(t, 'owner-account', { snapshot, resumeExisting: true }))
    expect(resumed.projectId).toBe(first.projectId)

    const rows = await t.run(async (ctx) => ctx.db.query('projects').collect())
    expect(rows).toHaveLength(1)
  })

  test('resuming with a different document is refused rather than overwriting', async () => {
    const t = harness()
    expectOk(await claim(t, 'owner-account', { snapshot: snapshotUpload({ localProjectId: 'doc-1' }) }))
    const different = await claim(t, 'owner-account', {
      snapshot: snapshotUpload({ localProjectId: 'doc-1', name: 'A different document' }),
      resumeExisting: true,
    })
    expect(codeOf(different)).toBe('NAME_TAKEN')
  })

  test('an unsupported schema is refused', async () => {
    const t = harness()
    expect(codeOf(await claim(t, 'owner-account', { schemaVersion: 1 }))).toBe('SCHEMA_MISMATCH')
  })

  test('a blank name is refused', async () => {
    const t = harness()
    expect(codeOf(await claim(t, 'owner-account', { name: '   ' }))).toBe('INVALID_ARGUMENT')
  })

  test('claiming needs a signed-in identity', async () => {
    const t = harness()
    expect(
      codeOf(
        await t.mutation(api.projects.create, {
          localProjectId: 'doc-1',
          name: 'My build',
          schemaVersion: 2,
          catalogVersion: 'fixture-1',
        }),
      ),
    ).toBe('UNAUTHENTICATED')
  })
})

describe('the project list', () => {
  test('shows a caller their own and shared projects, and nobody else’s', async () => {
    const t = harness()
    await seedProject(t, { owner: 'owner-account', members: { colleague: 'editor' } })
    await seedProject(t, { owner: 'stranger-account' })

    const mine = expectOk(await t.withIdentity(person('colleague')).query(api.projects.list, {}))
    expect(mine).toHaveLength(1)
    const theirs = expectOk(await t.withIdentity(person('stranger-account')).query(api.projects.list, {}))
    expect(theirs).toHaveLength(1)
    expect(mine[0].projectId).not.toBe(theirs[0].projectId)
  })

  test('a public project a caller is not a member of does not appear in their list', async () => {
    const t = harness()
    await seedProject(t, { owner: 'owner-account', visibility: 'public' })
    expect(expectOk(await t.withIdentity(person('stranger')).query(api.projects.list, {}))).toHaveLength(0)
  })

  test('a deleted project leaves the list but keeps its history', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    expectOk(await t.withIdentity(person('owner-account')).mutation(api.projects.remove, { projectId: seed.projectId }))
    expect(expectOk(await t.withIdentity(person('owner-account')).query(api.projects.list, {}))).toHaveLength(0)
    // Soft delete: history is never destroyed by a click in a project list.
    expect(await t.run(async (ctx) => ctx.db.query('projects').collect())).toHaveLength(1)
  })
})

describe('checkpoints', () => {
  test('a checkpoint round-trips through chunked storage', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner-account', {}))
    const saved = expectOk(
      await t
        .withIdentity(person('owner-account'))
        .mutation(api.projects.saveCheckpoint, { projectId: created.projectId, snapshot: snapshotUpload({ localProjectId: 'doc-1' }) }),
    )
    expect(saved.revision).toBe(0)

    const latest = expectOk(
      await t.withIdentity(person('owner-account')).query(api.projects.latestCheckpoint, { projectId: created.projectId }),
    )
    expect(latest).not.toBeNull()
    expect(latest!.document).toMatchObject({ id: 'doc-1', schemaVersion: 2, revision: 0 })
  })

  test('a multi-chunk checkpoint reassembles to the same document', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner-account', {}))
    const upload = snapshotUpload({ localProjectId: 'doc-1', chunks: 5 })
    expect(upload.chunks.length).toBeGreaterThan(1)
    expectOk(
      await t
        .withIdentity(person('owner-account'))
        .mutation(api.projects.saveCheckpoint, { projectId: created.projectId, snapshot: upload }),
    )
    const latest = expectOk(
      await t.withIdentity(person('owner-account')).query(api.projects.latestCheckpoint, { projectId: created.projectId }),
    )
    expect(latest!.document).toEqual(document({ localProjectId: 'doc-1' }))
  })

  test('a checksum the server does not agree with is refused', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner-account', {}))
    const tampered = { ...snapshotUpload({ localProjectId: 'doc-1' }), checksum: '0'.repeat(32) }
    const result = await t
      .withIdentity(person('owner-account'))
      .mutation(api.projects.saveCheckpoint, { projectId: created.projectId, snapshot: tampered })
    expect(result.ok).toBe(false)
    expect(await t.run(async (ctx) => ctx.db.query('snapshots').collect())).toHaveLength(0)
  })

  test('a truncated chunk list is refused rather than stored', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner-account', {}))
    const upload = snapshotUpload({ localProjectId: 'doc-1', chunks: 4 })
    const truncated = { ...upload, chunks: upload.chunks.slice(0, 2) }
    const result = await t
      .withIdentity(person('owner-account'))
      .mutation(api.projects.saveCheckpoint, { projectId: created.projectId, snapshot: truncated })
    expect(result.ok).toBe(false)
    expect(await t.run(async (ctx) => ctx.db.query('snapshots').collect())).toHaveLength(0)
  })

  test('a checkpoint cannot precede the transactions that establish its revision', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner-account', {}))
    const ahead = snapshotUpload({ localProjectId: 'doc-1', revision: 3 })
    const result = await t
      .withIdentity(person('owner-account'))
      .mutation(api.projects.saveCheckpoint, { projectId: created.projectId, snapshot: ahead })
    expect(codeOf(result)).toBe('STALE_DOCUMENT')
  })

  test('a checkpoint at the current head is accepted', async () => {
    const t = harness()
    const created = expectOk(await claim(t, 'owner-account', {}))
    const branches = expectOk(
      await t.withIdentity(person('owner-account')).query(api.projects.branches, { projectId: created.projectId }),
    )
    expectOk(
      await t.withIdentity(person('owner-account')).mutation(api.transactions.append, {
        projectId: created.projectId,
        branchId: branches[0].branchId,
        ...transaction({ id: 'tx-1' }),
      }),
    )
    const result = await t
      .withIdentity(person('owner-account'))
      .mutation(api.projects.saveCheckpoint, {
        projectId: created.projectId,
        snapshot: snapshotUpload({ localProjectId: 'doc-1', revision: 1 }),
      })
    expect(codeOf(result)).toBe('ok')
  })
})

describe('visibility and renaming', () => {
  test('an owner may publish and unpublish', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    expectOk(
      await t
        .withIdentity(person('owner-account'))
        .mutation(api.projects.setVisibility, { projectId: seed.projectId, visibility: 'public' }),
    )
    expect(codeOf(await t.withIdentity(person('stranger')).query(api.projects.get, { projectId: seed.projectId }))).toBe('ok')

    expectOk(
      await t
        .withIdentity(person('owner-account'))
        .mutation(api.projects.setVisibility, { projectId: seed.projectId, visibility: 'private' }),
    )
    expect(codeOf(await t.withIdentity(person('stranger')).query(api.projects.get, { projectId: seed.projectId }))).toBe(
      'NOT_FOUND',
    )
  })

  test('an editor may rename but may not publish', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { colleague: 'editor' } })
    expectOk(
      await t
        .withIdentity(person('colleague'))
        .mutation(api.projects.rename, { projectId: seed.projectId, name: 'Renamed by editor' }),
    )
    expect(
      codeOf(
        await t
          .withIdentity(person('colleague'))
          .mutation(api.projects.setVisibility, { projectId: seed.projectId, visibility: 'public' }),
      ),
    ).toBe('FORBIDDEN')
  })
})

describe('membership changes', () => {
  test('the owner’s role cannot be changed and the owner cannot be removed', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { colleague: 'editor' } })
    const owner = t.withIdentity(person('owner-account'))
    expect(
      codeOf(
        await owner.mutation(api.members.setRole, {
          projectId: seed.projectId,
          subject: subjectOf('owner-account'),
          role: 'viewer',
        }),
      ),
    ).toBe('FORBIDDEN')
    expect(
      codeOf(await owner.mutation(api.members.remove, { projectId: seed.projectId, subject: subjectOf('owner-account') })),
    ).toBe('FORBIDDEN')
  })

  test('a collaborator may always leave without an owner’s consent', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { colleague: 'viewer' } })
    // `viewer` does not hold `member.remove`; leaving is authorised as a read.
    const left = expectOk(
      await t
        .withIdentity(person('colleague'))
        .mutation(api.members.remove, { projectId: seed.projectId, subject: subjectOf('colleague') }),
    )
    expect(left.removed).toBe(true)
    expect(
      codeOf(await t.withIdentity(person('colleague')).query(api.projects.get, { projectId: seed.projectId })),
    ).toBe('NOT_FOUND')
  })

  test('removing a member clears their live presence immediately', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', members: { colleague: 'editor' } })
    expectOk(
      await t
        .withIdentity(person('colleague'))
        .mutation(api.presence.heartbeat, { projectId: seed.projectId, sessionId: 's1', revision: 0, selection: [] }),
    )
    expect(await t.run(async (ctx) => ctx.db.query('presence').collect())).toHaveLength(1)

    expectOk(
      await t
        .withIdentity(person('owner-account'))
        .mutation(api.members.remove, { projectId: seed.projectId, subject: subjectOf('colleague') }),
    )
    expect(await t.run(async (ctx) => ctx.db.query('presence').collect())).toHaveLength(0)
  })
})
