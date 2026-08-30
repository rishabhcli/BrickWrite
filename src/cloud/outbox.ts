import type { StorageDriver } from '../cad/persistence'
import type { ModelDocument, Transaction } from '../cad/types'
import {
  cloudFailure,
  type CloudBackend,
  type CloudErrorShape,
  type CloudResult,
  type SnapshotUpload,
  type StaleDocumentDetails,
} from './protocol'
import { sendTransactionBatch, transactionBatch } from './batches'
import { checksumOf, snapshotUploadFor, transactionChecksum } from './serialize'

/**
 * The outbox: how a local-first edit reaches the cloud.
 *
 * The order is the whole design. A transaction is committed to IndexedDB first
 * — that is the durability guarantee, and it does not depend on the network —
 * and only then queued here. Nothing in this file can lose an edit, because
 * nothing in this file is where the edit lives.
 *
 * Draining is strictly serial and strictly in order. The deployment refuses any
 * append whose base revision is not the current head, so sending entry N+1
 * before entry N has landed would simply be refused; and a queue that reordered
 * on retry would turn a transient failure into a permanent divergence.
 *
 * There are no timers here. `drain()` is called by whoever owns the schedule,
 * and `nextAttemptAt` says when a retry is due, so the backoff is exercised by
 * tests with a fake clock instead of by waiting.
 */

export type SyncStatus = 'unconfigured' | 'idle' | 'syncing' | 'offline' | 'conflict' | 'error'

export interface SyncState {
  status: SyncStatus
  /** Always populated for every status except `idle`. */
  reason: string | null
  pending: number
  lastSyncedAt: string | null
  lastError: CloudErrorShape | null
  /** Set while `status` is `conflict`: the head the local tail must rebase onto. */
  conflict: StaleDocumentDetails | null
  /** The queue head responsible for a conflict/error, so another project is not blamed. */
  blocked: { projectId: string; localProjectId: string } | null
}

/**
 * The state when there is no deployment at all.
 *
 * Not an error and not a failure: a signed-out or cloud-less browser is a
 * supported way to run the editor, and it reports itself as such. Exported as a
 * value rather than built inside the React hook so it can be asserted without
 * rendering anything.
 */
export const UNCONFIGURED_SYNC_STATE: SyncState = {
  status: 'unconfigured',
  reason: 'No cloud deployment is configured; projects are saved in this browser only.',
  pending: 0,
  lastSyncedAt: null,
  lastError: null,
  conflict: null,
  blocked: null,
}

export type OutboxPayload =
  { kind: 'transaction'; transaction: Transaction } | { kind: 'checkpoint'; snapshot: SnapshotUpload }

export interface OutboxEntry {
  /** `outbox:<zero-padded sequence>` — lexical key order is queue order. */
  key: string
  sequence: number
  /** The cloud project id. Resolved when the entry is enqueued, not when it drains. */
  projectId: string
  localProjectId: string
  payload: OutboxPayload
  /**
   * The document schema and catalogue the payload was produced against. Carried
   * on the entry rather than looked up at drain time: an entry queued yesterday
   * has to be presented with the versions it was actually made under, or the
   * deployment's schema check is checking the wrong thing.
   */
  schemaVersion: number
  catalogVersion: string
  /** Over the payload, so a rewritten or truncated entry is detected on drain. */
  checksum: string
  enqueuedAt: string
  attempts: number
  /** Epoch milliseconds; `drain` skips the queue head until this passes. */
  nextAttemptAt: number
  /** A non-transient refusal is retried only after an explicit recovery signal. */
  parked?: boolean
  lastError: CloudErrorShape | null
}

/**
 * Bounded queue policy.
 *
 * When the queue is full new entries are **refused**, and the oldest are never
 * dropped. Dropping the oldest would break the revision chain every later entry
 * depends on; dropping the newest silently would report a durable cloud copy
 * that does not exist. Refusing is safe because the local log is authoritative
 * and complete either way — the cloud replica simply falls behind, and
 * `backfill()` re-derives the missing tail from local storage once the queue
 * drains.
 */
export const OUTBOX_CAPACITY = 500

