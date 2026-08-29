import { applyMutations } from './patch'
import type { ModelDocument, Transaction } from './types'

/**
 * Local-first project persistence.
 *
 * A project is stored as a periodic **checkpoint** plus the **transaction log**
 * that follows it, rather than as one document blob rewritten on every edit.
 * That shape gives crash recovery, an auditable history of who changed what, and
 * a write cost proportional to the edit instead of to the model.
 *
 * The storage driver is abstracted so the repository logic is exercised in unit
 * tests without an IndexedDB polyfill, while the browser uses real IndexedDB.
 * The real driver is covered by the browser acceptance run.
 */

export const SCHEMA_VERSION = 2

/** How many transactions may follow a checkpoint before a new one is written. */
export const CHECKPOINT_INTERVAL = 50

export interface StoredCheckpoint {
  projectId: string
  revision: number
  savedAt: string
  document: ModelDocument
}

export interface StoredTransaction {
  /** `${projectId}:${revision}` — ordered lexically within a project. */
  key: string
  projectId: string
  resultRevision: number
  transaction: Transaction
}

export interface ProjectSummary {
  projectId: string
  name: string
  revision: number
  savedAt: string
  partCount: number
}

/** Minimal key/value surface the repository needs from a storage driver. */
export interface StorageDriver {
  get<T>(table: string, key: string): Promise<T | undefined>
  put<T>(table: string, key: string, value: T): Promise<void>
  delete(table: string, key: string): Promise<void>
  /** One transaction covering every key, so checkpoint cleanup is not N writes. */
  deleteMany(table: string, keys: string[]): Promise<void>
  /** Keys in a table, so a listing can detect missing summaries without loading documents. */
  keys(table: string): Promise<string[]>
  /** Values whose key starts with `prefix`, in ascending key order. */
  range<T>(table: string, prefix: string): Promise<T[]>
  all<T>(table: string): Promise<T[]>
  clear(table: string): Promise<void>
}

export const TABLES = ['checkpoints', 'transactions', 'meta'] as const

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export class MemoryDriver implements StorageDriver {
  private tables = new Map<string, Map<string, unknown>>()

  private table(name: string) {
    const existing = this.tables.get(name)
    if (existing) return existing
    const created = new Map<string, unknown>()
    this.tables.set(name, created)
    return created
  }

  async get<T>(table: string, key: string) {
    return this.table(table).get(key) as T | undefined
  }

  async put<T>(table: string, key: string, value: T) {
    this.table(table).set(key, value)
  }

  async delete(table: string, key: string) {
    this.table(table).delete(key)
  }

  async deleteMany(table: string, keys: string[]) {
    const store = this.table(table)
    for (const key of keys) store.delete(key)
  }

  async keys(table: string) {
    return [...this.table(table).keys()]
  }

  async range<T>(table: string, prefix: string) {
    return [...this.table(table).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value as T)
  }

  async all<T>(table: string) {
    return [...this.table(table).values()] as T[]
  }

  async clear(table: string) {
    this.table(table).clear()
  }
}

/**
 * IndexedDB driver.
 *
 * Each table is an object store with out-of-line keys, so the repository owns
 * key construction and range scans work on the natural key order.
 */
export class IndexedDbDriver implements StorageDriver {
  private database: Promise<IDBDatabase> | null = null

  constructor(private readonly name = 'brickwright', private readonly version = SCHEMA_VERSION) {}

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, this.version)
      request.onupgradeneeded = () => {
        const database = request.result
        for (const table of TABLES) {
          if (!database.objectStoreNames.contains(table)) database.createObjectStore(table)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    })
    return this.database
  }

  private async run<T>(table: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const database = await this.open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(table, mode)
      const request = work(transaction.objectStore(table))
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    })
  }

  get<T>(table: string, key: string) {
    return this.run<T | undefined>(table, 'readonly', (store) => store.get(key))
  }

  async put<T>(table: string, key: string, value: T) {
    await this.run(table, 'readwrite', (store) => store.put(value, key))
  }

  async delete(table: string, key: string) {
    await this.run(table, 'readwrite', (store) => store.delete(key))
  }

  async deleteMany(table: string, keys: string[]) {
    if (!keys.length) return
    const database = await this.open()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(table, 'readwrite')
      const store = transaction.objectStore(table)
      for (const key of keys) store.delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB deleteMany failed'))
    })
  }

  async keys(table: string) {
    const raw = await this.run<IDBValidKey[]>(table, 'readonly', (store) => store.getAllKeys())
    return raw.map(String)
  }

  range<T>(table: string, prefix: string) {
    // `prefix￿` is the largest string sharing the prefix, so this bounds the
    // scan to one project's keys instead of walking the whole log.
    const bound = IDBKeyRange.bound(prefix, `${prefix}￿`)
    return this.run<T[]>(table, 'readonly', (store) => store.getAll(bound))
  }

  all<T>(table: string) {
    return this.run<T[]>(table, 'readonly', (store) => store.getAll())
  }

  async clear(table: string) {
    await this.run(table, 'readwrite', (store) => store.clear())
  }
}

