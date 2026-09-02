// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { auditCategory } from '../model/audit'
import { expectOk, harness, person, snapshotUpload, transaction, type Harness } from './harness'

/**
 * What the audit trail actually records.
 *
 * `redactAuditDetail` keeps only numbers, booleans and identifier-shaped
 * strings, and names anything it drops in a `redacted` field. That rule is not
 * the problem — the callers were. Six events passed a branch name or a version
 * label straight through, so an entry about `main` carried its subject and an
 * entry about "roof experiment" carried `redacted: branch` instead. It survived
 * review because the default branch is the one most events are about.
 *
 * So the assertion is on the deployment as a whole rather than on any one
 * event: drive the mutations with names a person would actually type, and no
 * audit row may come back holding a `redacted` marker.
 */

/** Free-form on purpose: spaces are what the identifier rule rejects. */
const BRANCH_NAME = 'roof experiment #2'
const VERSION_LABEL = 'before the roof went on'

const auditRows = (t: Harness, projectId: Id<'projects'>): Promise<Doc<'auditEvents'>[]> =>
  t.run(async (ctx) =>
    ctx.db
      .query('auditEvents')
      .withIndex('by_project_at', (q) => q.eq('projectId', projectId))
      .collect(),
  )

const upload = (revision: number) => snapshotUpload({ localProjectId: 'doc-1', revision })

/**
 * Drives every mutation that writes an audit event, with free-form names
 * wherever one is accepted.
 */
async function exercise(t: Harness) {
  const project = expectOk(
    await t.withIdentity(person('owner')).mutation(api.projects.create, {
      localProjectId: 'doc-1',
      name: 'A build with a long name',
      schemaVersion: 2,
      catalogVersion: 'fixture-1',
      snapshot: upload(0),
    }),
  )
  const projectId = project.projectId

  expectOk(await t.withIdentity(person('owner')).mutation(api.projects.rename, { projectId, name: 'Renamed build' }))
  expectOk(
    await t.withIdentity(person('owner')).mutation(api.projects.setVisibility, { projectId, visibility: 'unlisted' }),
  )
  expectOk(
    await t.withIdentity(person('owner')).mutation(api.projects.saveCheckpoint, { projectId, snapshot: upload(0) }),
  )

  const version = expectOk(
    await t
      .withIdentity(person('owner'))
      .mutation(api.versions.create, { projectId, label: VERSION_LABEL, snapshot: upload(0) }),
  )
  const branch = expectOk(
    await t.withIdentity(person('owner')).mutation(api.versions.createBranch, { projectId, name: BRANCH_NAME }),
  )
  // The loudest audit writer there is, and it names a branch — so it has to be
  // exercised on the one whose name a person actually typed.
  expectOk(
    await t.withIdentity(person('owner')).mutation(api.transactions.appendBatch, {
      projectId,
      branchId: branch.branchId,
      transactions: [transaction({ id: 'txn-1' })],
    }),
  )

  expectOk(
    await t
      .withIdentity(person('owner'))
      .mutation(api.versions.proposeMerge, { projectId, branchId: branch.branchId, summary: 'Please take the roof.' }),
  )
  expectOk(
    await t
      .withIdentity(person('owner'))
      .mutation(api.versions.decideMerge, { projectId, branchId: branch.branchId, decision: 'rejected' }),
  )
  expectOk(
    await t.withIdentity(person('owner')).mutation(api.versions.remove, { projectId, versionId: version.versionId }),
  )
  expectOk(
    await t.withIdentity(person('owner')).mutation(api.versions.removeBranch, { projectId, branchId: branch.branchId }),
  )

  const comment = expectOk(
    await t.withIdentity(person('owner')).mutation(api.comments.add, {
      projectId,
      body: 'This slope reads as a mistake from the front.',
      anchor: { partId: 'part_0001', revision: 0, poseChecksum: 'abc' },
    }),
  )
  expectOk(
    await t
      .withIdentity(person('owner'))
      .mutation(api.comments.setStatus, { projectId, commentId: comment.commentId, status: 'resolved' }),
  )
  expectOk(
    await t.withIdentity(person('owner')).mutation(api.comments.remove, { projectId, commentId: comment.commentId }),
  )

  const invitation = expectOk(
    await t
      .withIdentity(person('owner'))
      .mutation(api.invitations.create, { projectId, email: 'builder@example.test', role: 'editor' }),
  )
  expectOk(
    await t
      .withIdentity(person('owner'))
      .mutation(api.invitations.revoke, { projectId, invitationId: invitation.invitationId }),
  )

  return projectId as Id<'projects'>
}

describe('the audit trail', () => {
  test('writes nothing its own filter rejects', async () => {
    const t = harness()
    const projectId = await exercise(t)
    const rows = await auditRows(t, projectId)

    expect(rows.length).toBeGreaterThan(8)
    const lossy = rows.filter((row) => 'redacted' in row.detail).map((row) => `${row.action}: ${row.detail.redacted}`)
    expect(lossy).toEqual([])
  })

  test('records a branch and a version by id, so a deleted one is still traceable', async () => {
    // The reason an id rather than a name: the entries worth reading are about
    // things that are gone, and a name that survived redaction would not
    // correlate the create with the delete.
    const t = harness()
    const projectId = await exercise(t)
    const rows = await auditRows(t, projectId)

    const created = rows.find((row) => row.action === 'branch.create')
    const deleted = rows.find((row) => row.action === 'branch.delete')
    expect(created?.detail.branchId).toBeTruthy()
    expect(deleted?.detail.branchId).toBe(created?.detail.branchId)
    // The name is not stored, but its shape is, which is what `project.rename`
    // has always recorded.
    expect(created?.detail.nameLength).toBe(BRANCH_NAME.length)
    expect(rows.find((row) => row.action === 'version.delete')?.detail.labelLength).toBe(VERSION_LABEL.length)
  })

  test('never stores an invited address', async () => {
    const t = harness()
    const projectId = await exercise(t)
    const rows = await auditRows(t, projectId)
    expect(JSON.stringify(rows)).not.toContain('builder@example.test')
  })

  test('splits every action into content or control', async () => {
    const t = harness()
    const projectId = await exercise(t)
    for (const row of await auditRows(t, projectId)) {
      expect(row.category).toBe(auditCategory(row.action))
    }
  })
})
