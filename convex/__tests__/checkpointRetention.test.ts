// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { CHECKPOINT_RETENTION } from '../model/snapshots'
import { codeOf, expectOk, harness, person, snapshotUpload, type Harness } from './harness'

/**
 * Automatic checkpoints are bounded; named versions are not.
 *
 * A checkpoint is a whole document and autosave writes one periodically, so
 * keeping every one grew a branch's storage without bound while only the newest
 * is ever opened at head. What has to stay true after pruning: the branch still
 * opens, a named version still restores, and the receipts that make a retry
 * idempotent are still readable.
 */

const claim = (t: Harness, as: string) =>
  t.withIdentity(person(as)).mutation(api.projects.create, {
    localProjectId: 'doc-1',
    name: 'My build',
    schemaVersion: 2,
    catalogVersion: 'fixture-1',
  })

const upload = (revision: number) => snapshotUpload({ localProjectId: 'doc-1', revision })

/** Distinct checkpoint groups still stored. `t.run` may only return Convex types. */
const checkpointGroups = (t: Harness, projectId: string): Promise<number> =>
  t.run(async (ctx) => {
    const groups = new Set<string>()
    for (const row of await ctx.db
      .query('snapshots')
      .withIndex('by_project_kind_revision', (q) =>
        q.eq('projectId', projectId as Id<'projects'>).eq('kind', 'checkpoint'),
      )
      .collect()) {
      groups.add(row.groupId)
    }
    return groups.size
  })

const save = async (t: Harness, projectId: string, revision: number) => {
  // A checkpoint may not run ahead of the branch head, so advance the head to
  // meet it rather than saving every checkpoint at revision zero.
  await t.run(async (ctx) => {
    const project = await ctx.db.get(projectId as Id<'projects'>)
    if (project?.defaultBranchId) await ctx.db.patch(project.defaultBranchId, { headRevision: revision })
  })
  return t.withIdentity(person('owner')).mutation(api.projects.saveCheckpoint, {
    projectId,
    snapshot: upload(revision),
  })
}

describe('checkpoint retention', () => {
  test('keeps a bounded window of automatic checkpoints', async () => {
    const t = harness()
    const project = expectOk(await claim(t, 'owner'))
    for (let revision = 1; revision <= CHECKPOINT_RETENTION + 6; revision += 1) {
      expectOk(await save(t, project.projectId, revision))
    }
    await t.finishAllScheduledFunctions(() => {})

    expect(await checkpointGroups(t, project.projectId)).toBeLessThanOrEqual(CHECKPOINT_RETENTION + 1)
  })

  test('the branch still opens at head after pruning', async () => {
    const t = harness()
    const project = expectOk(await claim(t, 'owner'))
    for (let revision = 1; revision <= CHECKPOINT_RETENTION + 6; revision += 1) {
      expectOk(await save(t, project.projectId, revision))
    }
    await t.finishAllScheduledFunctions(() => {})

    const latest = expectOk(
      await t.withIdentity(person('owner')).query(api.projects.latestCheckpoint, { projectId: project.projectId }),
    )
    expect(latest?.revision).toBe(CHECKPOINT_RETENTION + 6)
  })

  test('never prunes a named version', async () => {
    const t = harness()
    const project = expectOk(await claim(t, 'owner'))
    expectOk(await save(t, project.projectId, 1))
    const version = expectOk(
      await t.withIdentity(person('owner')).mutation(api.versions.create, {
        projectId: project.projectId,
        label: 'milestone',
        snapshot: upload(1),
      }),
    )

    for (let revision = 2; revision <= CHECKPOINT_RETENTION + 8; revision += 1) {
      expectOk(await save(t, project.projectId, revision))
    }
    await t.finishAllScheduledFunctions(() => {})

    // A version is the durable point in history; pruning automatic checkpoints
    // around it must leave it restorable.
    const restored = expectOk(
      await t
        .withIdentity(person('owner'))
        .query(api.versions.document, { projectId: project.projectId, versionId: version.versionId }),
    )
    expect(restored.revision).toBe(1)
  })

  test('never prunes the creation receipt a retried claim reads', async () => {
    const t = harness()
    const claimed = expectOk(
      await t.withIdentity(person('owner')).mutation(api.projects.create, {
        localProjectId: 'doc-1',
        name: 'My build',
        schemaVersion: 2,
        catalogVersion: 'fixture-1',
        snapshot: upload(0),
      }),
    )
    for (let revision = 1; revision <= CHECKPOINT_RETENTION + 8; revision += 1) {
      expectOk(await save(t, claimed.projectId, revision))
    }
    await t.finishAllScheduledFunctions(() => {})

    // The seed group is pinned, so the idempotent-retry comparison still has
    // something to compare against rather than failing to read its own receipt.
    const retried = await t.withIdentity(person('owner')).mutation(api.projects.create, {
      localProjectId: 'doc-1',
      name: 'My build',
      schemaVersion: 2,
      catalogVersion: 'fixture-1',
      snapshot: upload(0),
      resumeExisting: true,
    })
    expect(codeOf(retried)).toBe('ok')
  })

  test('a pinned group does not occupy a retention slot forever', async () => {
    // The creation receipt sits at the head of the window. If it were left
    // there, every later prune would stop on it and nothing would be reclaimed.
    const t = harness()
    const claimed = expectOk(
      await t.withIdentity(person('owner')).mutation(api.projects.create, {
        localProjectId: 'doc-1',
        name: 'My build',
        schemaVersion: 2,
        catalogVersion: 'fixture-1',
        snapshot: upload(0),
      }),
    )
    for (let revision = 1; revision <= CHECKPOINT_RETENTION + 8; revision += 1) {
      expectOk(await save(t, claimed.projectId, revision))
    }
    await t.finishAllScheduledFunctions(() => {})

    // Retained window, plus the pinned seed that is kept for the receipt.
    expect(await checkpointGroups(t, claimed.projectId)).toBeLessThanOrEqual(CHECKPOINT_RETENTION + 2)
  })
})
