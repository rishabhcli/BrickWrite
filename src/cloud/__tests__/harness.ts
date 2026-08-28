import { CadEngine } from '../../cad/engine'
import { IDENTITY_BASIS } from '../../cad/math'
import { MemoryDriver } from '../../cad/persistence'
import { createEmptyDocument } from '../../cad/sample'
import type { CadOperation, ModelDocument, PartInstance, Transaction } from '../../cad/types'
import { Outbox } from '../outbox'
import { CloudProjectStore, LocalProjectStore, MirroredProjectStore } from '../projectStore'
import type { CloudBackend, CloudRole } from '../protocol'
import { FakeConvexDeployment, type FakeIdentity } from './fakeBackend'

/**
 * Fixtures for the cloud acceptance suite.
 *
 * Histories are produced by the real `CadEngine`, not hand-written: the whole
 * point of these gates is that the cloud handles the transactions the editor
 * actually emits, including their patches, inverses and touched sets. A
 * hand-rolled `Transaction` would prove that the cloud handles hand-rolled
 * transactions.
 */

export const part = (
  id: string,
  position: [number, number, number] = [0, 0, 0],
  overrides: Partial<PartInstance> = {},
): PartInstance => ({
  id,
  definitionId: '3001',
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
  ...overrides,
})

export interface History {
  transactions: Transaction[]
  /** Document state after each commit, as autosave would see it. */
  documents: ModelDocument[]
  final: ModelDocument
}

/**
 * Runs batches of operations through a real engine seeded at `base`.
 *
 * Each batch becomes one transaction, committed against the revision the
 * previous batch produced, so the result is a genuine, replayable log.
 */
export function commitAll(base: ModelDocument, batches: CadOperation[][]): History {
  const engine = new CadEngine(base)
  const transactions: Transaction[] = []
  const documents: ModelDocument[] = []
  for (const [index, operations] of batches.entries()) {
    const revision = engine.getSnapshot().document.revision
    const result = engine.execute(`Edit ${index + 1}`, operations, 'human', revision)
    if (!result.ok) {
      throw new Error(`Fixture batch ${index} was refused: ${result.error.code} ${result.error.message}`)
    }
    transactions.push(result.value)
    documents.push(engine.getSnapshot().document)
  }
  return { transactions, documents, final: engine.getSnapshot().document }
}

/** A document with `id`, at revision 0, ready to be checkpointed. */
export function blankProject(id: string, name = 'Test build'): ModelDocument {
  return { ...createEmptyDocument(), id, name }
}

/** A history of `count` single-part placements, one part per transaction. */
export function placements(base: ModelDocument, ids: readonly string[]): History {
  return commitAll(
    base,
    ids.map((id, index) => [{ type: 'part.add', part: part(id, [index * 100, 0, 0]) }] as CadOperation[]),
  )
}

export const ALICE: FakeIdentity = { subject: 'hexclave|alice', displayName: 'Alice' }
export const BOB: FakeIdentity = { subject: 'hexclave|bob', displayName: 'Bob' }
export const CAROL: FakeIdentity = { subject: 'hexclave|carol', displayName: 'Carol' }

export interface Harness {
  driver: MemoryDriver
  local: LocalProjectStore
  deployment: FakeConvexDeployment
  identity: FakeIdentity
  backend: CloudBackend
  cloud: CloudProjectStore
  outbox: Outbox
  store: MirroredProjectStore
  /** Mutable so a test can advance the outbox's clock past a backoff window. */
  clock: { now: number }
}

/**
 * A whole local-first stack over one shared fake deployment.
 *
 * The outbox clock is injected and never advances by itself, so backoff is
 * exercised by moving `clock.now` rather than by waiting.
 */
export function makeHarness(
  identity: FakeIdentity = ALICE,
  deployment = new FakeConvexDeployment(),
  driver = new MemoryDriver(),
): Harness {
  const clock = { now: Date.UTC(2026, 0, 1) }
  const backend = deployment.as(identity)
  const local = new LocalProjectStore(driver)
  const cloud = new CloudProjectStore(backend)
  const outbox = new Outbox(driver, backend, { now: () => clock.now })
  const store = new MirroredProjectStore(local, cloud, outbox, backend)
  return { driver, local, deployment, identity, backend, cloud, outbox, store, clock }
}

/**
 * Adds a collaborator through the real invitation flow.
 *
 * Deliberately not by pushing a row into the members table: acceptance has to
 * go through a token redeemed by the invitee's own identity, and a helper that
 * skipped that would let the authorisation gates pass against a membership no
 * real user could obtain.
 */
export async function addMember(
  deployment: FakeConvexDeployment,
  ownerBackend: CloudBackend,
  projectId: string,
  invitee: FakeIdentity,
  role: Exclude<CloudRole, 'owner'>,
): Promise<void> {
  const invitation = await ownerBackend.createInvitation({
    projectId,
    email: `${invitee.subject.split('|').pop()}@example.test`,
    role,
  })
  if (!invitation.ok) throw new Error(`Invitation refused: ${invitation.error.message}`)
  const row = deployment.invitations.find((entry) => entry._id === invitation.value.invitationId)
  if (!row) throw new Error('The invitation was not stored.')
  const accepted = await deployment.as(invitee).acceptInvitation({ token: row.token })
  if (!accepted.ok) throw new Error(`Acceptance refused: ${accepted.error.message}`)
}

/** Seeds a claimed project: local checkpoint, cloud replica, recorded link. */
export async function claimedProject(
  harness: Harness,
  localProjectId = 'doc_test',
): Promise<{ document: ModelDocument; cloudProjectId: string; branchId: string }> {
  const document = blankProject(localProjectId)
  const saved = await harness.local.saveCheckpoint(document)
  if (!saved.ok) throw new Error('The local checkpoint was refused.')
  const claimed = await harness.store.claim(localProjectId)
  if (!claimed.ok) throw new Error(`Claim refused: ${claimed.error.message}`)
  return {
    document,
    cloudProjectId: claimed.value.projectId,
    branchId: claimed.value.branchId,
  }
}