export const RETRY_BASE_MS = 1_000
export const RETRY_CEILING_MS = 60_000

const OUTBOX_PREFIX = 'outbox:'
const key = (sequence: number) => `${OUTBOX_PREFIX}${String(sequence).padStart(12, '0')}`

/** Failures that are worth retrying. Everything else needs a human or a rebase. */
const TRANSIENT = new Set(['OFFLINE', 'TRANSPORT_FAILED'])

export interface OutboxOptions {
  /** Injected so backoff is testable without waiting. */
  now?: () => number
  capacity?: number
  baseDelayMs?: number
  ceilingDelayMs?: number
}

export class Outbox {
  private entries: OutboxEntry[] = []
  private sequence = 0
  private hydrated = false
  private draining: Promise<SyncState> | null = null
  private state: SyncState = {
    status: 'idle',
    reason: null,
    pending: 0,
    lastSyncedAt: null,
    lastError: null,
    conflict: null,
    blocked: null,
  }
  private listeners = new Set<(state: SyncState) => void>()
  private readonly now: () => number
  private readonly capacity: number
  private readonly baseDelayMs: number
  private readonly ceilingDelayMs: number

  constructor(
    private readonly driver: StorageDriver,
    private readonly backend: CloudBackend,
    options: OutboxOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.capacity = options.capacity ?? OUTBOX_CAPACITY
    this.baseDelayMs = options.baseDelayMs ?? RETRY_BASE_MS
    this.ceilingDelayMs = options.ceilingDelayMs ?? RETRY_CEILING_MS
  }

  getState(): SyncState {
    return { ...this.state }
  }

  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  private publish(next: Partial<SyncState>) {
    this.state = { ...this.state, ...next, pending: this.entries.length }
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }

  /**
   * Reloads the queue written by a previous page load.
   *
   * Entries live in the existing `meta` object store under an `outbox:` prefix,
   * so this needs no schema change in `src/cad/persistence.ts` — the store is
   * already created by `IndexedDbDriver`, and a prefix range scan over it is
   * exactly the ordered read the queue wants.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return
    const stored = await this.driver.range<OutboxEntry>('meta', OUTBOX_PREFIX)
    this.entries = [...stored].sort((a, b) => a.sequence - b.sequence)
    this.sequence = this.entries.reduce((max, entry) => Math.max(max, entry.sequence), 0)
    this.hydrated = true
    this.publish({ status: this.entries.length > 0 ? 'idle' : 'idle', reason: null })
  }

  get pending(): readonly OutboxEntry[] {
    return this.entries
  }

  private async persist(entry: OutboxEntry) {
    await this.driver.put('meta', entry.key, entry)
  }

  private async forget(entry: OutboxEntry) {
    await this.driver.delete('meta', entry.key)
    this.entries = this.entries.filter((candidate) => candidate.key !== entry.key)
  }

  private async enqueue(
    projectId: string,
    localProjectId: string,
    payload: OutboxPayload,
    version: { schemaVersion: number; catalogVersion: string },
  ): Promise<CloudResult<OutboxEntry>> {
    await this.hydrate()
    if (this.entries.length >= this.capacity) {
      const error: CloudErrorShape = {
        code: 'OUTBOX_FULL',
        message: `The sync queue is holding its limit of ${this.capacity} unsent changes.`,
        repair:
          'Reconnect so the queue can drain. Your work is saved in this browser either way, and `backfill()` re-derives the missing tail from the local log.',
      }
      const head = this.entries[0]
      this.publish({
        status: 'error',
        reason: error.message,
        lastError: error,
        blocked: head
          ? { projectId: head.projectId, localProjectId: head.localProjectId }
          : { projectId, localProjectId },
      })
      return { ok: false, error }
    }
    this.sequence += 1
    const entry: OutboxEntry = {
      key: key(this.sequence),
      sequence: this.sequence,
      projectId,
      localProjectId,
      payload,
      schemaVersion: version.schemaVersion,
      catalogVersion: version.catalogVersion,
      checksum: Outbox.checksumFor(payload),
      enqueuedAt: new Date(this.now()).toISOString(),
      attempts: 0,
      nextAttemptAt: this.now(),
      parked: false,
      lastError: null,
    }
    this.entries.push(entry)
    await this.persist(entry)
    this.publish({})
    return { ok: true, value: entry }
  }

  queueTransaction(
    projectId: string,
    document: ModelDocument,
    transaction: Transaction,
  ): Promise<CloudResult<OutboxEntry>> {
    return this.enqueue(projectId, document.id, { kind: 'transaction', transaction }, document)
  }

  queueCheckpoint(projectId: string, document: ModelDocument): Promise<CloudResult<OutboxEntry>> {
    const snapshot = snapshotUploadFor(document)
    return this.enqueue(projectId, document.id, { kind: 'checkpoint', snapshot }, document)
  }

  /** Epoch milliseconds at which the head of the queue may next be attempted. */
  get nextAttemptAt(): number | null {
    return this.entries[0]?.nextAttemptAt ?? null
  }

