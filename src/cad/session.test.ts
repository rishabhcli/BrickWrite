import { beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from './engine'
import { IDENTITY_BASIS } from './math'
import { createBlankDocument, createShowcaseDocument } from './sample'
import { session } from './session'
import type { PartInstance } from './types'

/**
 * Project-switching properties.
 *
 * The session is the only place that moves the editor between documents, and the
 * failure it must not have is losing work: a switch flushes the outgoing
 * project's queued appends and checkpoints it before anything replaces the
 * document. These tests exercise the singleton against the in-memory driver that
 * jsdom falls back to, which is the same code path the browser takes minus
 * IndexedDB itself.
 */

const makePart = (id: string, x: number): PartInstance => ({
  id,
  definitionId: '3001',
  color: 72,
  transform: { position: [x, 0, 0], basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/**
 * Commits one part, and asserts it committed.
 *
 * These tests only need *a* successful transaction to move a revision forward;
 * the position is incidental. It still has to land inside the showcase's hard
 * `Envelope ≤ 10 × 14 studs` constraint, which the kernel enforces on every
 * commit — the rover already spans 8 × 12 studs across x ∈ [-80, 80] LDU, so an
 * offset outside that footprint is refused as `CONSTRAINT_VIOLATION` and the
 * failure reads as a session bug when it is nothing of the sort.
 */
const place = (id: string, x: number) => {
  const result = cadEngine.execute('Place', [{ type: 'part.add', part: makePart(id, x) }], 'human')
  expect(result.ok).toBe(true)
}

describe('session projects', () => {
  let sequence = 0

  // Each test gets its own project id and an empty store. Sharing one would make
  // `start()` restore whatever the previous test happened to leave behind, which
  // is how a passing suite hides a real switching bug.
  beforeEach(async () => {
    sequence += 1
    cadEngine.replaceDocument({ ...createShowcaseDocument(), id: `doc_test_${sequence}`, name: `Test ${sequence}` })
    for (const project of await session.listProjects()) {
      if (project.projectId !== session.currentProjectId) await session.deleteProject(project.projectId)
    }
    await session.start()
  })

  it('checkpoints the opening document so it is reachable as a project', async () => {
    const projects = await session.listProjects()
    expect(projects.map((project) => project.projectId)).toContain(session.currentProjectId)
    expect(session.status.restore?.source).toBe('showcase')
  })

  it('forks into a new project without touching the original', async () => {
    const originId = session.currentProjectId
    const originRevision = cadEngine.getSnapshot().document.revision

    const fork = await session.forkProject('Wing study')
    expect(fork.ok).toBe(true)
    expect(session.currentProjectId).not.toBe(originId)
    expect(cadEngine.getSnapshot().document.name).toBe('Wing study')

    place('fork_part', 0)

    const projects = await session.listProjects()
    const origin = projects.find((project) => project.projectId === originId)
    expect(origin?.revision).toBe(originRevision)

    // The origin still loads at its own revision: the fork's transactions went
    // to the fork's log, not the shared one.
    const back = await session.openProject(originId)
    expect(back.ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(originRevision)
    expect(cadEngine.getSnapshot().document.parts.fork_part).toBeUndefined()
  })

  it('gives same-named forks distinct projects rather than overwriting one', async () => {
    const first = await session.forkProject('Variant')
    const firstId = session.currentProjectId
    const second = await session.forkProject('Variant')
    expect(first.ok && second.ok).toBe(true)
    expect(session.currentProjectId).not.toBe(firstId)

    const ids = (await session.listProjects()).map((project) => project.projectId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(firstId)
    expect(ids).toContain(session.currentProjectId)
  })

  it('does not lose a transaction committed immediately before a switch', async () => {
    const originId = session.currentProjectId
    await session.forkProject('Edited fork')
    const forkId = session.currentProjectId

    // No `settled()` here on purpose: the append is still queued when the switch
    // begins, which is exactly the race the flush exists to close.
    place('late_part', 40)
    const switched = await session.openProject(originId)
    expect(switched.ok).toBe(true)

    const reopened = await session.openProject(forkId)
    expect(reopened.ok).toBe(true)
    expect(cadEngine.getSnapshot().document.parts.late_part).toBeDefined()
  })

  it('checkpoints on the way out, so a reopened project needs no replay', async () => {
    const originId = session.currentProjectId
    place('a', 0)
    place('b', 40)
    const revision = cadEngine.getSnapshot().document.revision
    await session.forkProject('Elsewhere')

    const reopened = await session.openProject(originId)
    expect(reopened.ok).toBe(true)
    expect(reopened.restore?.replayedTransactions).toBe(0)
    // Zero replay is only correct if the checkpoint captured the commits, so
    // the revision and the parts are what prove nothing was dropped.
    expect(cadEngine.getSnapshot().document.revision).toBe(revision)
    expect(cadEngine.getSnapshot().document.parts.a).toBeDefined()
    expect(cadEngine.getSnapshot().document.parts.b).toBeDefined()
  })

  it('replays the log on boot for commits made after the last checkpoint', async () => {
    place('a', 0)
    place('b', 40)
    const revision = cadEngine.getSnapshot().document.revision
    await session.settled()

    // A reload does not get a farewell checkpoint — this is the crash-and-reopen
    // path, and the transaction log is the only thing standing between the
    // operator and losing the last two edits.
    const restore = await session.start()
    expect(restore.source).toBe('indexeddb')
    expect(restore.replayedTransactions).toBe(2)
    expect(cadEngine.getSnapshot().document.revision).toBe(revision)
    expect(cadEngine.getSnapshot().document.parts.b).toBeDefined()
  })

  it('refuses to delete the open project, and deletes any other', async () => {
    const originId = session.currentProjectId
    const refused = await session.deleteProject(originId)
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('OPEN_PROJECT')
    expect((await session.listProjects()).map((project) => project.projectId)).toContain(originId)

    await session.forkProject('Disposable')
    const disposableId = session.currentProjectId
    await session.openProject(originId)
    const deleted = await session.deleteProject(disposableId)
    expect(deleted.ok).toBe(true)
    expect((await session.listProjects()).map((project) => project.projectId)).not.toContain(disposableId)

    const missing = await session.openProject(disposableId)
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('NOT_FOUND')
  })

  it('imports a document as a new stored project without touching the origin', async () => {
    const originId = session.currentProjectId
    const originRevision = cadEngine.getSnapshot().document.revision
    const incoming = createBlankDocument('Imported study')
    const result = await session.importDocument(incoming)
    expect(result.ok).toBe(true)
    expect(session.currentProjectId).not.toBe(originId)
    expect(cadEngine.getSnapshot().document.name).toBe('Imported study')
    expect(Object.keys(cadEngine.getSnapshot().document.parts)).toHaveLength(0)

    const back = await session.openProject(originId)
    expect(back.ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(originRevision)
  })

  it('leaves the document alone when opening the project already open', async () => {
    const before = cadEngine.getSnapshot().document
    const result = await session.openProject(before.id)
    expect(result.ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(before.revision)
    expect(Object.keys(cadEngine.getSnapshot().document.parts)).toHaveLength(Object.keys(before.parts).length)
  })
})
