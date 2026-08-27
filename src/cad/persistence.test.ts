import { describe, expect, it } from 'vitest'
import { CadEngine } from './engine'
import { IDENTITY_BASIS } from './math'
import { MemoryDriver, ProjectAutosave, ProjectRepository } from './persistence'
import { captureModule } from './modules'
import { createEmptyDocument } from './sample'
import type { ModelDocument, PartInstance, Transaction } from './types'

const part = (id: string, position: [number, number, number] = [0, 0, 0]): PartInstance => ({
  id,
  definitionId: '3001',
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/** Drives the real engine so the log under test is the log the app writes. */
function build(edits: number): {
  engine: CadEngine
  transactions: Transaction[]
  /** Document state immediately after each commit, as autosave would see it. */
  states: ModelDocument[]
} {
  const engine = new CadEngine(createEmptyDocument())
  const transactions: Transaction[] = []
  const states: ModelDocument[] = []
  for (let index = 0; index < edits; index += 1) {
    const result = engine.execute(
      `Place ${index}`,
      [{ type: 'part.add', part: part(`p${index}`, [index * 100, 0, 0]) }],
      'human',
      index,
    )
    if (result.ok) {
      transactions.push(result.value)
      states.push(engine.getSnapshot().document)
    }
  }
  return { engine, transactions, states }
}

const describeParts = (document: ModelDocument) =>
  Object.values(document.parts)
    .map((item) => `${item.id}@${item.transform.position.join(',')}:${item.color}`)
    .sort()

describe('project repository', () => {
  it('rebuilds a project from a checkpoint plus its transaction log', async () => {
    const repository = new ProjectRepository(new MemoryDriver())
    const { engine, transactions } = build(5)
    const live = engine.getSnapshot().document

    // Checkpoint at the start, then the log carries everything after it.
    await repository.saveCheckpoint(createEmptyDocument())
    for (const transaction of transactions) await repository.appendTransaction(live.id, transaction)

    const loaded = await repository.loadProject(live.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.document.revision).toBe(live.revision)
    expect(loaded!.replayed).toHaveLength(5)
    expect(describeParts(loaded!.document)).toEqual(describeParts(live))
  })

  it('restores connection edges through replay, not re-inference', async () => {
    const repository = new ProjectRepository(new MemoryDriver())
    const engine = new CadEngine(createEmptyDocument())
    const document = engine.getSnapshot().document
    await repository.saveCheckpoint(document)
    const first = engine.execute('Base', [{ type: 'part.add', part: part('base') }], 'human', 0)
    const second = engine.execute('Upper', [{ type: 'part.add', part: part('upper', [0, -24, 0]) }], 'human', 1)
    if (first.ok) await repository.appendTransaction(document.id, first.value)
    if (second.ok) await repository.appendTransaction(document.id, second.value)

    const loaded = await repository.loadProject(document.id)
    expect(Object.keys(loaded!.document.connections)).toHaveLength(8)
  })

  it('replays a captured module, so a reusable sub-build survives reopening', async () => {
    // Modules are document state, not editor state: a bay captured on Tuesday
    // has to still be stampable on Wednesday, through the same log the parts
    // travel in rather than through a side channel.
    const repository = new ProjectRepository(new MemoryDriver())
    const engine = new CadEngine(createEmptyDocument())
    const document = engine.getSnapshot().document
    await repository.saveCheckpoint(document)
    const added = engine.execute('Base', [{ type: 'part.add', part: part('base') }], 'human', 0)
    const module = captureModule(engine.getSnapshot().document, ['base'], 'Bay', 'human', 'module_bay')
    const defined = engine.execute('Capture', [{ type: 'module.define', module }], 'human', 1)
    if (added.ok) await repository.appendTransaction(document.id, added.value)
    if (defined.ok) await repository.appendTransaction(document.id, defined.value)

    const loaded = await repository.loadProject(document.id)
    expect(loaded!.document.modules).toHaveLength(1)
    expect(loaded!.document.modules![0].name).toBe('Bay')
    expect(loaded!.document.modules![0].parts).toHaveLength(1)
  })

  it('stops replay at a gap rather than applying the log out of order', async () => {
    const repository = new ProjectRepository(new MemoryDriver())
    const { engine, transactions } = build(4)
    const document = engine.getSnapshot().document
    await repository.saveCheckpoint(createEmptyDocument())
    // Skip the second transaction, simulating a lost write.
    for (const transaction of [transactions[0], transactions[2], transactions[3]]) {
      await repository.appendTransaction(document.id, transaction)
    }

    const loaded = await repository.loadProject(document.id)
    // One transaction applied, then the chain breaks and the load stops.
    expect(loaded!.replayed).toHaveLength(1)
    expect(loaded!.document.revision).toBe(1)
  })

  it('discards log entries a later checkpoint already contains', async () => {
    const repository = new ProjectRepository(new MemoryDriver())
    const { engine, transactions } = build(3)
    const live = engine.getSnapshot().document
    await repository.saveCheckpoint(createEmptyDocument())
    for (const transaction of transactions) await repository.appendTransaction(live.id, transaction)
    expect(await repository.pendingTransactionCount(live.id)).toBe(3)

    await repository.saveCheckpoint(live)
    expect(await repository.pendingTransactionCount(live.id)).toBe(0)
    const loaded = await repository.loadProject(live.id)
    expect(loaded!.document.revision).toBe(live.revision)
    expect(loaded!.replayed).toHaveLength(0)
  })

  it('lists and deletes projects', async () => {
    const repository = new ProjectRepository(new MemoryDriver())
    const engine = new CadEngine(createEmptyDocument())
    engine.execute('Place', [{ type: 'part.add', part: part('a') }], 'human', 0)
    const document = engine.getSnapshot().document
    await repository.saveCheckpoint(document)

    const projects = await repository.listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ projectId: document.id, partCount: 1 })

    await repository.deleteProject(document.id)
    expect(await repository.listProjects()).toEqual([])
    expect(await repository.loadProject(document.id)).toBeNull()
  })

  it('returns null for a project that was never saved', async () => {
    const repository = new ProjectRepository(new MemoryDriver())
    expect(await repository.loadProject('missing')).toBeNull()
  })
})