  /**
   * Sends what it can, in order, and stops at the first entry it cannot send.
   *
   * Concurrent calls collapse onto the in-flight drain rather than racing: two
   * drains would interleave appends and produce exactly the stale-write storm
   * the ordering is there to prevent.
   */
  drain(): Promise<SyncState> {
    this.draining ??= this.runDrain().finally(() => {
      this.draining = null
    })
    return this.draining
  }

  private async runDrain(): Promise<SyncState> {
    await this.hydrate()
    if (this.entries.length === 0) {
      this.publish({ status: 'idle', reason: null, lastError: null, conflict: null, blocked: null })
      return this.getState()
    }
    this.publish({
      status: 'syncing',
      reason: `Sending ${this.entries.length} change(s).`,
      lastError: null,
      conflict: null,
      blocked: null,
    })

    while (this.entries.length > 0) {
      const entry = this.entries[0]
      if (entry.parked) {
        const conflict = entry.lastError?.code === 'STALE_DOCUMENT'
        this.publish({
          status: conflict ? 'conflict' : 'error',
          reason: entry.lastError?.message ?? 'A queued change needs attention.',
          lastError: entry.lastError,
          conflict: conflict ? ((entry.lastError?.details as StaleDocumentDetails | undefined) ?? null) : null,
          blocked: { projectId: entry.projectId, localProjectId: entry.localProjectId },
        })
        return this.getState()
      }
      if (entry.nextAttemptAt > this.now()) {
        this.publish({
          status: 'offline',
          reason: entry.lastError?.message ?? 'Waiting to retry.',
        })
        return this.getState()
      }

      const { verdict, sent } = await this.sendNext()
      if (verdict.ok) {
        try {
          // Delete only verified receipts. If local persistence fails part-way,
          // remaining ids are safe to retry after reload or the next drain.
          for (const acknowledged of sent) await this.forget(acknowledged)
        } catch {
          const pending = this.entries[0]
          if (pending) {
            pending.attempts += 1
            pending.nextAttemptAt =
              this.now() + Math.min(this.baseDelayMs * 2 ** Math.min(pending.attempts - 1, 16), this.ceilingDelayMs)
          }
          const failure = cloudFailure(
            'TRANSPORT_FAILED',
            'The cloud saved the edits, but this browser could not persist their acknowledgements.',
            'Retry after local storage recovers; the original ids prevent duplicate edits.',
          )
          this.publish({
            status: 'error',
            reason: failure.error.message,
            lastError: failure.error,
            blocked: pending ? { projectId: pending.projectId, localProjectId: pending.localProjectId } : null,
          })
          return this.getState()
        }
        this.publish({
          status: this.entries.length > 0 ? 'syncing' : 'idle',
          reason: this.entries.length > 0 ? `Sending ${this.entries.length} change(s).` : null,
          lastSyncedAt: new Date(this.now()).toISOString(),
          lastError: null,
          conflict: null,
          blocked: null,
        })
        continue
      }

      const error = verdict.error
      entry.attempts += 1
      entry.lastError = error

      if (error.code === 'STALE_DOCUMENT') {
        // Not a transport failure and not retryable by repetition: the cloud has
        // moved on. The entry stays queued, untouched, until `rebase.ts` decides
        // what to do with it. Nothing is discarded here.
        entry.parked = true
        await this.persist(entry)
        this.publish({
          status: 'conflict',
          reason: error.message,
          lastError: error,
          conflict: (error.details as StaleDocumentDetails | undefined) ?? null,
          blocked: { projectId: entry.projectId, localProjectId: entry.localProjectId },
        })
        return this.getState()
      }

      if (TRANSIENT.has(error.code)) {
        const delay = Math.min(this.baseDelayMs * 2 ** Math.min(entry.attempts - 1, 16), this.ceilingDelayMs)
        entry.nextAttemptAt = this.now() + delay
        await this.persist(entry)
        this.publish({
          status: 'offline',
          reason: `${error.message} Retrying in ${Math.round(delay / 1000)}s.`,
          lastError: error,
        })
        return this.getState()
      }

      // Permanent: too large, refused, malformed. The queue stops rather than
      // skipping, because every later entry is built on this one's revision.
      // The entry is kept so an operator can see exactly what is stuck.
      entry.parked = true
      await this.persist(entry)
      this.publish({
        status: 'error',
        reason: error.message,
        lastError: error,
        conflict: null,
        blocked: { projectId: entry.projectId, localProjectId: entry.localProjectId },
      })
      return this.getState()
    }

    this.publish({ status: 'idle', reason: null, lastError: null, conflict: null, blocked: null })
    return this.getState()
  }

