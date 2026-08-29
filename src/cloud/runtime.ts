import type { StorageDriver } from '../cad/persistence'
import type { CadOperation, ModelDocument, Transaction } from '../cad/types'
import { attachCloudSync, type CloudSyncHandle } from './attach'
import type { AccessTokenSource } from './convexClient'
import type { CloudBackend } from './protocol'
import { UNCONFIGURED_SYNC_STATE, type SyncState } from './outbox'
import {
  LocalProjectStore,
  ProjectLinks,
  type MirroredProjectStore,
  type ProjectLink,
  type StoredProjectSummary,
} from './projectStore'

/**
 * The cloud layer as one mountable object.
 *
 * `attachCloudSync` is the seam; this is the thing a composition root can hold.
 * It owns the four facts every cloud surface in the editor needs — is there a
 * deployment, who is signed in, what is the queue doing, and which local
 * projects have a replica — and it publishes them as one immutable snapshot
 * through the `useSyncExternalStore` contract, so a status line and a panel
 * cannot disagree about them.
 *
 * Two properties are deliberate:
 *
 *   1. **Unconfigured is a whole, working mode.** With no `VITE_CONVEX_URL`
 *      there is no backend, no outbox and no handle, and every accessor below
 *      still answers: the local store works, the project list works, and the
 *      sync state is `unconfigured` with the reason attached. Nothing throws
 *      and nothing pretends.
 *   2. **The kernel arrives as a bridge, not as an import.** The browser build
 *      hands in `session.driver`, `cadEngine.onCommit` and `commandBus`; a test
 *      hands in a `MemoryDriver` and a real `CadEngine`. Neither the runtime nor
 *      the surfaces above it reach for a module singleton, so a panel can be
 *      rendered in isolation without booting a CAD session.
 */

/**
 * Who the deployment will see.
 *
 * Keyed by the Hexclave **user id**, never by an email address: the address is
 * a delivery detail of an invitation and is not an authorisation key anywhere
 * in this workstream. `label` is display text and is allowed to be an address
 * only because `accountLabel` in the platform layer already decided it is the
 * best human name available.
 */
export type CloudIdentity =
  | { status: 'unavailable'; reason: string }
  | { status: 'signed-out'; reason: string }
  | { status: 'expired'; reason: string }
  | { status: 'restricted'; reason: string; userId: string; label: string }
  | { status: 'signed-in'; reason: null; userId: string; label: string }

export const SIGNED_OUT_IDENTITY: CloudIdentity = {
  status: 'signed-out',
  reason: 'You are not signed in, so this browser is the only place these projects exist.',
}

/** True only for an identity the deployment will authorise. */
export const canReachCloud = (identity: CloudIdentity): identity is Extract<CloudIdentity, { status: 'signed-in' }> =>
  identity.status === 'signed-in'

/**
 * The part of `ConvexCloudResult` this runtime actually uses.
 *
 * Stated as its own type so a test can supply the in-process fake deployment
 * without constructing a `ConvexClient` it would never call. `createConvexCloud`
 * returns something assignable to this, which is checked where it is passed in.
 */
export type CloudConnection =
  | {
      status: 'ready'
      url: string
      backend: CloudBackend
      setIdentity(source: AccessTokenSource | null): void
      close(): Promise<void>
    }
  | { status: 'unconfigured'; reason: string }

export interface CloudConfiguration {
  status: 'ready' | 'unconfigured'
  /** Null only when `status` is `ready`. An unconfigured cloud always says why. */
  reason: string | null
  url: string | null
}

/**
 * What the editor's kernel lends the cloud layer.
 *
 * Every mutation of the open document goes through `dispatch`, which is
 * `commandBus.dispatch` with an explicit expected revision. There is no other
 * write path in this workstream: a restore that wrote a document straight into
 * storage would skip preflight, collision checks and the agent locks, and would
 * silently delete anything committed since the dialog was opened.
 */
