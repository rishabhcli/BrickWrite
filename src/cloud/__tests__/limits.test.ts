import { describe, expect, it } from 'vitest'
import { redactAuditDetail } from '../../../convex/model/redaction'
import { validateSnapshotUpload } from '../../../convex/model/limits'
import type { CadOperation } from '../../cad/types'
import {
  MAX_COMMENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_TRANSACTION_BYTES,
  type SnapshotUpload,
} from '../protocol'
import {
  canonicalJson,
  checksumOfText,
  chunkText,
  snapshotUploadFor,
  transactionChecksum,
  utf8Bytes,
} from '../serialize'
import { SNAPSHOT_CHUNK_BYTES } from '../protocol'
import { anchorFor } from '../comments'
import { FakeConvexDeployment } from './fakeBackend'
import { ALICE, BOB, addMember, blankProject, commitAll, makeHarness, part } from './harness'

/**
 * Gate 11 — an oversized payload is refused with a typed error, never truncated.
 * Gate 12 — the audit trail contains no project content and no email address.
 */

function twoPartBase(projectId: string) {
  return commitAll(blankProject(projectId, 'Limits fixture'), [
    [{ type: 'part.add', part: part('p1', [0, 0, 0]) }],
    [{ type: 'part.add', part: part('p2', [100, 0, 0]) }],
  ])
}

async function claimed(projectId: string, name?: string) {
  const deployment = new FakeConvexDeployment()
  const alice = makeHarness(ALICE, deployment)
  const base = twoPartBase(projectId)
  const document = name ? { ...base.final, name } : base.final
  await alice.local.saveCheckpoint(document)
  const result = await alice.store.claim(projectId)
  if (!result.ok) throw new Error(result.error.message)
  return { deployment, alice, base, document, claimed: result.value }
}

