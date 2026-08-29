import { CHECKPOINT_INTERVAL, type StorageDriver } from '../cad/persistence'
import type { ModelDocument, Transaction } from '../cad/types'
import { Outbox, startAutoDrain, type SyncState } from './outbox'
import {
  CloudProjectStore,
  LocalProjectStore,
  MirroredProjectStore,
  type StoredProjectSummary,
} from './projectStore'
import type { CloudBackend, CloudResult, ProjectVisibility } from './protocol'
import type { ClaimOutcome } from './claim'

/**
 * Attaching the cloud layer to a running editor.
 *
 * The whole integration, so that wiring it up is six lines in the shell rather
 * than a rewrite of the session. Two rules make it safe to bolt on:
 *
 *   1. It never writes to local storage. `ProjectAutosave` in
 *      `src/cad/persistence.ts` already appends every committed transaction and
 *      checkpoints on its own schedule; a second writer on the same log would
 *      duplicate entries and race the checkpoint sweep. This layer only ever
 *      *queues* what autosave has already made durable.
 *   2. It does nothing at all for a project that has not been claimed. An
 *      unclaimed project has no replica to fall behind, so there is nothing to
 *      queue and no state to report beyond `idle`.
 *
 * Checkpoints are queued on the same cadence as the local ones, so replay on the
 * cloud side stays bounded for the same reason it does locally.
 */

export interface CloudSyncHandle {
  store: MirroredProjectStore
  outbox: Outbox
  /** Current sync state, for a status line. */
  state(): SyncState
  subscribe(listener: (state: SyncState) => void): () => void
  /** Claims the open project into the cloud, after which commits are queued. */
  claim(
    localProjectId: string,
    options?: { name?: string; visibility?: ProjectVisibility },
  ): Promise<CloudResult<ClaimOutcome>>
  /** Local projects, tagged with whether each has a cloud replica. */
  listProjects(): Promise<CloudResult<StoredProjectSummary[]>>
  /** Call when the browser reports the network is back. */
  reconnected(): Promise<SyncState>
  /** Explicit retry after re-authentication or an out-of-band permission repair. */
  retryHead(): Promise<SyncState>
  /**
   * Awaits every commit announced so far reaching the queue.
   *
   * The relay is asynchronous — it reads the project link before it can know
   * which replica an edit belongs to — so "the editor has committed" and "the
   * queue has the edit" are different moments. This is how a caller waits for
   * the second one, before closing a tab or asserting in a test.
   */
  flush(): Promise<void>
  detach(): void
}

export interface AttachCloudSyncOptions {
  /** The same driver the session uses, so one IndexedDB connection is shared. */
  driver: StorageDriver
  backend: CloudBackend
  /** `cadEngine.onCommit`. Passed in so this module never imports the kernel singleton. */
  onCommit: (
    listener: (transaction: Transaction, document: ModelDocument) => void,
  ) => () => void
  /** Poll interval for the drain loop; 0 disables it, for tests. */
  autoDrainMs?: number
  checkpointInterval?: number
}

export function attachCloudSync(options: AttachCloudSyncOptions): CloudSyncHandle {
  const local = new LocalProjectStore(options.driver)
  const cloud = new CloudProjectStore(options.backend)
  const outbox = new Outbox(options.driver, options.backend)
  const store = new MirroredProjectStore(local, cloud, outbox, options.backend)
  const interval = options.checkpointInterval ?? CHECKPOINT_INTERVAL

  // Per project, because the checkpoint cadence belongs to one log; carrying a
  // count across a project switch would checkpoint the incoming project on a
  // schedule the outgoing one earned.
  const sinceCheckpoint = new Map<string, number>()
  let queue: Promise<void> = Promise.resolve()

  const detachCommit = options.onCommit((transaction, document) => {
    // Serialized so queue order always matches commit order, exactly as
    // `ProjectAutosave` serializes its appends.
    queue = queue
      .then(async () => {
        const link = await store.links.get(document.id)
        if (!link) return
        const queued = await outbox.queueTransaction(link.cloudProjectId, document, transaction)
        if (!queued.ok) return
        const pending = (sinceCheckpoint.get(document.id) ?? 0) + 1
        if (pending >= interval) {
          const checkpoint = await outbox.queueCheckpoint(link.cloudProjectId, document)
          if (!checkpoint.ok) return
          sinceCheckpoint.set(document.id, 0)
        } else {
          sinceCheckpoint.set(document.id, pending)
        }
      })
      .catch(() => {
        // A queue failure is already reported through the sync state with a
        // reason. It must not become an unhandled rejection, and it must not
        // stop the editor: the transaction is durable locally either way.
      })
  })

  const stopDraining =
    options.autoDrainMs === 0 ? () => {} : startAutoDrain(outbox, options.autoDrainMs)

  return {
    store,
    outbox,
    state: () => outbox.getState(),
    subscribe: (listener) => outbox.subscribe(listener),
    claim: (localProjectId, claimOptions) => store.claim(localProjectId, claimOptions),
    listProjects: () => store.listProjects(),
    reconnected: () => outbox.reconnected(),
    retryHead: () => outbox.retryHead(),
    flush: () => queue,
    detach() {
      detachCommit()
      stopDraining()
    },
  }
}

/** Flushes the relay and reports the resulting sync state. */
export async function settled(handle: CloudSyncHandle): Promise<SyncState> {
  await handle.flush()
  return handle.outbox.getState()
}