export interface CloudKernelBridge {
  readonly driver: StorageDriver
  onCommit(listener: (transaction: Transaction, document: ModelDocument) => void): () => void
  /** The open document, read at call time. */
  document(): ModelDocument
  dispatch(
    label: string,
    operations: CadOperation[],
    expectedRevision: number,
  ): { ok: true; revision: number } | { ok: false; code: string; message: string; repair?: string }
  /** Switches the editor to a stored project. */
  openProject(
    projectId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>
}

export interface CloudProjectRow extends StoredProjectSummary {
  /** The cloud replica this browser has recorded for the project, if any. */
  link: ProjectLink | null
  /** True when this is the document the editor currently has open. */
  open: boolean
}

export interface CloudRuntimeSnapshot {
  configuration: CloudConfiguration
  identity: CloudIdentity
  sync: SyncState
  /** Null when unconfigured — there is no replica to mirror. */
  store: MirroredProjectStore | null
  handle: CloudSyncHandle | null
  /** The deployment adapter, or null when unconfigured. */
  backend: CloudBackend | null
  /** Always present. Local storage does not depend on a deployment. */
  local: LocalProjectStore
  links: ProjectLinks
  kernel: CloudKernelBridge
  online: boolean
  /**
   * Bumped whenever a claim or a delete rewrites the project links.
   *
   * The links live in IndexedDB, which no React hook can subscribe to, so this
   * counter is how a surface knows its answer to "does this project have a
   * replica?" has gone stale.
   */
  linksVersion: number
}

export interface CloudRuntimeOptions {
  kernel: CloudKernelBridge
  /** Constructed by the caller, so a test can supply a fake backend. */
  cloud: CloudConnection
  autoDrainMs?: number
  /** Injected so a test can drive connectivity without touching `navigator`. */
  initialOnline?: boolean
  /**
   * The access-token source for an identity, or null when it has none.
   *
   * Supplied by the composition root rather than derived here, because the
   * token comes from the Hexclave client app and `src/cloud` deliberately does
   * not import `src/hexclave`. Omitted entirely by tests using a fake backend,
   * which authorises by identity rather than by bearer token.
   */
  tokenSourceFor?: (identity: CloudIdentity) => AccessTokenSource | null
}

export class CloudRuntime {
  private readonly local: LocalProjectStore
  private readonly links: ProjectLinks
  private readonly handle: CloudSyncHandle | null
  private readonly configuration: CloudConfiguration
  private readonly cloud: CloudConnection
  private identity: CloudIdentity = SIGNED_OUT_IDENTITY
  private linksVersion = 0
  private started = 0
  private stopListening: (() => void) | null = null
  private sync: SyncState
  private online: boolean
  private snapshot: CloudRuntimeSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly teardown: Array<() => void> = []

  constructor(private readonly options: CloudRuntimeOptions) {
    this.local = new LocalProjectStore(options.kernel.driver)
    this.links = new ProjectLinks(options.kernel.driver)
    this.cloud = options.cloud
    this.configuration =
      options.cloud.status === 'ready'
        ? { status: 'ready', reason: null, url: options.cloud.url }
        : { status: 'unconfigured', reason: options.cloud.reason, url: null }

    if (options.cloud.status === 'ready') {
      this.handle = attachCloudSync({
        driver: options.kernel.driver,
        backend: options.cloud.backend,
        onCommit: options.kernel.onCommit,
        autoDrainMs: options.autoDrainMs,
      })
      this.teardown.push(this.handle.detach)
      this.teardown.push(this.handle.subscribe((state) => this.publish({ sync: state })))
    } else {
      this.handle = null
    }

    this.sync = this.handle ? this.handle.state() : UNCONFIGURED_SYNC_STATE
    this.online =
      options.initialOnline ?? (typeof navigator === 'undefined' ? true : navigator.onLine)
    this.snapshot = this.build()
  }