describe('payload ceilings', () => {
  it('refuses an oversized checkpoint and stores nothing', async () => {
    const scene = await claimed('doc_big')
    const before = scene.deployment.snapshots.length

    // A genuinely oversized payload, chunked and checksummed the way the real
    // client would send it — not a hand-set byte count.
    const text = 'x'.repeat(MAX_SNAPSHOT_BYTES + 512_000)
    const upload: SnapshotUpload = {
      revision: 3,
      chunks: chunkText(text, SNAPSHOT_CHUNK_BYTES),
      checksum: checksumOfText(text),
      bytes: utf8Bytes(text),
      schemaVersion: 2,
      catalogVersion: scene.document.catalogVersion,
    }
    expect(upload.bytes).toBeGreaterThan(MAX_SNAPSHOT_BYTES)

    const refused = await scene.alice.backend.saveCheckpoint({
      projectId: scene.claimed.projectId,
      snapshot: upload,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.code).toBe('PAYLOAD_TOO_LARGE')
      expect(refused.error.repair).toBeTruthy()
      expect((refused.error.details as { limit: number }).limit).toBe(MAX_SNAPSHOT_BYTES)
    }
    // Refused, not truncated: not one chunk row was written.
    expect(scene.deployment.snapshots).toHaveLength(before)
  })

  it('refuses an oversized project creation without leaving a half-made project', async () => {
    const deployment = new FakeConvexDeployment()
    const harness = makeHarness(ALICE, deployment)
    const text = 'y'.repeat(MAX_SNAPSHOT_BYTES + 512_000)
    const refused = await harness.backend.createProject({
      localProjectId: 'doc_toobig',
      name: 'Too big',
      schemaVersion: 2,
      catalogVersion: 'fixture-1',
      snapshot: {
        revision: 0,
        chunks: chunkText(text, SNAPSHOT_CHUNK_BYTES),
        checksum: checksumOfText(text),
        bytes: utf8Bytes(text),
        schemaVersion: 2,
        catalogVersion: 'fixture-1',
      },
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(deployment.projects).toHaveLength(0)
    expect(deployment.branches).toHaveLength(0)
    expect(deployment.members).toHaveLength(0)
  })

  it('refuses an oversized transaction', async () => {
    const scene = await claimed('doc_bigtxn')
    // A module captured from several thousand parts is a legitimate edit the
    // kernel will happily commit, and it is how a transaction realistically
    // grows past the ceiling — the kernel already caps free text at 800
    // characters, so a giant note is not a shape this could ever take.
    const batch: CadOperation[] = [
      {
        type: 'module.define',
        module: {
          id: 'module_huge',
          name: 'Facade bay',
          parts: Array.from({ length: 4_000 }, (_unused, index) => ({
            definitionId: '3001',
            color: 72,
            transform: {
              position: [index * 20, 0, 0] as [number, number, number],
              basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [
                number, number, number, number, number, number, number, number, number,
              ],
            },
          })),
          sizeLdu: [80_000, 24, 20],
          createdAtRevision: 2,
          author: 'human',
        },
      },
    ]
    const history = commitAll(scene.document, [batch])
    const transaction = history.transactions[0]
    expect(utf8Bytes(canonicalJson(transaction))).toBeGreaterThan(MAX_TRANSACTION_BYTES)

    const refused = await scene.alice.backend.appendTransaction({
      projectId: scene.claimed.projectId,
      clientTransactionId: transaction.id,
      baseRevision: transaction.baseRevision,
      resultRevision: transaction.resultRevision,
      transaction,
      checksum: transactionChecksum(transaction),
      schemaVersion: scene.document.schemaVersion,
      catalogVersion: scene.document.catalogVersion,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(scene.deployment.transactions).toHaveLength(0)
    // The head did not move, so nothing downstream believes this landed.
    const branch = scene.deployment.branches.find((row) => row._id === scene.claimed.branchId)
    expect(branch?.headRevision).toBe(2)
  })

  it('refuses an oversized comment', async () => {
    const scene = await claimed('doc_bigcomment')
    const anchor = anchorFor(scene.document, 'p1')
    if (!anchor) throw new Error('fixture')
    const refused = await scene.alice.backend.addComment({
      projectId: scene.claimed.projectId,
      body: 'z'.repeat(MAX_COMMENT_BYTES + 1),
      anchor,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(scene.deployment.comments).toHaveLength(0)
  })

  it('refuses a snapshot whose checksum does not match its own bytes', () => {
    const document = twoPartBase('doc_checksum').final
    const upload = snapshotUploadFor(document)
    const tampered: SnapshotUpload = { ...upload, checksum: '0'.repeat(32) }
    const verdict = validateSnapshotUpload(tampered)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error.code).toBe('CHECKSUM_MISMATCH')
  })

  it('refuses a snapshot whose declared size does not match its chunks', () => {
    const document = twoPartBase('doc_size').final
    const upload = snapshotUploadFor(document)
    const verdict = validateSnapshotUpload({ ...upload, bytes: upload.bytes + 10 })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error.code).toBe('CHECKSUM_MISMATCH')
  })

  it('reports a short read rather than returning a document with parts missing', async () => {
    const scene = await claimed('doc_short')
    // Force a multi-chunk snapshot so a chunk can go missing.
    const wide = {
      ...scene.document,
      name: 'w'.repeat(SNAPSHOT_CHUNK_BYTES + 5_000),
    }
    const saved = await scene.alice.backend.saveCheckpoint({
      projectId: scene.claimed.projectId,
      snapshot: snapshotUploadFor(wide),
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const chunks = scene.deployment.snapshots.filter((row) => row.groupId === saved.value.groupId)
    expect(chunks.length).toBeGreaterThan(1)
    const index = scene.deployment.snapshots.findIndex(
      (row) => row.groupId === saved.value.groupId && row.chunkIndex === 1,
    )
    scene.deployment.snapshots.splice(index, 1)

    const read = await scene.alice.backend.latestCheckpoint({
      projectId: scene.claimed.projectId,
    })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.code).toBe('INCOMPLETE_SNAPSHOT')
  })

  it('reports a corrupted chunk rather than parsing it', async () => {
    const scene = await claimed('doc_corrupt')
    const saved = await scene.alice.backend.saveCheckpoint({
      projectId: scene.claimed.projectId,
      snapshot: snapshotUploadFor(scene.document),
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const chunk = scene.deployment.snapshots.find((row) => row.groupId === saved.value.groupId)
    if (!chunk) throw new Error('fixture')
    chunk.data = chunk.data.replace('"revision"', '"revisiOn"')

    const read = await scene.alice.backend.latestCheckpoint({
      projectId: scene.claimed.projectId,
    })
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.error.code).toBe('CHECKSUM_MISMATCH')
  })
})

describe('audit redaction', () => {
  const CONTENT_NAME = "Alice's rover, drafted for bob@example.test"
  const COMMENT_BODY = 'Email me at carol@example.test about the turret geometry.'
  const NOTE_TEXT = 'The hull walls need a second layer of 1x4 plates.'

  it('keeps project content and email addresses out of every event', async () => {
    const scene = await claimed('doc_audit', CONTENT_NAME)
    await addMember(scene.deployment, scene.alice.backend, scene.claimed.projectId, BOB, 'editor')

    // Exercise every action that writes an audit row.
    await scene.alice.backend.renameProject({
      projectId: scene.claimed.projectId,
      name: CONTENT_NAME,
    })
    await scene.alice.backend.setVisibility({
      projectId: scene.claimed.projectId,
      visibility: 'unlisted',
    })
    const anchor = anchorFor(scene.document, 'p1')
    if (!anchor) throw new Error('fixture')
    const comment = await scene.alice.backend.addComment({
      projectId: scene.claimed.projectId,
      body: COMMENT_BODY,
      anchor,
    })
    if (!comment.ok) throw new Error(comment.error.message)
    await scene.alice.backend.setCommentStatus({
      projectId: scene.claimed.projectId,
      commentId: comment.value.commentId,
      status: 'resolved',
    })
    await scene.alice.backend.createInvitation({
      projectId: scene.claimed.projectId,
      email: 'dave@example.test',
      role: 'viewer',
    })
    const history = commitAll(scene.document, [
      [
        {
          type: 'note.add',
          note: {
            id: 'note_audit',
            anchorPartIds: ['p1'],
            text: NOTE_TEXT,
            status: 'open',
            author: 'human',
            revisionCreated: 2,
          },
        },
      ],
    ])
    await scene.alice.store.appendTransaction(scene.document.id, history.transactions[0])
    await scene.alice.outbox.drain()
    await scene.alice.backend.createVersion({
      projectId: scene.claimed.projectId,
      label: 'v1',
      snapshot: snapshotUploadFor(history.final),
    })
    const branch = await scene.alice.backend.createBranch({
      projectId: scene.claimed.projectId,
      name: 'side',
    })
    if (branch.ok) {
      await scene.alice.backend.proposeMerge({
        projectId: scene.claimed.projectId,
        branchId: branch.value.branchId,
        summary: COMMENT_BODY,
      })
      await scene.alice.backend.decideMerge({
        projectId: scene.claimed.projectId,
        branchId: branch.value.branchId,
        decision: 'merged',
      })
    }
    await scene.alice.backend.setMemberRole({
      projectId: scene.claimed.projectId,
      subject: BOB.subject,
      role: 'viewer',
    })
    await scene.alice.backend.removeMember({
      projectId: scene.claimed.projectId,
      subject: BOB.subject,
    })

    const trail = await scene.alice.backend.auditTrail({
      projectId: scene.claimed.projectId,
      limit: 500,
    })
    expect(trail.ok).toBe(true)
    if (!trail.ok) return
    expect(trail.value.length).toBeGreaterThan(8)

    const forbidden = [CONTENT_NAME, COMMENT_BODY, NOTE_TEXT, 'bob@example.test', 'dave@example.test']
    for (const event of trail.value) {
      const serialized = JSON.stringify(event.detail)
      expect(serialized).not.toContain('@')
      for (const secret of forbidden) {
        expect(serialized, `${event.action} leaked content`).not.toContain(secret)
      }
      for (const value of Object.values(event.detail)) {
        if (typeof value !== 'string') continue
        // Identifier-shaped only: no free text can survive the filter.
        expect(value, `${event.action} carried free text`).toMatch(/^[A-Za-z0-9_.:\/|-]{1,64}$/)
      }
      // The actor is the Hexclave user id, which is an opaque subject, not an
      // address; ownership is never keyed on an email anywhere in this schema.
      expect(event.actorSubject).not.toContain('@')
    }

    // The trail is still useful: it says what happened, in order.
    const actions = trail.value.map((event) => event.action)
    expect(actions).toContain('project.rename')
    expect(actions).toContain('comment.create')
    expect(actions).toContain('invitation.create')
    expect(actions).toContain('transaction.append')
    expect(actions).toContain('member.remove')
  })

  it('drops free text and names the field it dropped', () => {
    const redacted = redactAuditDetail({
      revision: 12,
      soft: true,
      branch: 'conflict/2026-03-04',
      name: "Alice's rover",
      email: 'bob@example.test',
      body: 'a'.repeat(200),
      broken: Number.NaN,
    })
    expect(redacted).toEqual({
      revision: 12,
      soft: true,
      branch: 'conflict/2026-03-04',
      redacted: 'body,broken,email,name',
    })
  })

  it('never stores an email address outside the invitations table', async () => {
    const scene = await claimed('doc_email', CONTENT_NAME)
    await scene.alice.backend.createInvitation({
      projectId: scene.claimed.projectId,
      email: 'erin@example.test',
      role: 'editor',
    })
    const tables: Array<[string, unknown]> = [
      ['projects', scene.deployment.projects],
      ['branches', scene.deployment.branches],
      ['transactions', scene.deployment.transactions],
      ['versions', scene.deployment.versions],
      ['members', scene.deployment.members],
      ['presence', scene.deployment.presence],
      ['comments', scene.deployment.comments],
      ['auditEvents', scene.deployment.auditEvents],
    ]
    for (const [name, rows] of tables) {
      expect(JSON.stringify(rows), `${name} stored an email address`).not.toContain(
        'erin@example.test',
      )
    }
    expect(JSON.stringify(scene.deployment.invitations)).toContain('erin@example.test')
  })

  it('reports an unconfigured delivery rather than claiming an invitation was sent', async () => {
    const scene = await claimed('doc_delivery')
    const invitation = await scene.alice.backend.createInvitation({
      projectId: scene.claimed.projectId,
      email: 'frank@example.test',
      role: 'viewer',
    })
    expect(invitation.ok).toBe(true)
    if (!invitation.ok) return
    expect(invitation.value.deliveryStatus).toBe('not-configured')
    expect(invitation.value.deliveryReason).toContain('INVITATION_EMAIL_ENDPOINT')
    expect(invitation.value.status).toBe('pending')
  })
})
