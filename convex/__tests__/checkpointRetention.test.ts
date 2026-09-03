// @vitest-environment edge-runtime
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { CHECKPOINT_PRUNE_CHUNKS, CHECKPOINT_RETENTION } from '../model/snapshots'
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

const upload = (revision: number, chunks = 1) =>
  snapshotUpload({ localProjectId: 'doc-1', revision, chunks })

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

const save = async (t: Harness, projectId: string, revision: number, chunks = 1) => {
  // A checkpoint may not run ahead of the branch head, so advance the head to
  // meet it rather than saving every checkpoint at revision zero.
  await t.run(async (ctx) => {
    const project = await ctx.db.get(projectId as Id<'projects'>)
    if (project?.defaultBranchId) await ctx.db.patch(project.defaultBranchId, { headRevision: revision })
  })
  return t.withIdentity(person('owner')).mutation(api.projects.saveCheckpoint, {
    projectId,
    snapshot: upload(revision, chunks),
  })
}

/** Every stored chunk of every automatic checkpoint, pruned or not. */
const checkpointChunks = (t: Harness, projectId: string): Promise<number> =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('snapshots')
        .withIndex('by_project_kind_revision', (q) =>
          q.eq('projectId', projectId as Id<'projects'>).eq('kind', 'checkpoint'),
        )
        .collect()
    ).length,
  )

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

  test('prunes a checkpoint that needs more than one pass, to the last chunk', async () => {
    // `CHECKPOINT_PRUNE_CHUNKS` rows go per pass. Every other fixture here is
    // one chunk, so every prune finished in a single pass and the bug this
    // covers was invisible: the group id used to leave the branch's window on
    // that first pass, and the reschedule then re-read a window it was no
    // longer in, abandoning every remaining chunk with nothing able to reach
    // or reclaim it.
    const chunks = CHECKPOINT_PRUNE_CHUNKS * 2 + 3
    const t = harness()
    const project = expectOk(await claim(t, 'owner'))
    for (let revision = 1; revision <= CHECKPOINT_RETENTION + 2; revision += 1) {
      expectOk(await save(t, project.projectId, revision, chunks))
    }
    await t.finishAllScheduledFunctions(() => {})

    const groups = await checkpointGroups(t, project.projectId)
    expect(groups).toBeLessThanOrEqual(CHECKPOINT_RETENTION + 1)
    // No partly-deleted group survives: chunks must equal whole groups.
    expect(await checkpointChunks(t, project.projectId)).toBe(groups * chunks)
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
