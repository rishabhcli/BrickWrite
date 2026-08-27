import { catalog } from './catalog'
import { cadEngine } from './engine'
import {
  createRepository,
  indexedDbAvailable,
  ProjectAutosave,
  type ProjectRepository,
  type ProjectSummary,
} from './persistence'
import { loadLocalDocument, clearLocalDocument } from './storage'
import type { ModelDocument } from './types'

/**
 * Session wiring: ties the CAD kernel to durable local storage.
 *
 * The kernel knows nothing about persistence. This layer subscribes to committed
 * transactions, appends them to the log, and periodically checkpoints. Restore
 * happens once at boot, before the editor mounts, so the operator never sees the
 * showcase flash past their own project.
 */

export interface SessionRestore {
  source: 'indexeddb' | 'legacy-localstorage' | 'showcase'
  revision: number
  partCount: number
  replayedTransactions: number
  /** Present when a project was found but could not be fully restored. */
  warning?: string
}

export interface SessionStatus {
  durable: boolean
  restore: SessionRestore | null
  error: string | null
}

class Session {
  private repository: ProjectRepository = createRepository()
  private autosave = new ProjectAutosave(this.repository)
  private restore: SessionRestore | null = null
  private detach: (() => void) | null = null

  get status(): SessionStatus {
    return {
      durable: indexedDbAvailable(),
      restore: this.restore,
      error: this.autosave.error,
    }
  }

  /**
   * Restores the most recent project and starts autosaving.
   *
   * A document written by the pre-IndexedDB build is migrated rather than
   * discarded: losing an operator's work to a storage upgrade is not an
   * acceptable outcome of shipping one.
   */
  async start(): Promise<SessionRestore> {
    this.restore = await this.load()
    this.detach?.()
    this.detach = cadEngine.onCommit((transaction, document) => {
      void this.autosave.record(document, transaction)
    })
    return this.restore
  }

  private async load(): Promise<SessionRestore> {
    const current = cadEngine.getSnapshot().document
    try {
      const projects = await this.repository.listProjects()
      const newest = projects[0]
      if (newest) {
        const loaded = await this.repository.loadProject(newest.projectId)
        if (loaded && this.usable(loaded.document)) {
          cadEngine.replaceDocument(loaded.document)
          return {
            source: 'indexeddb',
            revision: loaded.document.revision,
            partCount: Object.keys(loaded.document.parts).length,
            replayedTransactions: loaded.replayed.length,
          }
        }
        if (loaded) {
          return {
            source: 'showcase',
            revision: current.revision,
            partCount: Object.keys(current.parts).length,
            replayedTransactions: 0,
            warning: `Stored project "${newest.name}" references parts this catalog revision cannot place; it was left untouched.`,
          }
        }
      }

      const legacy = loadLocalDocument()
      if (legacy && this.usable(legacy)) {
        cadEngine.replaceDocument(legacy)
        // Promote it into the new store, then retire the old key.
        await this.repository.saveCheckpoint(cadEngine.getSnapshot().document)
        clearLocalDocument()
        return {
          source: 'legacy-localstorage',
          revision: legacy.revision,
          partCount: Object.keys(legacy.parts).length,
          replayedTransactions: 0,
        }
      }

      await this.repository.saveCheckpoint(current)
      return {
        source: 'showcase',
        revision: current.revision,
        partCount: Object.keys(current.parts).length,
        replayedTransactions: 0,
      }
    } catch (cause) {
      return {
        source: 'showcase',
        revision: current.revision,
        partCount: Object.keys(current.parts).length,
        replayedTransactions: 0,
        warning: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  /**
   * A document is only restorable if this build can place every part in it.
   *
   * Restoring a project that references geometry this catalog revision lacks
   * would render an incomplete model while claiming to have reopened the
   * operator's work, so it is refused and reported instead.
   */
  private usable(document: ModelDocument): boolean {
    if (document.schemaVersion !== 2) return false
    return Object.values(document.parts).every((part) => catalog.get(part.definitionId))
  }

  /** Forces a checkpoint, for an explicit save action. */
  async checkpoint(): Promise<void> {
    await this.autosave.checkpointNow(cadEngine.getSnapshot().document)
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.repository.listProjects()
  }

  async settled(): Promise<void> {
    await this.autosave.settled()
  }

  stop() {
    this.detach?.()
    this.detach = null
  }
}

export const session = new Session()
