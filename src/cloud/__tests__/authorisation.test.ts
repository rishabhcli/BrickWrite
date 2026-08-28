import { describe, expect, it } from 'vitest'
import { CAPABILITY_MATRIX, ROLES, roleAllows, type Capability, type CloudRole } from '../permissions'
import type { CloudBackend, CloudResult } from '../protocol'
import { FakeConvexDeployment } from './fakeBackend'
import { ALICE, BOB, CAROL, addMember, blankProject, makeHarness, placements } from './harness'
import { snapshotUploadFor, transactionChecksum } from '../serialize'

/**
 * Gate 1 — a user may not reach another user's private project.
 * Gate 2 — the capability matrix, enforced by the deployment.
 *
 * The deployment is the authority here, so every assertion goes through the
 * backend rather than through `roleAllows` on the client. The client mirror is
 * only used to state the expectation: the matrix says a commenter cannot write
 * a transaction, and the test proves the server agrees.
 */

async function seedAliceProject() {
  const deployment = new FakeConvexDeployment()
  const alice = makeHarness(ALICE, deployment)
  const seeded = await (async () => {
    const document = blankProject('doc_alice', "Alice's rover")
    await alice.local.saveCheckpoint(document)
    const claimed = await alice.store.claim('doc_alice')
    if (!claimed.ok) throw new Error(claimed.error.message)
    return { document, projectId: claimed.value.projectId, branchId: claimed.value.branchId }
  })()
  const history = placements(seeded.document, ['p1'])
  const appended = await alice.backend.appendTransaction({
    projectId: seeded.projectId,
    clientTransactionId: history.transactions[0].id,
    baseRevision: 0,
    resultRevision: 1,
    transaction: history.transactions[0],
    checksum: transactionChecksum(history.transactions[0]),
    schemaVersion: seeded.document.schemaVersion,
    catalogVersion: seeded.document.catalogVersion,
  })
  expect(appended.ok).toBe(true)
  const comment = await alice.backend.addComment({
    projectId: seeded.projectId,
    body: 'The turret sits one plate too low.',
    anchor: { partId: 'p1', revision: 1, poseChecksum: 'seed' },
  })
  if (!comment.ok) throw new Error(comment.error.message)
  const version = await alice.backend.createVersion({
    projectId: seeded.projectId,
    label: 'v1',
    snapshot: snapshotUploadFor(history.final),
  })
  if (!version.ok) throw new Error(version.error.message)
  return {
    deployment,
    alice,
    ...seeded,
    history,
    commentId: comment.value.commentId,
    versionId: version.value.versionId,
  }
}

/** Every backend call an outsider might try, with a stable label. */
function probes(
  backend: CloudBackend,
  ids: { projectId: string; branchId: string; commentId: string; versionId: string },
  document: ReturnType<typeof blankProject>,
): Array<[string, () => Promise<CloudResult<unknown>>]> {
  return [
    ['getProject', () => backend.getProject({ projectId: ids.projectId })],
    ['listBranches', () => backend.listBranches({ projectId: ids.projectId })],
    ['latestCheckpoint', () => backend.latestCheckpoint({ projectId: ids.projectId })],
    [
      'listTransactions',
      () => backend.listTransactions({ projectId: ids.projectId, sinceRevision: 0 }),
    ],
    [
      'findTransaction',
      () => backend.findTransaction({ projectId: ids.projectId, clientTransactionId: 'txn_x' }),
    ],
    ['listVersions', () => backend.listVersions({ projectId: ids.projectId })],
    [
      'versionDocument',
      () => backend.versionDocument({ projectId: ids.projectId, versionId: ids.versionId }),
    ],
    ['listMembers', () => backend.listMembers({ projectId: ids.projectId })],
    ['listInvitations', () => backend.listInvitations({ projectId: ids.projectId })],
    ['listComments', () => backend.listComments({ projectId: ids.projectId })],
    ['commentsForPart', () => backend.commentsForPart({ projectId: ids.projectId, partId: 'p1' })],
    ['listPresence', () => backend.listPresence({ projectId: ids.projectId })],
    ['auditTrail', () => backend.auditTrail({ projectId: ids.projectId })],
    ['renameProject', () => backend.renameProject({ projectId: ids.projectId, name: 'Stolen' })],
    [
      'setVisibility',
      () => backend.setVisibility({ projectId: ids.projectId, visibility: 'public' }),
    ],
    ['deleteProject', () => backend.deleteProject({ projectId: ids.projectId })],
    [
      'saveCheckpoint',
      () =>
        backend.saveCheckpoint({
          projectId: ids.projectId,
          snapshot: snapshotUploadFor(document),
        }),
    ],
    [
      'appendTransaction',
      () =>
        backend.appendTransaction({
          projectId: ids.projectId,
          clientTransactionId: 'txn_intruder',
          baseRevision: 1,
          resultRevision: 2,
          transaction: placements(document, ['intruder']).transactions[0],
          checksum: 'whatever',
          schemaVersion: document.schemaVersion,
          catalogVersion: document.catalogVersion,
        }),
    ],
    [
      'createVersion',
      () =>
        backend.createVersion({
          projectId: ids.projectId,
          label: 'intruder',
          snapshot: snapshotUploadFor(document),
        }),
    ],
    [
      'createBranch',
      () => backend.createBranch({ projectId: ids.projectId, name: 'intruder' }),
    ],
    [
      'proposeMerge',
      () =>
        backend.proposeMerge({
          projectId: ids.projectId,
          branchId: ids.branchId,
          summary: 'let me in',
        }),
    ],
    [
      'decideMerge',
      () =>
        backend.decideMerge({
          projectId: ids.projectId,
          branchId: ids.branchId,
          decision: 'merged',
        }),
    ],
    [
      'setMemberRole',
      () =>
        backend.setMemberRole({
          projectId: ids.projectId,
          subject: CAROL.subject,
          role: 'editor',
        }),
    ],
    [
      'removeMember',
      () => backend.removeMember({ projectId: ids.projectId, subject: CAROL.subject }),
    ],
    [
      'createInvitation',
      () =>
        backend.createInvitation({
          projectId: ids.projectId,
          email: 'intruder@example.test',
          role: 'editor',
        }),
    ],
    [
      'revokeInvitation',
      () =>
        backend.revokeInvitation({ projectId: ids.projectId, invitationId: 'invitations_1' }),
    ],
    [
      'addComment',
      () =>
        backend.addComment({
          projectId: ids.projectId,
          body: 'I should not be able to write this.',
          anchor: { partId: 'p1', revision: 1, poseChecksum: 'x' },
        }),
    ],
    [
      'setCommentStatus',
      () =>
        backend.setCommentStatus({
          projectId: ids.projectId,
          commentId: ids.commentId,
          status: 'resolved',
        }),
    ],
    [
      'presenceHeartbeat',
      () =>
        backend.presenceHeartbeat({
          projectId: ids.projectId,
          sessionId: 'session_intruder',
          revision: 1,
          selection: [],
        }),
    ],
    [
      'presenceLeave',
      () => backend.presenceLeave({ projectId: ids.projectId, sessionId: 'session_intruder' }),
    ],
  ]
}