/** True when the environment can back a real IndexedDB driver. */
export const indexedDbAvailable = () => typeof indexedDB !== 'undefined'

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface LoadedProject {
  document: ModelDocument
  /** Transactions replayed on top of the checkpoint, oldest first. */
  replayed: Transaction[]
  checkpointRevision: number
}

const SUMMARY_PREFIX = 'summary:'

function summaryFromCheckpoint(checkpoint: StoredCheckpoint): ProjectSummary {
  return {
    projectId: checkpoint.projectId,
    name: checkpoint.document.name,
    revision: checkpoint.revision,
    savedAt: checkpoint.savedAt,
    partCount: Object.keys(checkpoint.document.parts).length,
  }
}

export class ProjectRepository {
  constructor(private readonly driver: StorageDriver) {}

  private transactionKey(projectId: string, revision: number) {
    // Zero-padded so lexical key order matches revision order.
    return `${projectId}:${String(revision).padStart(12, '0')}`
  }

  async saveCheckpoint(document: ModelDocument): Promise<void> {
    const checkpoint: StoredCheckpoint = {
      projectId: document.id,
      revision: document.revision,
      savedAt: new Date().toISOString(),
      document,
    }
    await this.driver.put('checkpoints', document.id, checkpoint)
    await this.driver.put('meta', `${SUMMARY_PREFIX}${document.id}`, summaryFromCheckpoint(checkpoint))
    // Everything up to the checkpoint is now redundant.
    const stale = await this.driver.range<StoredTransaction>('transactions', `${document.id}:`)
    await this.driver.deleteMany(
      'transactions',
      stale.filter((entry) => entry.resultRevision <= document.revision).map((entry) => entry.key),
    )
  }

  async appendTransaction(projectId: string, transaction: Transaction): Promise<void> {
    const key = this.transactionKey(projectId, transaction.resultRevision)
    const record: StoredTransaction = { key, projectId, resultRevision: transaction.resultRevision, transaction }
    await this.driver.put('transactions', key, record)
  }

  /**
   * Rebuilds a project from its checkpoint plus every later transaction.
   *
   * A log entry whose base revision does not match the document in hand is not
   * applied: replaying out of order would produce a document no operator ever
   * saw. The load stops there and reports what it managed to restore.
   */
  async loadProject(projectId: string): Promise<LoadedProject | null> {
    const checkpoint = await this.driver.get<StoredCheckpoint>('checkpoints', projectId)
    if (!checkpoint) return null

    let document = checkpoint.document
    const replayed: Transaction[] = []
    const log = await this.driver.range<StoredTransaction>('transactions', `${projectId}:`)

    for (const entry of log) {
      const { transaction } = entry
      if (transaction.resultRevision <= document.revision) continue
      if (!transaction.patch || transaction.patch.baseRevision !== document.revision) break
      document = applyMutations(document, transaction.patch.forward)
      document = { ...document, revision: transaction.resultRevision, updatedAt: transaction.timestamp }
      replayed.push(transaction)
    }

    return { document, replayed, checkpointRevision: checkpoint.revision }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const summaries = await this.driver.range<ProjectSummary>('meta', SUMMARY_PREFIX)
    const checkpointIds = await this.driver.keys('checkpoints')
    const known = new Map(summaries.map((summary) => [summary.projectId, summary]))
    if (known.size !== checkpointIds.length) {
      for (const projectId of checkpointIds) {
        if (known.has(projectId)) continue
        const checkpoint = await this.driver.get<StoredCheckpoint>('checkpoints', projectId)
        if (!checkpoint) continue
        const summary = summaryFromCheckpoint(checkpoint)
        await this.driver.put('meta', `${SUMMARY_PREFIX}${projectId}`, summary)
        known.set(projectId, summary)
      }
    }
    return checkpointIds
      .map((projectId) => known.get(projectId))
      .filter((summary): summary is ProjectSummary => Boolean(summary))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.driver.delete('checkpoints', projectId)
    await this.driver.delete('meta', `${SUMMARY_PREFIX}${projectId}`)
    const log = await this.driver.range<StoredTransaction>('transactions', `${projectId}:`)
    await this.driver.deleteMany('transactions', log.map((entry) => entry.key))
  }

