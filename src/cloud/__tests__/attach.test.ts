import { describe, expect, it } from 'vitest'
import { CadEngine } from '../../cad/engine'
import { MemoryDriver } from '../../cad/persistence'
import { ProjectAutosave, ProjectRepository } from '../../cad/persistence'
import { attachCloudSync, settled } from '../attach'
import { FakeConvexDeployment } from './fakeBackend'
import { ALICE, blankProject, part } from './harness'

/**
 * The integration seam, exercised the way the shell will use it.
 *
 * Drives a real `CadEngine` and a real `ProjectAutosave` over one storage
 * driver, with the cloud layer attached alongside, and checks the property the
 * whole design rests on: the cloud layer queues, and never writes, the local
 * log.
 */

async function editorWithCloud() {
  const driver = new MemoryDriver()
  const deployment = new FakeConvexDeployment()
  const backend = deployment.as(ALICE)
  const repository = new ProjectRepository(driver)
  const document = blankProject('doc_attached', 'Attached build')
  await repository.saveCheckpoint(document)

  const engine = new CadEngine(document)
  const autosave = new ProjectAutosave(repository)
  // This is the session's own listener, unchanged.
  const detachAutosave = engine.onCommit((transaction, next) => {
    void autosave.record(next, transaction)
  })

  const handle = attachCloudSync({
    driver,
    backend,
    onCommit: engine.onCommit,
    autoDrainMs: 0,
    checkpointInterval: 3,
  })
  return { driver, deployment, backend, engine, autosave, repository, handle, detachAutosave }
}

describe('attaching the cloud layer to a live editor', () => {
  it('queues nothing for a project that has not been claimed', async () => {
    const scene = await editorWithCloud()
    const commit = scene.engine.execute(
      'Place a brick',
      [{ type: 'part.add', part: part('p1') }],
      'human',
      0,
    )
    expect(commit.ok).toBe(true)
    await settled(scene.handle)
    await scene.autosave.settled()

    expect(scene.handle.outbox.pending).toHaveLength(0)
    expect(scene.handle.state().status).toBe('idle')
    // But the local log has it, because autosave is untouched.
    const loaded = await scene.repository.loadProject('doc_attached')
    expect(loaded?.document.revision).toBe(1)
    scene.handle.detach()
    scene.detachAutosave()
  })

  it('queues each commit once claimed, and never writes the local log itself', async () => {
    const scene = await editorWithCloud()
    const claimed = await scene.handle.claim('doc_attached')
    expect(claimed.ok).toBe(true)

    for (let index = 0; index < 4; index += 1) {
      const commit = scene.engine.execute(
        `Place ${index}`,
        [{ type: 'part.add', part: part(`p${index}`, [index * 100, 0, 0]) }],
        'human',
        index,
      )
      expect(commit.ok).toBe(true)
      await settled(scene.handle)
      await scene.autosave.settled()
    }

    // Four transactions plus one checkpoint at the third commit.
    const kinds = scene.handle.outbox.pending.map((entry) => entry.payload.kind)
    expect(kinds.filter((kind) => kind === 'transaction')).toHaveLength(4)
    expect(kinds.filter((kind) => kind === 'checkpoint')).toHaveLength(1)

    // Exactly one copy of each transaction in the local log: the cloud layer
    // queued them, it did not append them.
    const log = await scene.driver.range<{ transaction: { id: string } }>(
      'transactions',
      'doc_attached:',
    )
    const ids = log.map((entry) => entry.transaction.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(4)

    const drained = await scene.handle.outbox.drain()
    expect(drained.status).toBe('idle')
    expect(scene.deployment.transactions.map((row) => row.resultRevision)).toEqual([1, 2, 3, 4])
    scene.handle.detach()
    scene.detachAutosave()
  })

  it('stops queueing once detached', async () => {
    const scene = await editorWithCloud()
    expect((await scene.handle.claim('doc_attached')).ok).toBe(true)
    scene.handle.detach()

    scene.engine.execute('After detach', [{ type: 'part.add', part: part('p9', [400, 0, 0]) }], 'human', 0)
    await settled(scene.handle)
    expect(scene.handle.outbox.pending).toHaveLength(0)
    scene.detachAutosave()
  })
})
