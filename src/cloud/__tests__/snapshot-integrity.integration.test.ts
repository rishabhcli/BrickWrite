// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'
import schema from '../../../convex/schema'
import { ConvexCloudBackend } from '../convexClient'
import { snapshotUploadFor, checksumOfText, utf8Bytes } from '../serialize'
import type { CloudResult, CreateProjectArgs, SnapshotUpload } from '../protocol'
import { cloudFailure } from '../protocol'
import { blankProject, placements } from './harness'
import { CloudProjectStore, LocalProjectStore, MirroredProjectStore } from '../projectStore'
import { MemoryDriver } from '../../cad/persistence'
import { Outbox } from '../outbox'
import { transactionChecksum, canonicalJson } from '../serialize'
import { refs } from '../functionRefs'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

function setup() {
  const deployment = convexTest(schema, modules)
  const t = deployment.withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const backend = new ConvexCloudBackend(t as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const base = blankProject('snapshot-integrity')
  const args: CreateProjectArgs = {
    localProjectId: base.id,
    name: base.name,
    schemaVersion: base.schemaVersion,
    catalogVersion: base.catalogVersion,
    snapshot: snapshotUploadFor(base),
  }
  const counts = () =>
    t.run(async (ctx) => ({
      projects: (await ctx.db.query('projects').collect()).length,
      branches: (await ctx.db.query('branches').collect()).length,
      members: (await ctx.db.query('members').collect()).length,
      snapshots: (await ctx.db.query('snapshots').collect()).length,
      versions: (await ctx.db.query('versions').collect()).length,
      audits: (await ctx.db.query('auditEvents').collect()).length,
      transactions: (await ctx.db.query('transactions').collect()).length,
    }))
  const append = (transaction: ReturnType<typeof placements>['transactions'][number], projectId: string) =>
    backend.appendTransaction({
      projectId,
      clientTransactionId: transaction.id,
      baseRevision: transaction.baseRevision,
      resultRevision: transaction.resultRevision,
      transaction,
      checksum: transactionChecksum(transaction),
      schemaVersion: base.schemaVersion,
      catalogVersion: base.catalogVersion,
    })
  const driver = new MemoryDriver()
  const local = new LocalProjectStore(driver)
  const cloud = new CloudProjectStore(backend)
  const outbox = new Outbox(driver, backend)
  const store = new MirroredProjectStore(local, cloud, outbox, backend)
  return { deployment, t, backend, base, args, counts, append, local, cloud, store }
}

function withText(upload: SnapshotUpload, text: string): SnapshotUpload {
  return { ...upload, chunks: [text], bytes: utf8Bytes(text), checksum: checksumOfText(text) }
}

describe('cloud snapshot integrity (real Convex functions)', () => {
  it('leaves no project, owner, branch, snapshot or audit after a refused seed', async () => {
    const h = setup()
    const before = await h.counts()
    expect(
      await h.backend.createProject({ ...h.args, snapshot: { ...h.args.snapshot!, checksum: 'bad' } }),
    ).toMatchObject({ ok: false, error: { code: 'CHECKSUM_MISMATCH' } })
    expect(await h.counts()).toEqual(before)
    expect((await h.backend.createProject(h.args)).ok).toBe(true)
  })

  it('refuses checksum-valid non-document JSON without creating an unopenable replica', async () => {
    const h = setup()
    expect(await h.backend.createProject({ ...h.args, snapshot: withText(h.args.snapshot!, '{}') })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
    expect((await h.counts()).projects).toBe(0)
  })

  it('refuses checkpoints beyond the branch head instead of storing fictitious history', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    const before = await h.counts()
    expect(
      await h.backend.saveCheckpoint({
        projectId: project.projectId,
        snapshot: snapshotUploadFor({ ...h.base, revision: 99 }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'STALE_DOCUMENT' } })
    expect(await h.counts()).toEqual(before)
  })

  it('refuses another document under this project even when its schema and revision match', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    const before = await h.counts()
    expect(
      await h.backend.createVersion({
        projectId: project.projectId,
        label: 'Wrong model',
        snapshot: snapshotUploadFor({ ...h.base, id: 'another-document' }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(await h.counts()).toEqual(before)
  })

  it.each(['not json', 'null', '[]', '"a model"'])(
    'rejects malformed seed %s before creating any rows',
    async (text) => {
      const h = setup()
      const before = await h.counts()
      expect(await h.backend.createProject({ ...h.args, snapshot: withText(h.args.snapshot!, text) })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_ARGUMENT' },
      })
      expect(await h.counts()).toEqual(before)
    },
  )

  it.each([
    { revision: -1 },
    { revision: 0.5 },
    { bytes: -1 },
    { bytes: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid numeric envelope %j without writes', async (changes) => {
    const h = setup()
    const before = await h.counts()
    expect(await h.backend.createProject({ ...h.args, snapshot: { ...h.args.snapshot!, ...changes } })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
    expect(await h.counts()).toEqual(before)
  })

  it.each([{ revision: 1 }, { catalogVersion: 'incorrect' }])(
    'rejects a seed whose envelope disagrees with its payload: %j',
    async (changes) => {
      const h = setup()
      expect(await h.backend.createProject({ ...h.args, snapshot: { ...h.args.snapshot!, ...changes } })).toMatchObject(
        { ok: false, error: { code: 'INVALID_ARGUMENT' } },
      )
      expect((await h.counts()).projects).toBe(0)
    },
  )

  it('keeps schema failures typed, including project creation without a seed', async () => {
    const h = setup()
    expect(await h.backend.createProject({ ...h.args, schemaVersion: 3, snapshot: undefined })).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_MISMATCH' },
    })
    const project = value(await h.backend.createProject(h.args))
    const before = await h.counts()
    expect(
      await h.backend.createVersion({
        projectId: project.projectId,
        label: 'Bad schema',
        snapshot: { ...h.args.snapshot!, schemaVersion: 3 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'SCHEMA_MISMATCH' } })
    expect(await h.counts()).toEqual(before)
  })

  it('does not consume a version label or write an audit on a refused snapshot', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    const before = await h.counts()
    const args = { projectId: project.projectId, label: 'Working model', snapshot: h.args.snapshot! }
    expect(await h.backend.createVersion({ ...args, snapshot: withText(args.snapshot, '{}') })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
    expect(await h.counts()).toEqual(before)
    const version = value(await h.backend.createVersion(args))
    expect(
      value(await h.backend.versionDocument({ projectId: project.projectId, versionId: version.versionId })).document,
    ).toEqual(h.base)
  })

  it('allows offline versions ahead of the log without advancing the branch', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    const history = placements(h.base, ['unsynced'])
    const version = value(
      await h.backend.createVersion({
        projectId: project.projectId,
        label: 'Offline draft',
        snapshot: snapshotUploadFor(history.final),
      }),
    )
    expect(
      value(await h.backend.versionDocument({ projectId: project.projectId, versionId: version.versionId })).document,
    ).toEqual(history.final)
    expect(value(await h.backend.getProject({ projectId: project.projectId })).headRevision).toBe(0)
  })

  it('allows a delayed older checkpoint and newer catalogue, without hiding the latest revision', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    const history = placements(h.base, ['one', 'two'])
    for (const txn of history.transactions) value(await h.append(txn, project.projectId))
    const latest = { ...history.final, catalogVersion: 'next-catalogue' }
    value(await h.backend.saveCheckpoint({ projectId: project.projectId, snapshot: snapshotUploadFor(latest) }))
    value(
      await h.backend.saveCheckpoint({
        projectId: project.projectId,
        snapshot: snapshotUploadFor(history.documents[0]),
      }),
    )
    expect(value(await h.backend.latestCheckpoint({ projectId: project.projectId }))?.document).toEqual(latest)
  })

  it('round-trips multi-chunk Unicode and extension fields without normalization', async () => {
    const h = setup()
    const document = {
      ...h.base,
      name: '🧱漢'.repeat(90_000),
      extension: { label: 'agent/human draft', nested: [1, null, true] },
    }
    const snapshot = snapshotUploadFor(document)
    expect(snapshot.chunks.length).toBeGreaterThan(1)
    const project = value(await h.backend.createProject({ ...h.args, snapshot }))
    const saved = value(await h.backend.latestCheckpoint({ projectId: project.projectId }))!
    expect(canonicalJson(saved.document)).toBe(canonicalJson(document))
    expect(saved.checksum).toBe(snapshot.checksum)
  })

  it('rejects stored, checksum-valid corruption on read and before branch creation', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    await h.t.run(async (ctx) => {
      const row = (await ctx.db.query('snapshots').first())!
      const text = JSON.stringify({ ...h.base, parts: [] })
      await ctx.db.patch(row._id, { data: text, bytes: utf8Bytes(text), checksum: checksumOfText(text) })
    })
    const before = await h.counts()
    expect(await h.backend.latestCheckpoint({ projectId: project.projectId })).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_SNAPSHOT' },
    })
    expect(await h.backend.createBranch({ projectId: project.projectId, name: 'Must not exist' })).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_SNAPSHOT' },
    })
    expect(await h.counts()).toEqual(before)
  })

  it('rejects corrupt chunk counts before using them as a query limit', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    await h.t.run(async (ctx) => {
      await ctx.db.patch((await ctx.db.query('snapshots').first())!._id, { chunkCount: 1_000_000 })
    })
    expect(await h.backend.latestCheckpoint({ projectId: project.projectId })).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_SNAPSHOT' },
    })
  })

  it('checks identity and membership before disclosing validation details', async () => {
    const h = setup()
    expect(await h.deployment.mutation(refs.projects.create, h.args)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    })
    const project = value(await h.backend.createProject(h.args))
    const before = await h.counts()
    const args = { projectId: project.projectId, snapshot: withText(h.args.snapshot!, '{}') }
    expect(
      await h.deployment.withIdentity({ subject: 'bob' }).mutation(refs.projects.saveCheckpoint, args),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await h.counts()).toEqual(before)
  })
})