describe('cross-account authorisation', () => {
  it("refuses every function to a signed-in user who is not a member of a private project", async () => {
    const seed = await seedAliceProject()
    const bob = seed.deployment.as(BOB)

    for (const [label, call] of probes(
      bob,
      {
        projectId: seed.projectId,
        branchId: seed.branchId,
        commentId: seed.commentId,
        versionId: seed.versionId,
      },
      seed.document,
    )) {
      const result = await call()
      expect(result.ok, `${label} must not succeed for a non-member`).toBe(false)
      if (result.ok) continue
      // NOT_FOUND rather than FORBIDDEN: FORBIDDEN would confirm the project
      // exists, which a stranger is not entitled to learn.
      expect(result.error.code, `${label} leaked the project's existence`).toBe('NOT_FOUND')
    }
  })

  it('refuses every function to an anonymous caller', async () => {
    const seed = await seedAliceProject()
    const anonymous = seed.deployment.as(null)

    for (const [label, call] of probes(
      anonymous,
      {
        projectId: seed.projectId,
        branchId: seed.branchId,
        commentId: seed.commentId,
        versionId: seed.versionId,
      },
      seed.document,
    )) {
      const result = await call()
      expect(result.ok, `${label} must not succeed without an identity`).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED')
    }
  })

  it("keeps another user's project out of the project list", async () => {
    const seed = await seedAliceProject()
    const bobsList = await seed.deployment.as(BOB).listProjects()
    expect(bobsList.ok).toBe(true)
    if (bobsList.ok) expect(bobsList.value).toEqual([])

    const alicesList = await seed.alice.backend.listProjects()
    expect(alicesList.ok).toBe(true)
    if (alicesList.ok) {
      expect(alicesList.value.map((summary) => summary.projectId)).toEqual([seed.projectId])
    }
  })

  it('reports no role for a stranger without revealing the project', async () => {
    const seed = await seedAliceProject()
    const role = await seed.deployment.as(BOB).myRole({ projectId: seed.projectId })
    expect(role).toEqual({ ok: true, value: null })
  })

  it('lets a public project be read but still refuses every mutation', async () => {
    const seed = await seedAliceProject()
    const published = await seed.alice.backend.setVisibility({
      projectId: seed.projectId,
      visibility: 'public',
    })
    expect(published.ok).toBe(true)

    const bob = seed.deployment.as(BOB)
    const read = await bob.getProject({ projectId: seed.projectId })
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.value.role).toBe('viewer')

    const write = await bob.appendTransaction({
      projectId: seed.projectId,
      clientTransactionId: 'txn_public_intruder',
      baseRevision: 1,
      resultRevision: 2,
      transaction: placements(seed.document, ['x']).transactions[0],
      checksum: 'nope',
      schemaVersion: seed.document.schemaVersion,
      catalogVersion: seed.document.catalogVersion,
    })
    expect(write.ok).toBe(false)
    if (!write.ok) expect(write.error.code).toBe('FORBIDDEN')

    // A public project does not publish its member list's private counterpart:
    // invitations carry email addresses and stay owner-only.
    const invitations = await bob.listInvitations({ projectId: seed.projectId })
    expect(invitations.ok).toBe(false)
    if (!invitations.ok) expect(invitations.error.code).toBe('FORBIDDEN')
  })
})