describe('autosave', () => {
  it('checkpoints once the log passes the interval', async () => {
    const repository = new ProjectRepository(new MemoryDriver())
    const autosave = new ProjectAutosave(repository, 3)
    const { transactions, states } = build(4)
    const projectId = states[0].id
    await repository.saveCheckpoint(createEmptyDocument())

    // Autosave sees the document as it stood at each commit, as the app does.
    for (const [index, transaction] of transactions.entries()) {
      await autosave.record(states[index], transaction)
    }
    await autosave.settled()

    // The third append checkpointed at revision 3, leaving only the fourth pending.
    expect(await repository.pendingTransactionCount(projectId)).toBe(1)
    expect(autosave.error).toBeNull()

    // And the project still reloads to the newest state.
    const loaded = await repository.loadProject(projectId)
    expect(loaded!.document.revision).toBe(4)
    expect(loaded!.checkpointRevision).toBe(3)
  })

  it('surfaces a storage failure instead of taking the editor down', async () => {
    const failing = new MemoryDriver()
    failing.put = async () => {
      throw new Error('QuotaExceededError')
    }
    const autosave = new ProjectAutosave(new ProjectRepository(failing), 10)
    const { transactions, states } = build(1)
    await autosave.record(states[0], transactions[0])
    await autosave.settled()
    expect(autosave.error).toBe('QuotaExceededError')
  })

  it('serializes writes so log order matches commit order', async () => {
    const order: number[] = []
    const driver = new MemoryDriver()
    const original = driver.put.bind(driver)
    driver.put = async (table, key, value) => {
      // Stagger completion to prove ordering is enforced, not incidental.
      await new Promise((resolve) => setTimeout(resolve, order.length % 2 === 0 ? 4 : 0))
      order.push((value as { resultRevision?: number }).resultRevision ?? -1)
      return original(table, key, value)
    }
    const autosave = new ProjectAutosave(new ProjectRepository(driver), 100)
    const { transactions, states } = build(4)
    for (const [index, transaction] of transactions.entries()) void autosave.record(states[index], transaction)
    await autosave.settled()
    expect(order).toEqual([1, 2, 3, 4])
  })
})