  /** Transactions currently pending on top of the checkpoint. */
  async pendingTransactionCount(projectId: string): Promise<number> {
    const checkpoint = await this.driver.get<StoredCheckpoint>('checkpoints', projectId)
    const log = await this.driver.range<StoredTransaction>('transactions', `${projectId}:`)
    const from = checkpoint?.revision ?? 0
    return log.filter((entry) => entry.resultRevision > from).length
  }

  async readCheckpoint(projectId: string): Promise<StoredCheckpoint | undefined> {
    return this.driver.get<StoredCheckpoint>('checkpoints', projectId)
  }

  /** Log entries above `afterRevision`, oldest first. */
  async listTransactions(projectId: string, afterRevision = 0): Promise<StoredTransaction[]> {
    const log = await this.driver.range<StoredTransaction>('transactions', `${projectId}:`)
    return log
      .filter((entry) => entry.resultRevision > afterRevision)
      .sort((a, b) => a.resultRevision - b.resultRevision)
  }
}

/**
 * Autosave policy.
 *
 * Every committed transaction is appended immediately — that is the durability
 * guarantee — and a fresh checkpoint is written once the log grows past
 * `CHECKPOINT_INTERVAL`, so replay on open stays bounded.
 */
export class ProjectAutosave {
  private pending = 0
  private queue: Promise<void> = Promise.resolve()
  private lastError: string | null = null

  constructor(
    private readonly repository: ProjectRepository,
    private readonly interval = CHECKPOINT_INTERVAL,
  ) {}

  get error(): string | null {
    return this.lastError
  }

  /** Serializes writes so log order always matches commit order. */
  record(document: ModelDocument, transaction: Transaction): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        await this.repository.appendTransaction(document.id, transaction)
        this.pending += 1
        if (this.pending >= this.interval) {
          await this.repository.saveCheckpoint(document)
          this.pending = 0
        }
        this.lastError = null
      })
      .catch((cause: unknown) => {
        // Persistence is best-effort: a quota or privacy-mode failure must not
        // take the editor down, but it must be visible rather than swallowed.
        this.lastError = cause instanceof Error ? cause.message : String(cause)
      })
    return this.queue
  }

  async checkpointNow(document: ModelDocument): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        await this.repository.saveCheckpoint(document)
        this.pending = 0
        this.lastError = null
      })
      .catch((cause: unknown) => {
        this.lastError = cause instanceof Error ? cause.message : String(cause)
      })
    return this.queue
  }

  async settled(): Promise<void> {
    await this.queue
  }

  /**
   * Forgets the pending count, for when the editor moves to another project.
   *
   * The counter paces checkpoints for one log. Carrying it across a project
   * switch would checkpoint the incoming project on a schedule earned by the
   * outgoing one.
   */
  reset(): void {
    this.pending = 0
    this.lastError = null
  }
}

/**
 * The storage driver this environment can back.
 *
 * Published separately because the cloud relay keeps its outbox and project
 * links in the existing `meta` store. Sharing one driver prevents two layers
 * from racing separate IndexedDB connections while local autosave remains the
 * sole writer of checkpoints and transactions.
 */
export const createDriver = (): StorageDriver =>
  indexedDbAvailable() ? new IndexedDbDriver() : new MemoryDriver()

export const createRepository = (driver: StorageDriver = createDriver()) =>
  new ProjectRepository(driver)
