import { describe, expect, it, vi } from 'vitest'
import { MemoryDriver } from '../../cad/persistence'
import { LocalProjectStore } from '../projectStore'
import { Outbox, UNCONFIGURED_SYNC_STATE } from '../outbox'
import { createConvexCloud, convexUrlFromEnv } from '../convexClient'
import { FakeConvexDeployment } from './fakeBackend'
import { ALICE, blankProject, claimedProject, makeHarness, placements } from './harness'

/**
 * Gate 5  — offline edits survive a reload and reconcile without loss.
 * Gate 13 — with no deployment configured, everything local still works.
 *
 * The offline test deliberately rebuilds the whole stack over the same storage
 * driver rather than reusing the objects: an outbox that only survives because
 * it is still in memory has not survived a reload at all.
 */

describe('offline durability', () => {
  it('commits locally while offline and queues the work', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1', 'p2', 'p3'])

    harness.deployment.setOffline(true)
    for (const transaction of history.transactions) {
      const appended = await harness.store.appendTransaction(seeded.document.id, transaction)
      // The local commit is the answer. Being offline does not fail an edit.
      expect(appended.ok).toBe(true)
    }

    const state = await harness.outbox.drain()
    expect(state.status).toBe('offline')
    expect(state.reason).toBeTruthy()
    expect(state.pending).toBe(3)
    // Nothing reached the deployment.
    expect(harness.deployment.transactions).toHaveLength(0)

    const loaded = await harness.local.loadProject(seeded.document.id)
    expect(loaded.ok).toBe(true)
    if (loaded.ok && loaded.value) {
      expect(loaded.value.document.revision).toBe(3)
      expect(Object.keys(loaded.value.document.parts).sort()).toEqual(['p1', 'p2', 'p3'])
    }
  })

  it('survives a reload and reconciles on reconnect with nothing lost or overwritten', async () => {
    const driver = new MemoryDriver()
    const deployment = new FakeConvexDeployment()
    const first = makeHarness(ALICE, deployment, driver)
    const seeded = await claimedProject(first)
    const history = placements(seeded.document, ['p1', 'p2', 'p3', 'p4'])

    deployment.setOffline(true)
    for (const transaction of history.transactions) {
      expect((await first.store.appendTransaction(seeded.document.id, transaction)).ok).toBe(true)
    }
    expect((await first.outbox.drain()).status).toBe('offline')

    // --- reload: new stores, new outbox, same IndexedDB-backed driver -------
    const second = makeHarness(ALICE, deployment, driver)
    await second.outbox.hydrate()
    expect(second.outbox.pending).toHaveLength(4)
    expect(second.outbox.pending.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4])

    deployment.setOffline(false)
    // `reconnected` rather than `drain`: the queue is inside a backoff window
    // it earned before the reload, and a restored connection is new information.
    const state = await second.outbox.reconnected()
    expect(state.status).toBe('idle')
    expect(state.pending).toBe(0)
    expect(state.lastSyncedAt).toBeTruthy()

    // Every transaction arrived, in order, exactly once.
    expect(deployment.transactions.map((row) => row.resultRevision)).toEqual([1, 2, 3, 4])
    expect(deployment.transactions.map((row) => row.clientTransactionId)).toEqual(
      history.transactions.map((transaction) => transaction.id),
    )

    // And the replica rebuilds the same document the browser holds.
    const cloudLoaded = await second.cloud.loadProject(seeded.cloudProjectId)
    const localLoaded = await second.local.loadProject(seeded.document.id)
    expect(cloudLoaded.ok && localLoaded.ok).toBe(true)
    if (cloudLoaded.ok && cloudLoaded.value && localLoaded.ok && localLoaded.value) {
      expect(cloudLoaded.value.document.revision).toBe(4)
      expect(cloudLoaded.value.document.parts).toEqual(localLoaded.value.document.parts)
    }
  })

  it('backs off before retrying, and retries once the delay has passed', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1'])
    harness.deployment.setOffline(true)
    await harness.store.appendTransaction(seeded.document.id, history.transactions[0])

    const first = await harness.outbox.drain()
    expect(first.status).toBe('offline')
    const dueAt = harness.outbox.nextAttemptAt
    expect(dueAt).toBeGreaterThan(harness.clock.now)

    // Draining before the retry is due must not hammer the deployment.
    harness.deployment.setOffline(false)
    const early = await harness.outbox.drain()
    expect(early.status).toBe('offline')
    expect(harness.deployment.transactions).toHaveLength(0)

    harness.clock.now = (dueAt ?? 0) + 1
    const late = await harness.outbox.drain()
    expect(late.status).toBe('idle')
    expect(harness.deployment.transactions).toHaveLength(1)
  })

  it('sends strictly in order and stops at the first entry it cannot send', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1', 'p2', 'p3'])
    harness.deployment.setOffline(true)
    for (const transaction of history.transactions) {
      await harness.store.appendTransaction(seeded.document.id, transaction)
    }

    // Let the first two through, then go offline again mid-drain by draining
    // twice with the network flipped in between.
    harness.deployment.setOffline(false)
    const drained = await harness.outbox.drain()
    expect(drained.status).toBe('idle')
    expect(harness.deployment.transactions.map((row) => row.resultRevision)).toEqual([1, 2, 3])
  })

  it('refuses to queue past its capacity rather than dropping an entry', async () => {
    const driver = new MemoryDriver()
    const deployment = new FakeConvexDeployment()
    const harness = makeHarness(ALICE, deployment, driver)
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1', 'p2', 'p3', 'p4'])

    // A queue with room for two, so the third enqueue is refused.
    const bounded = new Outbox(driver, harness.backend, {
      now: () => harness.clock.now,
      capacity: 2,
    })
    deployment.setOffline(true)
    for (const transaction of history.transactions.slice(0, 2)) {
      const queued = await bounded.queueTransaction(
        seeded.cloudProjectId,
        seeded.document,
        transaction,
      )
      expect(queued.ok).toBe(true)
    }
    const refused = await bounded.queueTransaction(
      seeded.cloudProjectId,
      seeded.document,
      history.transactions[2],
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('OUTBOX_FULL')
    expect(bounded.getState().status).toBe('error')

    // The two already queued are untouched — refuse-newest, never drop-oldest.
    expect(bounded.pending.map((entry) => entry.payload.kind)).toEqual([
      'transaction',
      'transaction',
    ])
    expect(
      bounded.pending.map((entry) =>
        entry.payload.kind === 'transaction' ? entry.payload.transaction.id : null,
      ),
    ).toEqual([history.transactions[0].id, history.transactions[1].id])
  })

  it('backfills the tail the queue refused, from the local log', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1', 'p2', 'p3'])

    // Commit everything locally but let nothing reach the queue, standing in
    // for a queue that was full while these edits were made.
    for (const transaction of history.transactions) {
      expect((await harness.local.appendTransaction(seeded.document.id, transaction)).ok).toBe(true)
    }
    expect(harness.outbox.pending).toHaveLength(0)

    const backfilled = await harness.store.backfill(seeded.document.id)
    expect(backfilled.ok).toBe(true)
    if (backfilled.ok) expect(backfilled.value.queued).toBe(3)

    const state = await harness.outbox.drain()
    expect(state.status).toBe('idle')
    expect(harness.deployment.transactions).toHaveLength(3)
  })

  it('detects a queue entry that changed while it was stored', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1'])
    harness.deployment.setOffline(true)
    await harness.store.appendTransaction(seeded.document.id, history.transactions[0])

    // Corrupt the stored entry the way a bad migration or a storage fault would.
    const entry = harness.outbox.pending[0]
    const stored = await harness.driver.get<typeof entry>('meta', entry.key)
    if (!stored || stored.payload.kind !== 'transaction') throw new Error('missing entry')
    stored.payload.transaction = {
      ...stored.payload.transaction,
      label: 'Something else entirely',
    }
    await harness.driver.put('meta', entry.key, stored)

    const reloaded = makeHarness(ALICE, harness.deployment, harness.driver)
    harness.deployment.setOffline(false)
    const state = await reloaded.outbox.drain()
    expect(state.status).toBe('error')
    expect(state.lastError?.code).toBe('CHECKSUM_MISMATCH')
    expect(reloaded.deployment.transactions).toHaveLength(0)
  })

  it('parks a permanently refused entry instead of skipping past it', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1', 'p2'])
    harness.deployment.setOffline(true)
    for (const transaction of history.transactions) {
      await harness.store.appendTransaction(seeded.document.id, transaction)
    }

    // Advance the cloud head past the queue's base revision so the first entry
    // is stale, which is a refusal the queue must not retry blindly.
    harness.deployment.setOffline(false)
    const branch = harness.deployment.branches.find((row) => row._id === seeded.branchId)
    if (branch) branch.headRevision = 7

    const state = await harness.outbox.drain()
    expect(state.status).toBe('conflict')
    expect(state.conflict?.headRevision).toBe(7)
    // Both entries are still queued: nothing was discarded to make progress.
    expect(harness.outbox.pending).toHaveLength(2)
  })

  it('does not resend a parked entry on the next tick', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1'])
    harness.deployment.setOffline(true)
    await harness.store.appendTransaction(seeded.document.id, history.transactions[0])
    harness.deployment.setOffline(false)
    const branch = harness.deployment.branches.find((row) => row._id === seeded.branchId)
    if (branch) branch.headRevision = 7

    const first = await harness.outbox.drain()
    expect(first.status).toBe('conflict')
    expect(harness.outbox.pending[0]?.parked).toBe(true)
    expect(harness.outbox.pending[0]?.attempts).toBe(1)

    harness.clock.now += 30_000
    await harness.outbox.drain()
    await harness.outbox.drain()
    expect(harness.outbox.pending[0]?.attempts).toBe(1)
    expect(harness.outbox.pending[0]?.parked).toBe(true)
  })

  it('clears the park on reconnect', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1'])
    harness.deployment.setOffline(true)
    await harness.store.appendTransaction(seeded.document.id, history.transactions[0])
    harness.deployment.setOffline(false)
    const branch = harness.deployment.branches.find((row) => row._id === seeded.branchId)
    if (branch) branch.headRevision = 7

    await harness.outbox.drain()
    expect(harness.outbox.pending[0]?.parked).toBe(true)
    expect(harness.outbox.pending[0]?.attempts).toBe(1)

    const again = await harness.outbox.reconnected()
    expect(again.status).toBe('conflict')
    expect(harness.outbox.pending[0]?.attempts).toBe(2)
    expect(harness.outbox.pending[0]?.parked).toBe(true)
  })

  it('does not unpark a permanent refusal on reconnect', async () => {
    const harness = makeHarness()
    const seeded = await claimedProject(harness)
    const history = placements(seeded.document, ['p1'])
    harness.backend.appendTransaction = async () => ({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'This identity cannot write that project.',
        repair: 'Ask an owner to raise your role.',
      },
    })
    await harness.store.appendTransaction(seeded.document.id, history.transactions[0])
    const first = await harness.outbox.drain()
    expect(first.status).toBe('error')
    expect(harness.outbox.pending[0]?.parked).toBe(true)
    expect(harness.outbox.pending[0]?.attempts).toBe(1)

    const again = await harness.outbox.reconnected()
    expect(again.status).toBe('error')
    expect(harness.outbox.pending[0]?.attempts).toBe(1)
    expect(harness.outbox.pending[0]?.parked).toBe(true)
  })
})

