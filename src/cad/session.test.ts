import { beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from './engine'
import { IDENTITY_BASIS } from './math'
import {createBlankDocument} from './sample'
import { createRoverDocument } from './__fixtures__/rover'
import { session } from './session'
import { bestSnapTransform } from './snapping'
import { getDocumentBounds } from './geometry'
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

const makePart = (id: string): PartInstance => ({
  id,
  definitionId: '3024',
  color: 72,
  transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/**
 * Commits one 1 × 1 plate onto a free stud of the live document.
 *
 * These tests only need *a* successful transaction to move a revision forward.
 * Invented XYZ on the showcase rover either collides, sits on a tile, or
 * leaves the hard envelope; the snap solver is the same path a real placement
 * takes.
 */
const place = (id: string) => {
  const document = cadEngine.getSnapshot().document
  const bounds = getDocumentBounds(document)
  const candidate = makePart(id)
  const cursor = {
    position: [
      (bounds.min[0] + bounds.max[0]) / 2,
      bounds.min[1] - 8,
      (bounds.min[2] + bounds.max[2]) / 2,
    ] as [number, number, number],
    basis: IDENTITY_BASIS,
  }
  const snapped = bestSnapTransform({ ...candidate, transform: cursor }, document, cursor, { radiusLdu: 48 })
  expect(snapped, `no free stud to place ${id}`).toBeTruthy()
  const result = cadEngine.execute('Place', [{ type: 'part.add', part: { ...candidate, transform: snapped! } }], 'human')
  expect(result.ok).toBe(true)
}

describe('session projects', () => {
  let sequence = 0

  // Each test gets its own project id and an empty store. Sharing one would make
  // `start()` restore whatever the previous test happened to leave behind, which
  // is how a passing suite hides a real switching bug.
  beforeEach(async () => {
    sequence += 1
    cadEngine.replaceDocument({ ...createRoverDocument(), id: `doc_test_${sequence}`, name: `Test ${sequence}` })
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

    place('fork_part')

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
    place('late_part')
    const switched = await session.openProject(originId)
    expect(switched.ok).toBe(true)

    const reopened = await session.openProject(forkId)
    expect(reopened.ok).toBe(true)
    expect(cadEngine.getSnapshot().document.parts.late_part).toBeDefined()
  })

  it('checkpoints on the way out, so a reopened project needs no replay', async () => {
    const originId = session.currentProjectId
    place('a')
    place('b')
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
    place('a')
    place('b')
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

  it('exports an archive of the live revision after checkpointing', async () => {
    place('archive_part')
    const json = await session.exportArchive()
    expect(json).toContain('"brickwrightArchive": 1')
    expect(json).toContain(`"revision": ${cadEngine.getSnapshot().document.revision}`)
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