describe('safe claim retries (real Convex functions and local store)', () => {
  it('reuses the exact original seed only when explicitly requested', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    const before = await h.counts()
    expect(await h.backend.createProject(h.args)).toMatchObject({ ok: false, error: { code: 'NAME_TAKEN' } })
    expect(value(await h.backend.createProject({ ...h.args, resumeExisting: true })).projectId).toBe(project.projectId)
    expect(await h.counts()).toEqual(before)
  })

  it('never resets the head, name or visibility when resuming an existing creation', async () => {
    const h = setup()
    const project = value(await h.backend.createProject(h.args))
    const history = placements(h.base, ['remote'])
    value(await h.append(history.transactions[0], project.projectId))
    value(await h.backend.renameProject({ projectId: project.projectId, name: 'Renamed since creation' }))
    value(await h.backend.setVisibility({ projectId: project.projectId, visibility: 'unlisted' }))
    value(await h.backend.saveCheckpoint({ projectId: project.projectId, snapshot: snapshotUploadFor(history.final) }))
    const before = await h.counts()
    expect(value(await h.backend.createProject({ ...h.args, resumeExisting: true }))).toMatchObject({
      projectId: project.projectId,
      name: 'Renamed since creation',
      visibility: 'unlisted',
      headRevision: 1,
    })
    expect(await h.counts()).toEqual(before)
    expect(value(await h.backend.latestCheckpoint({ projectId: project.projectId }))?.document).toEqual(history.final)
  })

  it.each(['seed', 'name', 'visibility', 'legacy'])(
    'refuses ambiguous retries with changed %s instead of overwriting a project',
    async (change) => {
      const h = setup()
      value(await h.backend.createProject(h.args))
      if (change === 'legacy')
        await h.t.run(async (ctx) => {
          await ctx.db.patch((await ctx.db.query('projects').first())!._id, { creation: undefined })
        })
      const before = await h.counts()
      const retry: CreateProjectArgs = { ...h.args, resumeExisting: true }
      if (change === 'seed') retry.snapshot = snapshotUploadFor({ ...h.base, name: 'Different model' })
      if (change === 'name') retry.name = 'Different name'
      if (change === 'visibility') retry.visibility = 'public'
      expect(await h.backend.createProject(retry)).toMatchObject({ ok: false, error: { code: 'NAME_TAKEN' } })
      expect(await h.counts()).toEqual(before)
    },
  )

  it('scopes retry receipts to the authenticated owner', async () => {
    const h = setup()
    const alice = value(await h.backend.createProject(h.args))
    const bob = value(
      await h.deployment
        .withIdentity({ subject: 'bob', tokenIdentifier: 'hexclave|bob' })
        .mutation(refs.projects.create, { ...h.args, resumeExisting: true }),
    )
    expect(bob.projectId).not.toBe(alice.projectId)
    expect(bob.ownerSubject).toBe('hexclave|bob')
    expect((await h.counts()).projects).toBe(2)
  })

  it('recovers a committed create whose response was lost without another cloud project', async () => {
    const h = setup()
    await h.local.saveCheckpoint(h.base)
    const create = h.backend.createProject.bind(h.backend)
    vi.spyOn(h.backend, 'createProject').mockImplementationOnce(async (args) => {
      value(await create(args))
      return cloudFailure('TRANSPORT_FAILED', 'Response lost after commit.', 'Retry.')
    })
    expect(await h.store.claim(h.base.id)).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
    expect(await h.store.links.get(h.base.id)).toBeUndefined()
    const before = await h.counts()
    const recovered = value(await h.store.claim(h.base.id))
    expect(recovered.headRevision).toBe(0)
    expect(await h.counts()).toEqual(before)
    expect((await h.store.links.get(h.base.id))?.cloudProjectId).toBe(recovered.projectId)
  })

  it.each(['before', 'after'])(
    'resumes a legacy scalar log upload when failure occurs %s commit, without duplicate revisions',
    async (failure) => {
      const h = setup()
      // A host without the additive batch API must retain safe scalar recovery.
      Object.defineProperty(h.backend, 'appendTransactions', { value: undefined })
      const history = placements(h.base, ['first', 'second', 'third'])
      await h.local.saveCheckpoint(h.base)
      for (const txn of history.transactions) value(await h.local.appendTransaction(h.base.id, txn))
      const append = h.backend.appendTransaction.bind(h.backend)
      let interrupted = false
      vi.spyOn(h.backend, 'appendTransaction').mockImplementation(async (args) => {
        if (args.resultRevision === 2 && !interrupted) {
          interrupted = true
          if (failure === 'after') value(await append(args))
          return cloudFailure('TRANSPORT_FAILED', 'Upload interrupted.', 'Retry.')
        }
        return append(args)
      })
      expect(await h.store.claim(h.base.id)).toMatchObject({ ok: false, error: { code: 'TRANSPORT_FAILED' } })
      expect(await h.store.links.get(h.base.id)).toBeUndefined()
      const result = value(await h.store.claim(h.base.id))
      expect(result).toMatchObject({ headRevision: 3, transactionsUploaded: failure === 'after' ? 1 : 2 })
      expect(await h.counts()).toMatchObject({ projects: 1, branches: 1, members: 1, transactions: 3, audits: 4 })
      expect(value(await h.cloud.loadProject(result.projectId))?.document).toEqual(
        value(await h.local.loadProject(h.base.id))?.document,
      )
    },
  )

  it('does not link or claim success when a different writer advanced the cloud copy', async () => {
    const h = setup()
    await h.local.saveCheckpoint(h.base)
    const project = value(await h.backend.createProject(h.args))
    value(await h.append(placements(h.base, ['remote']).transactions[0], project.projectId))
    expect(await h.store.claim(h.base.id)).toMatchObject({ ok: false, error: { code: 'STALE_DOCUMENT' } })
    expect(await h.store.links.get(h.base.id)).toBeUndefined()
    expect(value(await h.local.loadProject(h.base.id))?.document).toEqual(h.base)
  })

  it('refuses a gapped local log before sending any project creation', async () => {
    const h = setup()
    const history = placements(h.base, ['one', 'two'])
    await h.local.saveCheckpoint(h.base)
    // Bypass the local append guard to reproduce an interrupted/corrupt disk write.
    await h.local.driver.put('transactions', `${h.base.id}:000000000002`, {
      key: `${h.base.id}:000000000002`,
      projectId: h.base.id,
      resultRevision: 2,
      transaction: history.transactions[1],
    })
    expect(await h.store.claim(h.base.id)).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_HISTORY' } })
    expect((await h.counts()).projects).toBe(0)
  })
})
