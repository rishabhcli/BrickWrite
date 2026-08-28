import type { StorageDriver } from '../cad/persistence'
import type { CadOperation, ModelDocument, Transaction } from '../cad/types'
import { attachCloudSync, type CloudSyncHandle } from './attach'
import { createConvexCloud, hexclaveTokenSource, type ConvexCloudResult } from './convexClient'
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
  /** Always present. Local storage does not depend on a deployment. */
  local: LocalProjectStore
  links: ProjectLinks
  kernel: CloudKernelBridge
  online: boolean
}

export interface CloudRuntimeOptions {
  kernel: CloudKernelBridge
  /** Constructed by the caller, so a test can supply a fake backend. */
  cloud: ConvexCloudResult
  autoDrainMs?: number
  /** Injected so a test can drive connectivity without touching `navigator`. */
  initialOnline?: boolean
}

export class CloudRuntime {
  private readonly local: LocalProjectStore
  private readonly links: ProjectLinks
  private readonly handle: CloudSyncHandle | null
  private readonly configuration: CloudConfiguration
  private readonly cloud: ConvexCloudResult
  private identity: CloudIdentity = SIGNED_OUT_IDENTITY
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
   * installing window listeners, and so React's StrictMode double-mount adds
   * and removes them in pairs.
   */
  start(): () => void {
    if (typeof window === 'undefined') return () => {}
    const goOnline = () => {
      this.publish({ online: true })
      // A reconnect is new information, so the queue stops sitting out its
      // backoff window. `reconnected()` republishes through the subscription.
      void this.handle?.reconnected()
    }
    const goOffline = () => this.publish({ online: false })
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
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
      local: this.local,
      links: this.links,
      kernel: this.options.kernel,
      online: this.online,
    }
  }

  private publish(next: { sync?: SyncState; online?: boolean }): void {
    if (next.sync) this.sync = next.sync
    if (next.online !== undefined) this.online = next.online
    this.snapshot = this.build()
    for (const listener of [...this.listeners]) listener()
  }

  dispose(): void {
    for (const stop of this.teardown.splice(0)) stop()
    if (this.cloud.status === 'ready') void this.cloud.close()
  }
}

const sameIdentity = (a: CloudIdentity, b: CloudIdentity) =>
  a.status === b.status &&
  ('userId' in a ? a.userId : null) === ('userId' in b ? b.userId : null) &&
  a.reason === b.reason

// ---------------------------------------------------------------------------
// The browser runtime
// ---------------------------------------------------------------------------

let browser: CloudRuntime | null = null

/**
 * The runtime the editor actually mounts, built once.
 *
 * A singleton because the things it wires are singletons: one CAD session, one
 * IndexedDB connection, one engine. Two runtimes would mean two outboxes over
 * one `meta` store, which is the race `session.driver` exists to prevent.
 *
 * Built lazily rather than at module scope so that importing `src/cloud` — for
 * a type, or for `diffDocuments` — does not construct a Convex client or open a
 * database.
 */
export function browserCloudRuntime(overrides: Partial<CloudRuntimeOptions> = {}): CloudRuntime {
  if (!browser) {
    browser = new CloudRuntime({
      kernel: overrides.kernel ?? browserKernelBridge(),
      cloud: overrides.cloud ?? browserCloud(),
      autoDrainMs: overrides.autoDrainMs,
      initialOnline: overrides.initialOnline,
    })
  }
  return browser
}

/** Drops the singleton. Tests use this; the application has no reason to. */
export function resetBrowserCloudRuntime(): void {
  browser?.dispose()
  browser = null
}

/**
 * The Convex client for this browser, with the Hexclave token source attached.
 *
 * The account layer is optional in several supported ways of running
 * Brickwright, so its absence downgrades the cloud to "signed out" rather than
 * to "broken": the client is still constructed and still reports its URL, and
 * every call it makes answers `UNAUTHENTICATED` with a reason until somebody
 * signs in.
 */
function browserCloud(): ConvexCloudResult {
  return createConvexCloud({ tokenSource: hexclaveTokenSourceOrNull() ?? undefined })
}

function hexclaveTokenSourceOrNull() {
  // Imported lazily through a dynamic require-shaped indirection would be
  // worse: this module is only reached from the editor, where the account layer
  // is already resolved. A failure here is reported, never thrown.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getHexclaveClientApp } = hexclaveModule()
    const app = getHexclaveClientApp()
    return app.status === 'ok' ? hexclaveTokenSource(app.data) : null
  } catch {
    return null
  }
}

/**
 * Indirection so the import is expressed once and can be stubbed in a test.
 *
 * `src/cloud` never imports `src/hexclave` for types — `hexclaveTokenSource` is
 * structurally typed — but the browser wiring has to name the module somewhere,
 * and here is the one place.
 */
let hexclaveModule: () => { getHexclaveClientApp: () => { status: 'ok'; data: { getAccessToken: () => Promise<string | null> } } | { status: 'error'; error: Error } } = () => {
  throw new Error('The Hexclave module has not been installed into the cloud runtime.')
}

/** Installs the account module. Called by `src/cloud/CloudSyncProvider.tsx`. */
export function installHexclaveModule(loader: typeof hexclaveModule): void {
  hexclaveModule = loader
}

let kernelBridgeFactory: (() => CloudKernelBridge) | null = null

/** Installs the kernel bridge factory. Called by `src/cloud/CloudSyncProvider.tsx`. */
export function installKernelBridge(factory: () => CloudKernelBridge): void {
  kernelBridgeFactory = factory
}

function browserKernelBridge(): CloudKernelBridge {
  if (!kernelBridgeFactory) {
    throw new Error('No kernel bridge is installed; mount <CloudSyncProvider /> before using the cloud runtime.')
  }
  return kernelBridgeFactory()
}