  /** Batches adjacent ready edits only: never across a checkpoint, project,
   * local history, schema/catalogue boundary, parked item, or revision gap. */
  private async sendNext(): Promise<{ verdict: CloudResult<null>; sent: OutboxEntry[] }> {
    const first = this.entries[0]
    if (first.payload.kind !== 'transaction' || !this.backend.appendTransactions) {
      return { verdict: await this.send(first), sent: [first] }
    }
    const candidates: OutboxEntry[] = []
    const payloads = []
    let revision = first.payload.transaction.baseRevision
    for (const entry of this.entries) {
      if (
        entry.payload.kind !== 'transaction' ||
        entry.projectId !== first.projectId ||
        entry.localProjectId !== first.localProjectId ||
        entry.schemaVersion !== first.schemaVersion ||
        entry.catalogVersion !== first.catalogVersion ||
        entry.parked ||
        entry.nextAttemptAt > this.now() ||
        entry.payload.transaction.baseRevision !== revision ||
        transactionChecksum(entry.payload.transaction) !== entry.checksum
      )
        break
      const transaction = entry.payload.transaction
      candidates.push(entry)
      payloads.push({
        clientTransactionId: transaction.id,
        baseRevision: transaction.baseRevision,
        resultRevision: transaction.resultRevision,
        transaction,
        checksum: entry.checksum,
        schemaVersion: entry.schemaVersion,
        catalogVersion: entry.catalogVersion,
      })
      revision = transaction.resultRevision
    }
    if (!candidates.length) return { verdict: await this.send(first), sent: [first] }
    const batch = transactionBatch({ projectId: first.projectId }, payloads, true)
    const result = await sendTransactionBatch(this.backend, batch)
    // A definitive data refusal wrote nothing. Send just the first edit to
    // isolate a bad later entry, rather than blaming/discarding a valid head.
    if (
      !result.ok &&
      batch.transactions.length > 1 &&
      ['INVALID_ARGUMENT', 'CHECKSUM_MISMATCH', 'SCHEMA_MISMATCH', 'PAYLOAD_TOO_LARGE'].includes(result.error.code)
    ) {
      return { verdict: await this.send(first), sent: [first] }
    }
    return {
      verdict: result.ok ? { ok: true, value: null } : result,
      sent: candidates.slice(0, batch.transactions.length),
    }
  }