  /**
   * Starts the parts of the runtime that touch the browser.
   *
   * Split out of the constructor so a test can construct a runtime without
   * installing window listeners. Reference counted, because several surfaces
   * share one runtime and React's StrictMode mounts each of them twice: one set
   * of connectivity listeners is correct, six is a bug that only shows up as a
   * stutter when the network flaps.
   */
  start(): () => void {
    if (typeof window === 'undefined') return () => {}
    this.started += 1
    if (this.started === 1) {
      const goOnline = () => {
        this.publish({ online: true })
        // A reconnect is new information, so the queue stops sitting out its
        // backoff window. `reconnected()` republishes through the subscription.
        void this.recoverAfterSignal('reconnect')
      }
      const goOffline = () => this.publish({ online: false })
      window.addEventListener('online', goOnline)
      window.addEventListener('offline', goOffline)
      this.stopListening = () => {
        window.removeEventListener('online', goOnline)
        window.removeEventListener('offline', goOffline)
      }
      // The browser may have gone offline between construction and mount.
      if (navigator.onLine !== this.online) this.publish({ online: navigator.onLine })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.started -= 1
      if (this.started === 0) {
        this.stopListening?.()
        this.stopListening = null
      }
    }
  }

  getSnapshot(): CloudRuntimeSnapshot {
    return this.snapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Records who is signed in, and tells the Convex client.
   *
   * Signing out clears the token rather than leaving the client holding a stale
   * one: a client that kept reading with the previous user's identity would be
   * reading somebody else's projects.
   */
  setIdentity(identity: CloudIdentity): void {
    if (sameIdentity(this.identity, identity)) return
    this.identity = identity
    if (this.cloud.status === 'ready' && this.options.tokenSourceFor) {
      this.cloud.setIdentity(this.options.tokenSourceFor(identity))
    }
    this.publish({})
    if (identity.status === 'signed-in') void this.recoverAfterSignal('identity')
  }

  /**
   * A reconnect or fresh identity is new information for a parked head. Once it
   * clears, re-derive any tail that could not enter a full queue. Backfill is
   * deliberately skipped while a head remains parked: adding behind a blocker
   * cannot repair it and only consumes queue capacity.
   */
  private async recoverAfterSignal(signal: 'reconnect' | 'identity'): Promise<void> {
    if (!this.handle) return
    const state =
      signal === 'reconnect' ? await this.handle.reconnected() : await this.handle.retryHead()
    if (state.status !== 'idle') return
    for (const link of await this.links.all()) {
      const result = await this.handle.store.backfill(link.localProjectId)
      if (!result.ok) return
    }
    await this.handle.outbox.drain()
  }

  /** Every project this browser holds, tagged with its cloud replica. */
  async listLocalProjects(): Promise<CloudProjectRow[]> {
    const [listed, links] = await Promise.all([this.local.listProjects(), this.links.all()])
    if (!listed.ok) return []
    const byLocalId = new Map(links.map((link) => [link.localProjectId, link]))
    const openId = this.options.kernel.document().id
    return listed.value.map((summary) => {
      const link = byLocalId.get(summary.projectId) ?? null
      return {
        ...summary,
        origin: link ? ('cloud' as const) : summary.origin,
        link,
        open: summary.projectId === openId,
      }
    })
  }

  private build(): CloudRuntimeSnapshot {
    return {
      configuration: this.configuration,
      identity: this.identity,
      sync: this.sync,
      store: this.handle?.store ?? null,
      handle: this.handle,
      backend: this.cloud.status === 'ready' ? this.cloud.backend : null,
      local: this.local,
      links: this.links,
      kernel: this.options.kernel,
      online: this.online,
      linksVersion: this.linksVersion,
    }
  }

  /**
   * Announces that the project links changed.
   *
   * Called by the surface that claimed or deleted a project. Explicit rather
   * than inferred from the sync queue: a claim uploads through the backend
   * directly and never touches the outbox, so nothing else moves when one
   * succeeds.
   */
  notifyLinksChanged(): void {
    this.linksVersion += 1
    this.publish({})
  }

  private publish(next: { sync?: SyncState; online?: boolean }): void {
    if (next.sync) this.sync = next.sync
    if (next.online !== undefined) this.online = next.online
    this.snapshot = this.build()
    for (const listener of [...this.listeners]) listener()
  }

  dispose(): void {
    this.stopListening?.()
    this.stopListening = null
    this.started = 0
    for (const stop of this.teardown.splice(0)) stop()
    if (this.cloud.status === 'ready') void this.cloud.close()
  }
}

const sameIdentity = (a: CloudIdentity, b: CloudIdentity) =>
  a.status === b.status &&
  ('userId' in a ? a.userId : null) === ('userId' in b ? b.userId : null) &&
  a.reason === b.reason