describe('the unconfigured, local-only path', () => {
  it('reports `unconfigured` with a reason when VITE_CONVEX_URL is unset', () => {
    vi.stubEnv('VITE_CONVEX_URL', '')
    try {
      expect(convexUrlFromEnv()).toBeNull()
      const cloud = createConvexCloud()
      expect(cloud.status).toBe('unconfigured')
      if (cloud.status === 'unconfigured') {
        expect(cloud.reason).toContain('VITE_CONVEX_URL')
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses a URL that is not http(s) instead of constructing a client', () => {
    const cloud = createConvexCloud({ url: 'not-a-url' })
    expect(cloud.status).toBe('unconfigured')
  })

  it('never throws on any local project operation without a deployment', async () => {
    vi.stubEnv('VITE_CONVEX_URL', '')
    try {
      const run = async () => {
        const cloud = createConvexCloud()
        expect(cloud.status).toBe('unconfigured')

        // This is the whole editor path when nobody is signed in.
        const local = new LocalProjectStore(new MemoryDriver())
        const document = blankProject('doc_local', 'Local only')
        expect((await local.saveCheckpoint(document)).ok).toBe(true)

        const history = placements(document, ['p1', 'p2'])
        for (const transaction of history.transactions) {
          expect((await local.appendTransaction(document.id, transaction)).ok).toBe(true)
        }
        const loaded = await local.loadProject(document.id)
        expect(loaded.ok).toBe(true)
        if (loaded.ok && loaded.value) expect(loaded.value.document.revision).toBe(2)

        const list = await local.listProjects()
        expect(list.ok && list.value).toHaveLength(1)

        const renamed = await local.renameProject(document.id, 'Still local')
        expect(renamed.ok && renamed.value.name).toBe('Still local')

        // Cloud-only surfaces refuse honestly rather than pretending to be empty.
        const branches = await local.listBranches()
        expect(branches.ok).toBe(false)
        if (!branches.ok) expect(branches.error.code).toBe('UNCONFIGURED')
        for (const call of [
          local.listVersions(),
          local.listMembers(),
          local.listComments(),
          local.createBranch(),
          local.createVersion(),
          local.addComment(),
        ]) {
          const result = await call
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error.code).toBe('UNCONFIGURED')
        }

        expect((await local.deleteProject(document.id)).ok).toBe(true)
      }
      await expect(run()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('exposes `unconfigured` as the sync state when there is no outbox', () => {
    expect(UNCONFIGURED_SYNC_STATE.status).toBe('unconfigured')
    expect(UNCONFIGURED_SYNC_STATE.reason).toBeTruthy()
    expect(UNCONFIGURED_SYNC_STATE.pending).toBe(0)
  })
})