  private async send(entry: OutboxEntry): Promise<CloudResult<null>> {
    if (entry.payload.kind === 'checkpoint') {
      const result = await this.backend.saveCheckpoint({
        projectId: entry.projectId,
        snapshot: entry.payload.snapshot,
      })
      return result.ok ? { ok: true, value: null } : result
    }

    const transaction = entry.payload.transaction
    // The checksum is verified before the entry is sent, not after: an entry
    // that changed while it sat in storage must not be presented to the
    // deployment as the transaction the operator committed.
    if (transactionChecksum(transaction) !== entry.checksum) {
      return cloudFailure(
        'CHECKSUM_MISMATCH',
        'A queued change no longer matches the checksum it was queued with.',
        'Discard the queue entry and re-derive it from the local transaction log.',
        { key: entry.key },
      )
    }
    const result = await sendTransactionBatch(this.backend, {
      projectId: entry.projectId,
      transactions: [
        {
          clientTransactionId: transaction.id,
          baseRevision: transaction.baseRevision,
          resultRevision: transaction.resultRevision,
          transaction,
          checksum: entry.checksum,
          schemaVersion: entry.schemaVersion,
          catalogVersion: entry.catalogVersion,
        },
      ],
    })
    return result.ok ? { ok: true, value: null } : result
  }

  /**
   * Clears the retry timers and drains immediately.
   *
   * Exponential backoff is the right answer to repeated failures with no new
   * information. A reconnect *is* new information — the browser has just told
   * us the network is back — so continuing to sit out a sixty-second window
   * after that would be waiting for nothing. Attempt counts are kept, so a
   * connection that flaps still backs off between genuine failures.
   */
  async reconnected(): Promise<SyncState> {
    await this.hydrate()
    const at = this.now()
    for (const entry of this.entries) {
      const code = entry.lastError?.code
      // Permanent refusals stay parked until the operator retries or discards.
      // Stale heads still unpark: reconnect is the recovery signal the conflict
      // UI uses, and a later drain re-parks them if the cloud has not moved.
      if (entry.parked && code && !TRANSIENT.has(code) && code !== 'STALE_DOCUMENT') continue
      const wasParked = entry.parked === true
      entry.parked = false
      if (entry.nextAttemptAt > at) {
        entry.nextAttemptAt = at
      }
      if (wasParked || entry.nextAttemptAt === at) await this.persist(entry)
    }
    return this.drain()
  }

  /** Retries the current head after re-authentication or an out-of-band repair. */
  async retryHead(): Promise<SyncState> {
    await this.hydrate()
    const entry = this.entries[0]
    if (!entry) return this.drain()
    entry.parked = false
    entry.nextAttemptAt = this.now()
    entry.lastError = null
    await this.persist(entry)
    return this.drain()
  }

  /**
   * Drops the head of the queue.
   *
   * The only way past a permanently refused entry, and deliberately explicit:
   * an automatic skip would silently produce a cloud replica missing a
   * transaction the local log still has, which is the one outcome this whole
   * design exists to prevent. The local log keeps the edit either way.
   */
  async discardHead(): Promise<CloudResult<OutboxEntry | null>> {
    await this.hydrate()
    const entry = this.entries[0]
    if (!entry) return { ok: true, value: null }
    await this.forget(entry)
    this.publish({ status: 'idle', reason: null, lastError: null, conflict: null, blocked: null })
    return { ok: true, value: entry }
  }

  /** Forgets every queued entry for a project, for when its replica is deleted. */
  async clearProject(projectId: string): Promise<void> {
    await this.hydrate()
    for (const entry of [...this.entries]) {
      if (entry.projectId === projectId || entry.localProjectId === projectId) {
        await this.forget(entry)
      }
    }
    this.publish({})
  }

  /** Checksum over a payload, exposed so a caller can verify an entry it read. */
  static checksumFor(payload: OutboxPayload): string {
    return payload.kind === 'transaction' ? transactionChecksum(payload.transaction) : payload.snapshot.checksum
  }

  /** Digest of the whole queue, for a "is my work sent?" indicator. */
  fingerprint(): string {
    return checksumOf(this.entries.map((entry) => [entry.sequence, entry.checksum]))
  }
}

/**
 * Drives `drain()` on a timer.
 *
 * Separate from the queue so the queue stays synchronous to reason about and
 * trivially testable. Returns a stop function; the caller owns the lifetime.
 */
export function startAutoDrain(outbox: Outbox, intervalMs = 2_000): () => void {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void outbox.drain()
  }, intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
