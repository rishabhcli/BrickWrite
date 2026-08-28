import type { ModelDocument } from '../../cad/types'
import type { DemoEntry } from '../../demos'
import { loadDocumentText } from '../../demos'

/**
 * Forking a demo.
 *
 * The published demo is immutable: it is a content-addressed snapshot on disk,
 * and nothing here writes to it. "Edit this build" always produces a *copy*
 * under a new project id, so two visitors editing the same demo cannot see each
 * other's work and neither can change what the next visitor opens.
 *
 * Where the copy lands depends on who is asking:
 *
 *   - signed out — a local project in IndexedDB, which is where Brickwright
 *     keeps everybody's work anyway;
 *   - signed in — a cloud project, through whichever adapter the deployment
 *     registered.
 *
 * There is no cloud adapter in this module and there is no stub of one. If a
 * signed-in visitor's deployment has not registered one, the fork still
 * happens, locally, and the result says so rather than implying a sync that is
 * not running.
 */

export interface CloudForkInput {
  name: string
  /** The parsed `ModelDocument`, exactly as published. */
  document: unknown
  source: { kind: 'demo'; demoId: string; catalogVersion: string; sha256: string }
}

export interface CloudProjectAdapter {
  /** Identifies the implementation in a fork result and in the doc. */
  readonly id: string
  isSignedIn(): boolean | Promise<boolean>
  createProject(input: CloudForkInput): Promise<{ projectId: string; url?: string }>
}

let adapter: CloudProjectAdapter | null = null

/**
 * Installs the cloud project adapter.
 *
 * A registration seam rather than an import, because `src/cloud` is another
 * workstream's directory and may not be present in a given build. A module that
 * imported it would fail to resolve; a module that feature-detects it degrades.
 */
export function registerCloudProjectAdapter(next: CloudProjectAdapter | null): () => void {
  const previous = adapter
  adapter = next
  return () => {
    if (adapter === next) adapter = previous
  }
}

declare global {
  interface Window {
    brickwrightCloudProjects?: CloudProjectAdapter
  }
}

/** The registered adapter, or one published on `window` by the shell. */
export function cloudProjectAdapter(): CloudProjectAdapter | null {
  if (adapter) return adapter
  if (typeof window !== 'undefined' && window.brickwrightCloudProjects) return window.brickwrightCloudProjects
  return null
}

export type ForkDestination = 'local' | 'cloud'

export type ForkOutcome =
  | { ok: true; destination: 'local'; projectId: string; name: string; parts: number; note: string | null }
  | { ok: true; destination: 'cloud'; projectId: string; name: string; parts: number; adapter: string; url?: string }
  | { ok: false; destination: ForkDestination; message: string }

/**
 * The published snapshot, typed as the kernel's own document.
 *
 * `src/cad/types` is types only — no kernel, no catalog, no renderer — so
 * importing it costs the explore chunk nothing and buys the fork a real
 * contract instead of an index signature.
 */
type ForkedDocument = ModelDocument

/** A fork name that does not collide with the projects already stored. */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}_${suffix}`
  return id
}

/**
 * Copies a demo into a project the visitor owns.
 *
 * The persistence layer is imported dynamically. The explore route is allowed
 * the catalog and nothing heavier, and a static import of the project store
 * would put it — and everything it drags in — in the chunk that paints the
 * page, for a button most visitors never press.
 */
export async function forkDemo(
  demo: DemoEntry,
  options: { name?: string; signal?: AbortSignal; now?: () => string } = {},
): Promise<ForkOutcome> {
  const now = options.now ?? (() => new Date().toISOString())
  const name = options.name?.trim() || `${demo.title} (fork)`
  let text: string
  try {
    text = await loadDocumentText(demo, 'published', options.signal)
  } catch (cause) {
    return {
      ok: false,
      destination: 'local',
      message: `The published snapshot could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  const source = JSON.parse(text) as ForkedDocument
  const partCount = Object.keys(source.parts ?? {}).length

  const cloud = cloudProjectAdapter()
  if (cloud) {
    let signedIn = false
    try {
      signedIn = await cloud.isSignedIn()
    } catch {
      signedIn = false
    }
    if (signedIn) {
      try {
        const created = await cloud.createProject({
          name,
          document: { ...source, name, createdAt: now(), updatedAt: now() },
          source: {
            kind: 'demo',
            demoId: demo.id,
            catalogVersion: demo.catalogVersion,
            sha256: demo.assets.document.sha256,
          },
        })
        return {
          ok: true,
          destination: 'cloud',
          projectId: created.projectId,
          url: created.url,
          name,
          parts: partCount,
          adapter: cloud.id,
        }
      } catch (cause) {
        return {
          ok: false,
          destination: 'cloud',
          message: `The cloud project could not be created: ${cause instanceof Error ? cause.message : String(cause)}`,
        }
      }
    }
  }

  try {
    const { ProjectRepository, IndexedDbDriver, MemoryDriver, indexedDbAvailable } = await import('../../cad/persistence')
    const durable = indexedDbAvailable()
    const repository = new ProjectRepository(durable ? new IndexedDbDriver() : new MemoryDriver())
    const taken = new Set((await repository.listProjects()).map((project) => project.projectId))
    const projectId = uniqueId(`doc_${demo.id.replace(/-/g, '_')}_fork`, taken)
    const timestamp = now()
    // A fresh id and a fresh checkpoint: the fork and the demo share no history,
    // so nothing the visitor does can replay back into the published snapshot.
    await repository.saveCheckpoint({ ...source, id: projectId, name, createdAt: timestamp, updatedAt: timestamp })
    return {
      ok: true,
      destination: 'local',
      projectId,
      name,
      parts: partCount,
      note: durable
        ? null
        : 'This browser has no IndexedDB, so the fork is held in memory and will not survive a reload.',
    }
  } catch (cause) {
    return {
      ok: false,
      destination: 'local',
      message: `The fork could not be stored: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}
