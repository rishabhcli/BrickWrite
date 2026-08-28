import { describe, expect, it } from 'vitest'
import type { CadOperation } from '../../cad/types'
import { anchorFor, anchorSummary, resolveAnchor, resolveAnchors, threadsOf } from '../comments'
import { PresenceSession, presenceView } from '../presence'
import { canonicalJson, snapshotUploadFor } from '../serialize'
import { diffDocuments, restorePlan, summariseDiff } from '../versions'
import { FakeConvexDeployment } from './fakeBackend'
import { ALICE, BOB, addMember, blankProject, commitAll, makeHarness, part } from './harness'

/**
 * Gate 8  — a version is immutable once written.
 * Gate 9  — presence never becomes document truth.
 * Gate 10 — a comment anchored at revision N reports correctly at N+1.
 */

const MOVE = (partId: string, y: number): CadOperation => ({
  type: 'part.transform',
  partId,
  transform: { position: [0, y, 0], basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
})

function twoPartBase(projectId = 'doc_collab') {
  return commitAll(blankProject(projectId, 'Collaboration fixture'), [
    [{ type: 'part.add', part: part('p1', [0, 0, 0]) }],
    [{ type: 'part.add', part: part('p2', [100, 0, 0]) }],
  ])
}

async function claimedBase(projectId = 'doc_collab') {
  const deployment = new FakeConvexDeployment()
  const alice = makeHarness(ALICE, deployment)
  const base = twoPartBase(projectId)
  await alice.local.saveCheckpoint(base.final)
  const claimed = await alice.store.claim(projectId)
  if (!claimed.ok) throw new Error(claimed.error.message)
  return { deployment, alice, base, claimed: claimed.value }
}

describe('versions are immutable', () => {
  it('returns byte-identical bytes after the project has moved on', async () => {
    const scene = await claimedBase('doc_versions')
    const created = await scene.alice.backend.createVersion({
      projectId: scene.claimed.projectId,
      label: 'v1',
      notes: 'Before the turret rework.',
      snapshot: snapshotUploadFor(scene.base.final),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const first = await scene.alice.backend.versionDocument({
      projectId: scene.claimed.projectId,
      versionId: created.value.versionId,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const pinned = canonicalJson(first.value.document)

    // Now change everything a later edit could plausibly touch.
    const after = commitAll(scene.base.final, [[MOVE('p1', -24)], [MOVE('p2', -48)]])
    for (const transaction of after.transactions) {
      expect((await scene.alice.store.appendTransaction(scene.base.final.id, transaction)).ok).toBe(
        true,
      )
    }
    expect((await scene.alice.outbox.drain()).status).toBe('idle')
    expect((await scene.alice.store.saveCheckpoint(after.final)).ok).toBe(true)
    expect((await scene.alice.outbox.drain()).status).toBe('idle')
    expect(
      (await scene.alice.backend.renameProject({
        projectId: scene.claimed.projectId,
        name: 'Renamed since',
      })).ok,
    ).toBe(true)

    const second = await scene.alice.backend.versionDocument({
      projectId: scene.claimed.projectId,
      versionId: created.value.versionId,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(canonicalJson(second.value.document)).toBe(pinned)
    expect(second.value.checksum).toBe(first.value.checksum)
    expect(second.value.revision).toBe(2)

    // The version row itself is untouched, and the head has moved without it.
    const listed = await scene.alice.backend.listVersions({ projectId: scene.claimed.projectId })
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.value).toHaveLength(1)
      expect(listed.value[0].documentChecksum).toBe(created.value.documentChecksum)
      expect(listed.value[0].revision).toBe(2)
    }
    const project = await scene.alice.backend.getProject({ projectId: scene.claimed.projectId })
    expect(project.ok && project.value.headRevision).toBe(4)
  })

  it('refuses to overwrite a version label', async () => {
    const scene = await claimedBase('doc_labels')
    const snapshot = snapshotUploadFor(scene.base.final)
    expect(
      (await scene.alice.backend.createVersion({
        projectId: scene.claimed.projectId,
        label: 'v1',
        snapshot,
      })).ok,
    ).toBe(true)
    const clash = await scene.alice.backend.createVersion({
      projectId: scene.claimed.projectId,
      label: 'v1',
      snapshot,
    })
    expect(clash.ok).toBe(false)
    if (!clash.ok) expect(clash.error.code).toBe('NAME_TAKEN')
  })

  it('plans a restore as new work, and says what it cannot express', async () => {
    const base = twoPartBase('doc_restore')
    const later = commitAll(base.final, [
      [MOVE('p1', -24)],
      [{ type: 'part.add', part: part('p3', [200, 0, 0]) }],
    ])

    const diff = diffDocuments(base.final, later.final)
    expect(diff.identical).toBe(false)
    expect(diff.parts.moved).toEqual(['p1'])
    expect(diff.parts.added).toEqual(['p3'])
    expect(summariseDiff(diff)).toContain('1 part added')

    // Restoring the earlier version from the later document.
    const plan = restorePlan(later.final, base.final)
    expect(plan.operations.some((operation) => operation.type === 'part.remove')).toBe(true)
    expect(plan.operations.some((operation) => operation.type === 'part.transform')).toBe(true)

    // And it actually produces the older document when run through the engine.
    const restored = commitAll(later.final, [plan.operations])
    expect(restored.final.parts.p1.transform.position).toEqual(
      base.final.parts.p1.transform.position,
    )
    expect(Object.keys(restored.final.parts).sort()).toEqual(['p1', 'p2'])
    // Non-destructive: the restore is a new revision on top, not a rewind.
    expect(restored.final.revision).toBe(later.final.revision + 1)
  })

  it('reports an identical comparison as identical', () => {
    const base = twoPartBase('doc_same')
    expect(diffDocuments(base.final, base.final).identical).toBe(true)
    expect(summariseDiff(diffDocuments(base.final, base.final))).toBe('No structural change.')
  })

  it('audits a merge proposal and its decision', async () => {
    const scene = await claimedBase('doc_merge')
    await addMember(scene.deployment, scene.alice.backend, scene.claimed.projectId, BOB, 'editor')
    const bob = scene.deployment.as(BOB)

    const branch = await bob.createBranch({
      projectId: scene.claimed.projectId,
      name: 'bob/turret',
    })
    expect(branch.ok).toBe(true)
    if (!branch.ok) return

    const proposed = await bob.proposeMerge({
      projectId: scene.claimed.projectId,
      branchId: branch.value.branchId,
      summary: 'Rework the turret bay.',
    })
    expect(proposed.ok && proposed.value.proposal?.status).toBe('open')

    // An editor may propose but not land.
    const bobLands = await bob.decideMerge({
      projectId: scene.claimed.projectId,
      branchId: branch.value.branchId,
      decision: 'merged',
    })
    expect(bobLands.ok).toBe(false)
    if (!bobLands.ok) expect(bobLands.error.code).toBe('FORBIDDEN')

    const ownerLands = await scene.alice.backend.decideMerge({
      projectId: scene.claimed.projectId,
      branchId: branch.value.branchId,
      decision: 'merged',
    })
    expect(ownerLands.ok && ownerLands.value.proposal?.status).toBe('merged')
    if (ownerLands.ok) expect(ownerLands.value.proposal?.decidedBySubject).toBe(ALICE.subject)

    const trail = await scene.alice.backend.auditTrail({ projectId: scene.claimed.projectId })
    expect(trail.ok).toBe(true)
    if (trail.ok) {
      const actions = trail.value.map((event) => event.action)
      expect(actions).toContain('branch.propose')
      expect(actions).toContain('branch.merged')
    }
  })
})

describe('presence is ephemeral', () => {
  it('never alters the document, its revision, or the audit trail', async () => {
    const scene = await claimedBase('doc_presence')
    await addMember(scene.deployment, scene.alice.backend, scene.claimed.projectId, BOB, 'viewer')

    const before = await scene.alice.cloud.loadProject(scene.claimed.projectId)
    const beforeProject = await scene.alice.backend.getProject({
      projectId: scene.claimed.projectId,
    })
    const beforeTransactions = scene.deployment.transactions.length
    const beforeAudit = scene.deployment.auditEvents.length
    const beforeBranch = { ...scene.deployment.branches.find((row) => row._id === scene.claimed.branchId)! }
    const beforeSnapshots = scene.deployment.snapshots.length

    for (let beat = 0; beat < 5; beat += 1) {
      const alice = await scene.alice.backend.presenceHeartbeat({
        projectId: scene.claimed.projectId,
        sessionId: 'session_alice',
        revision: 2,
        selection: ['p1'],
        cursorLdu: { x: beat, y: 0, z: 0 },
      })
      expect(alice.ok).toBe(true)
      const bob = await scene.deployment.as(BOB).presenceHeartbeat({
        projectId: scene.claimed.projectId,
        sessionId: 'session_bob',
        revision: 1,
        selection: [],
        followingSubject: ALICE.subject,
      })
      expect(bob.ok).toBe(true)
    }

    const after = await scene.alice.cloud.loadProject(scene.claimed.projectId)
    const afterProject = await scene.alice.backend.getProject({
      projectId: scene.claimed.projectId,
    })
    expect(before.ok && after.ok).toBe(true)
    if (before.ok && before.value && after.ok && after.value) {
      expect(canonicalJson(after.value.document)).toBe(canonicalJson(before.value.document))
      expect(after.value.document.revision).toBe(before.value.document.revision)
    }
    expect(afterProject).toEqual(beforeProject)
    expect(scene.deployment.transactions).toHaveLength(beforeTransactions)
    expect(scene.deployment.snapshots).toHaveLength(beforeSnapshots)
    // Not even an audit row: a cursor moving is not a fact worth keeping.
    expect(scene.deployment.auditEvents).toHaveLength(beforeAudit)
    expect(scene.deployment.branches.find((row) => row._id === scene.claimed.branchId)).toEqual(
      beforeBranch,
    )
    // Ten heartbeats, two rows.
    expect(scene.deployment.presence).toHaveLength(2)
  })

  it('refuses to let one account write another account’s session row', async () => {
    const scene = await claimedBase('doc_session')
    await addMember(scene.deployment, scene.alice.backend, scene.claimed.projectId, BOB, 'editor')
    expect(
      (await scene.alice.backend.presenceHeartbeat({
        projectId: scene.claimed.projectId,
        sessionId: 'shared_session',
        revision: 2,
        selection: [],
      })).ok,
    ).toBe(true)

    const stolen = await scene.deployment.as(BOB).presenceHeartbeat({
      projectId: scene.claimed.projectId,
      sessionId: 'shared_session',
      revision: 2,
      selection: [],
    })
    expect(stolen.ok).toBe(false)
    if (!stolen.ok) expect(stolen.error.code).toBe('FORBIDDEN')
  })

  it('drops a peer on leave and hides expired rows from the view', async () => {
    const scene = await claimedBase('doc_leave')
    await addMember(scene.deployment, scene.alice.backend, scene.claimed.projectId, BOB, 'editor')

    const session = new PresenceSession(scene.deployment.as(BOB), scene.claimed.projectId, {
      sessionId: 'session_bob',
      now: () => 1_000,
    })
    const published = await session.publish({
      document: scene.base.final,
      selection: ['p2'],
    })
    expect(published?.ok).toBe(true)

    const peers = await scene.alice.backend.listPresence({ projectId: scene.claimed.projectId })
    expect(peers.ok && peers.value).toHaveLength(1)
    if (!peers.ok) return

    const live = presenceView({
      records: peers.value,
      selfSubject: ALICE.subject,
      documentRevision: 2,
      now: Date.parse(peers.value[0].updatedAt),
    })
    expect(live.peers).toHaveLength(1)
    expect(live.peers[0].subject).toBe(BOB.subject)
    expect(live.peers[0].behind).toBe(false)

    // Long after the heartbeat, the same records describe nobody.
    const stale = presenceView({
      records: peers.value,
      selfSubject: ALICE.subject,
      documentRevision: 2,
      now: Date.parse(peers.value[0].expiresAt) + 1,
    })
    expect(stale.peers).toEqual([])

    expect((await session.leave()).ok).toBe(true)
    const after = await scene.alice.backend.listPresence({ projectId: scene.claimed.projectId })
    expect(after.ok && after.value).toHaveLength(0)
  })

  it('carries follow-mode without it touching the document', async () => {
    const scene = await claimedBase('doc_follow')
    await addMember(scene.deployment, scene.alice.backend, scene.claimed.projectId, BOB, 'editor')
    const session = new PresenceSession(scene.deployment.as(BOB), scene.claimed.projectId, {
      sessionId: 'session_bob',
      now: () => 1_000,
    })
    session.follow(ALICE.subject)
    expect(session.following).toBe(ALICE.subject)
    await session.publish({ document: scene.base.final, selection: [] })

    const rows = await scene.alice.backend.listPresence({ projectId: scene.claimed.projectId })
    expect(rows.ok).toBe(true)
    if (!rows.ok) return
    const view = presenceView({
      records: rows.value,
      selfSubject: ALICE.subject,
      documentRevision: 2,
      now: Date.parse(rows.value[0].updatedAt),
    })
    expect(view.followers.map((peer) => peer.subject)).toEqual([BOB.subject])
    expect(scene.deployment.transactions).toHaveLength(0)
  })

  it('coalesces heartbeats that would say nothing new', async () => {
    const scene = await claimedBase('doc_coalesce')
    let clock = 0
    const session = new PresenceSession(scene.alice.backend, scene.claimed.projectId, {
      sessionId: 'session_alice',
      now: () => clock,
      minIntervalMs: 5_000,
    })
    expect(await session.publish({ document: scene.base.final, selection: [] })).not.toBeNull()
    clock += 10
    expect(await session.publish({ document: scene.base.final, selection: [] })).toBeNull()
    clock += 10_000
    expect(await session.publish({ document: scene.base.final, selection: [] })).not.toBeNull()
  })
})

describe('comments are anchored to a revision', () => {
  it('reports a moved anchor after the part moves at the next revision', async () => {
    const scene = await claimedBase('doc_comments')
    const anchor = anchorFor(scene.base.final, 'p1', { x: 0, y: 0, z: 0 })
    expect(anchor).toBeTruthy()
    if (!anchor) return
    expect(anchor.revision).toBe(2)

    const created = await scene.alice.backend.addComment({
      projectId: scene.claimed.projectId,
      body: 'This brick should sit one plate lower.',
      anchor,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // Before anything moves, the anchor is intact.
    expect(resolveAnchor(scene.base.final, created.value).state).toBe('intact')

    // Revision 3 moves the very part the note was about.
    const moved = commitAll(scene.base.final, [[MOVE('p1', -24)]])
    expect(moved.final.revision).toBe(3)

    const stored = await scene.alice.backend.listComments({ projectId: scene.claimed.projectId })
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    // The stored anchor is unchanged: the server never retargets it.
    expect(stored.value[0].anchor).toEqual(anchor)

    const report = resolveAnchor(moved.final, stored.value[0])
    expect(report.state).toBe('moved')
    expect(report.anchoredAtRevision).toBe(2)
    expect(report.documentRevision).toBe(3)
    expect(report.documentAdvanced).toBe(true)
    expect(report.currentPoseChecksum).not.toBe(report.anchorPoseChecksum)
    expect(report.explanation).toContain('revision 2')

    // A note on the untouched part is still intact at the same revision.
    const other = anchorFor(scene.base.final, 'p2')
    expect(other).toBeTruthy()
    if (!other) return
    const otherComment = await scene.alice.backend.addComment({
      projectId: scene.claimed.projectId,
      body: 'Leave this one alone.',
      anchor: other,
    })
    expect(otherComment.ok).toBe(true)
    if (!otherComment.ok) return
    expect(resolveAnchor(moved.final, otherComment.value).state).toBe('intact')

    // And once the part is gone the note says so rather than pointing at air.
    const removed = commitAll(moved.final, [[{ type: 'part.remove', partId: 'p1' }]])
    const gone = resolveAnchor(removed.final, stored.value[0])
    expect(gone.state).toBe('removed')
    expect(gone.currentPoseChecksum).toBeUndefined()

    const summary = anchorSummary(
      resolveAnchors(removed.final, [stored.value[0], otherComment.value]),
    )
    expect(summary).toEqual({ intact: 1, moved: 0, removed: 1 })
  })

  it('refuses to anchor to a part that is not in the document', () => {
    const base = twoPartBase('doc_anchor')
    expect(anchorFor(base.final, 'nope')).toBeNull()
  })

  it('threads replies under their root and resolves the root’s anchor', async () => {
    const scene = await claimedBase('doc_threads')
    const anchor = anchorFor(scene.base.final, 'p1')
    if (!anchor) throw new Error('fixture')
    const root = await scene.alice.backend.addComment({
      projectId: scene.claimed.projectId,
      body: 'Should this be a plate?',
      anchor,
    })
    if (!root.ok) throw new Error(root.error.message)
    const reply = await scene.alice.backend.addComment({
      projectId: scene.claimed.projectId,
      body: 'Yes, a plate reads better here.',
      anchor,
      replyToId: root.value.commentId,
    })
    expect(reply.ok).toBe(true)

    const listed = await scene.alice.backend.listComments({ projectId: scene.claimed.projectId })
    if (!listed.ok) throw new Error('listing failed')
    const threads = threadsOf(scene.base.final, listed.value)
    expect(threads).toHaveLength(1)
    expect(threads[0].replies).toHaveLength(1)
    expect(threads[0].anchor.state).toBe('intact')
  })

  it('lets a commenter resolve their own thread but not somebody else’s', async () => {
    const scene = await claimedBase('doc_resolve')
    await addMember(scene.deployment, scene.alice.backend, scene.claimed.projectId, BOB, 'commenter')
    const bob = scene.deployment.as(BOB)
    const anchor = anchorFor(scene.base.final, 'p1')
    if (!anchor) throw new Error('fixture')

    const bobsComment = await bob.addComment({
      projectId: scene.claimed.projectId,
      body: 'Mine to close.',
      anchor,
    })
    if (!bobsComment.ok) throw new Error(bobsComment.error.message)
    const closedOwn = await bob.setCommentStatus({
      projectId: scene.claimed.projectId,
      commentId: bobsComment.value.commentId,
      status: 'resolved',
    })
    expect(closedOwn.ok).toBe(true)

    const alicesComment = await scene.alice.backend.addComment({
      projectId: scene.claimed.projectId,
      body: 'Not yours to close.',
      anchor,
    })
    if (!alicesComment.ok) throw new Error(alicesComment.error.message)
    const closedOther = await bob.setCommentStatus({
      projectId: scene.claimed.projectId,
      commentId: alicesComment.value.commentId,
      status: 'resolved',
    })
    expect(closedOther.ok).toBe(false)
    if (!closedOther.ok) expect(closedOther.error.code).toBe('FORBIDDEN')
  })
})