describe('capability matrix', () => {
  /** Each mutating probe, with the capability the deployment should demand. */
  const REQUIRED: Array<[string, Capability]> = [
    ['getProject', 'project.read'],
    ['listMembers', 'member.list'],
    ['listComments', 'comment.read'],
    ['renameProject', 'project.rename'],
    ['setVisibility', 'project.delete'],
    ['deleteProject', 'project.delete'],
    ['saveCheckpoint', 'snapshot.write'],
    ['appendTransaction', 'transaction.write'],
    ['createVersion', 'version.create'],
    ['createBranch', 'branch.create'],
    ['proposeMerge', 'branch.propose'],
    ['decideMerge', 'branch.merge'],
    ['setMemberRole', 'member.setRole'],
    ['removeMember', 'member.remove'],
    ['createInvitation', 'member.invite'],
    ['listInvitations', 'member.invite'],
    ['addComment', 'comment.create'],
    ['setCommentStatus', 'comment.resolve'],
    ['presenceHeartbeat', 'presence.publish'],
    ['auditTrail', 'audit.read'],
  ]

  for (const role of ROLES) {
    it(`enforces every capability for a ${role}`, async () => {
      const seed = await seedAliceProject()
      // Carol exists so `setMemberRole`/`removeMember` have a real target that
      // is neither the caller nor the owner.
      await addMember(seed.deployment, seed.alice.backend, seed.projectId, CAROL, 'viewer')

      let actor: CloudBackend
      let actorRole: CloudRole
      if (role === 'owner') {
        actor = seed.alice.backend
        actorRole = 'owner'
      } else {
        await addMember(seed.deployment, seed.alice.backend, seed.projectId, BOB, role)
        actor = seed.deployment.as(BOB)
        actorRole = role
      }

      const table = new Map(
        probes(
          actor,
          {
            projectId: seed.projectId,
            branchId: seed.branchId,
            commentId: seed.commentId,
            versionId: seed.versionId,
          },
          seed.document,
        ),
      )

      for (const [label, capability] of REQUIRED) {
        const call = table.get(label)
        expect(call, `${label} is missing from the probe table`).toBeTruthy()
        const result = await call!()
        const allowed = roleAllows(actorRole, capability)
        if (allowed) {
          // An allowed call may still fail for a real reason — no open merge
          // proposal, a duplicate label — but never for lack of permission.
          if (!result.ok) {
            expect(
              result.error.code,
              `${role} holds ${capability} but ${label} answered FORBIDDEN`,
            ).not.toBe('FORBIDDEN')
          }
        } else {
          expect(result.ok, `${role} must not be able to ${label}`).toBe(false)
          if (!result.ok) {
            expect(result.error.code, `${role}/${label}`).toBe('FORBIDDEN')
          }
        }
      }
    })
  }

  it('matches the client mirror to the matrix the deployment enforces', () => {
    // The client copy is advisory, but it must not be *wrong*: a control the
    // client enables and the server refuses is worse than one that is greyed
    // out. Both sides read the same table, and this pins that they do.
    expect(CAPABILITY_MATRIX.commenter).not.toContain('transaction.write')
    expect(CAPABILITY_MATRIX.viewer).not.toContain('comment.create')
    expect(CAPABILITY_MATRIX.editor).not.toContain('branch.merge')
    expect(CAPABILITY_MATRIX.editor).not.toContain('member.setRole')
    expect(CAPABILITY_MATRIX.editor).not.toContain('audit.read')
    expect(CAPABILITY_MATRIX.owner).toContain('project.delete')
  })

  it('will not let an owner be demoted or removed', async () => {
    const seed = await seedAliceProject()
    const demote = await seed.alice.backend.setMemberRole({
      projectId: seed.projectId,
      subject: ALICE.subject,
      role: 'viewer',
    })
    expect(demote.ok).toBe(false)
    if (!demote.ok) expect(demote.error.code).toBe('FORBIDDEN')

    const remove = await seed.alice.backend.removeMember({
      projectId: seed.projectId,
      subject: ALICE.subject,
    })
    expect(remove.ok).toBe(false)
  })

  it('lets a collaborator leave without an owner’s permission', async () => {
    const seed = await seedAliceProject()
    await addMember(seed.deployment, seed.alice.backend, seed.projectId, BOB, 'viewer')
    const left = await seed.deployment
      .as(BOB)
      .removeMember({ projectId: seed.projectId, subject: BOB.subject })
    expect(left).toEqual({ ok: true, value: { removed: true } })

    const after = await seed.deployment.as(BOB).getProject({ projectId: seed.projectId })
    expect(after.ok).toBe(false)
  })
})
