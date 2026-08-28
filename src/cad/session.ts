import { catalog } from './catalog'
import { cadEngine } from './engine'
import {
  createDriver,
  createRepository,
  indexedDbAvailable,
  ProjectAutosave,
  type ProjectRepository,
  type ProjectSummary,
  type StorageDriver,
} from './persistence'
import { createBlankDocument } from './sample'
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

/** Outcome of a project switch, fork or deletion. */
export interface ProjectSwitch {
  ok: boolean
  code?: 'NOT_FOUND' | 'UNPLACEABLE_PARTS' | 'OPEN_PROJECT'
  message?: string
  restore?: SessionRestore | null
}

class Session {
  /** Shared with the optional cloud relay, which stores its queue in `meta`. */
  readonly driver: StorageDriver = createDriver()
  private repository: ProjectRepository = createRepository(this.driver)
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

  get currentProjectId(): string {
    return cadEngine.getSnapshot().document.id
  }

  /**
   * Flushes the open project so it can be left safely.
   *
   * Queued appends are awaited and a checkpoint written before anything replaces
   * the document, because switching away must not be a way to lose edits that
   * were still in flight.
   */
  private async partWithCurrent(): Promise<ModelDocument> {
    const outgoing = cadEngine.getSnapshot().document
    await this.autosave.settled()
    await this.autosave.checkpointNow(outgoing)
    return outgoing
  }

  private adopt(document: ModelDocument, replayed: number): SessionRestore {
    cadEngine.replaceDocument(document)
    this.autosave.reset()
    this.restore = {
      source: 'indexeddb',
      revision: document.revision,
      partCount: Object.keys(document.parts).length,
      replayedTransactions: replayed,
    }
    return this.restore
  }

  /**
   * Switches the editor to another stored project.
   *
   * A project this catalog revision cannot fully place is refused for the same
   * reason `start()` refuses one: reopening a model with parts missing would
   * misrepresent the operator's work rather than restore it.
   */
  async openProject(projectId: string): Promise<ProjectSwitch> {
    const outgoing = await this.partWithCurrent()
    if (projectId === outgoing.id) return { ok: true, restore: this.restore }

    const loaded = await this.repository.loadProject(projectId)
    if (!loaded) {
      return { ok: false, code: 'NOT_FOUND', message: 'That project is no longer in local storage.' }
    }
    if (!this.usable(loaded.document)) {
      return {
        ok: false,
        code: 'UNPLACEABLE_PARTS',
        message: `"${loaded.document.name}" references parts this catalog revision cannot place, so it was left untouched.`,
      }
    }
    return { ok: true, restore: this.adopt(loaded.document, loaded.replayed.length) }
  }

  /**
   * Starts an empty project.
   *
   * Forking was previously the only way to get a second document, which meant
   * every new project began as a copy of the showcase rover. Building something
   * of your own should not start by deleting someone else's model.
   */
  async createProject(name?: string): Promise<ProjectSwitch> {
    // Flush the outgoing document first: adopting a new one detaches autosave
    // from it, and an unwritten tail would be lost.
    await this.partWithCurrent()
    const projectName = name?.trim() || 'Untitled build'
    const document: ModelDocument = {
      ...createBlankDocument(projectName),
      id: await this.uniqueProjectId(projectName),
      createdAt: new Date().toISOString(),
    }
    const restore = this.adopt(document, 0)
    await this.repository.saveCheckpoint(cadEngine.getSnapshot().document)
    return { ok: true, restore }
  }

  /**
   * Project ids are disambiguated against the store rather than assumed unique:
   * a name slug collides the second time the same fork name is used, and a
   * collision here would overwrite somebody's project.
   */
  private async uniqueProjectId(name: string): Promise<string> {
    const base = `doc_${name.toLowerCase().replace(/\W+/g, '_')}`
    const taken = new Set((await this.repository.listProjects()).map((project) => project.projectId))
    let id = base
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}_${suffix}`
    return id
  }

  /**
   * Forks the open document into a new project.
   *
   * The fork gets a new project id, a fresh checkpoint and an empty log, so the
   * two histories cannot replay into each other.
   */
  async forkProject(name?: string): Promise<ProjectSwitch> {
    const source = await this.partWithCurrent()
    const forkName = name?.trim() || `${source.name} (fork)`
    const id = await this.uniqueProjectId(forkName)

    const fork: ModelDocument = {
      ...structuredClone(source),
      id,
      name: forkName,
      createdAt: new Date().toISOString(),
    }
    const restore = this.adopt(fork, 0)
    await this.repository.saveCheckpoint(cadEngine.getSnapshot().document)
    return { ok: true, restore }
  }

  /**
   * Opens an already-built document as a new stored project.
   *
   * Used when a publication is forked: the snapshot is a different object from
   * the live document, so cloning the open project would be the wrong source.
   */
  async importDocument(document: ModelDocument): Promise<ProjectSwitch> {
    await this.partWithCurrent()
    const id = await this.uniqueProjectId(document.name)
    const imported: ModelDocument = {
      ...document,
      id,
      createdAt: document.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    if (!this.usable(imported)) {
      return {
        ok: false,
        code: 'UNPLACEABLE_PARTS',
        message: `"${imported.name}" references parts this catalog revision cannot place, so it was left untouched.`,
      }
    }
    const restore = this.adopt(imported, 0)
    await this.repository.saveCheckpoint(cadEngine.getSnapshot().document)
    return { ok: true, restore }
  }

  /**
   * Deletes a stored project.
   *
   * The open project is refused: autosave would immediately recreate a partial
   * checkpoint for it, so the delete would appear to work and then undo itself.
   */
  async deleteProject(projectId: string): Promise<ProjectSwitch> {
    if (projectId === this.currentProjectId) {
      return {
        ok: false,
        code: 'OPEN_PROJECT',
        message: 'Switch to another project before deleting this one.',
      }
    }
    await this.repository.deleteProject(projectId)
    return { ok: true }
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
