import type { ReactNode } from 'react'
import { CadEngine } from '../../cad/engine'
import { MemoryDriver } from '../../cad/persistence'
import type { CadOperation, ModelDocument } from '../../cad/types'
import { CloudSyncProvider } from '../CloudSyncProvider'
import type { CloudBackend } from '../protocol'
import {
  CloudRuntime,
  type CloudConnection,
  type CloudIdentity,
  type CloudKernelBridge,
} from '../runtime'
import type { CloudWorkbenchApi } from '../surface'
import { FakeConvexDeployment, type FakeIdentity } from './fakeBackend'
import { ALICE, blankProject } from './harness'

/**
 * Fixtures for the in-editor cloud surfaces.
 *
 * The panels are driven by a real `CadEngine` over a `MemoryDriver` and the
 * same in-process deployment double the acceptance suite uses, so a test that
 * claims a project really uploads a checkpoint and a log, and a test that
 * restores a version really dispatches operations through a kernel that
 * preflights them. Nothing here stubs the store.
 */

export interface UiHarness {
  engine: CadEngine
  driver: MemoryDriver
  deployment: FakeConvexDeployment
  backend: CloudBackend
  runtime: CloudRuntime
  kernel: CloudKernelBridge
  /** Every label dispatched through the command bus seam, with its revision. */
  dispatches: Array<{ label: string; expectedRevision: number; operations: CadOperation[] }>
  openedProjects: string[]
}

export interface UiHarnessOptions {
  document?: ModelDocument
  driver?: MemoryDriver
  /** Omit for the unconfigured path, which is this repo's default. */
  configured?: boolean
  identity?: CloudIdentity
  deployment?: FakeConvexDeployment
  as?: FakeIdentity
  online?: boolean
  /** Refuse every backend call, for the transport-failure states. */
  unreachable?: boolean
  /**
   * Decorates the deployment double at the `CloudBackend` seam.
   *
   * The same seam the acceptance suite uses, so a refusal injected here reaches
   * the outbox exactly as a real one would — which is how the conflict and
   * permanent-failure states are reproduced without pretending about them.
   */
  wrapBackend?: (backend: CloudBackend) => CloudBackend
}

export const SIGNED_IN: CloudIdentity = {
  status: 'signed-in',
  reason: null,
  userId: ALICE.subject,
  label: 'Alice',
}

/** A backend that answers every call as an unreachable deployment. */
export function unreachableBackend(inner: CloudBackend): CloudBackend {
  const refuse = async () => ({
    ok: false as const,
    error: {
      code: 'OFFLINE' as const,
      message: 'The cloud is unreachable: fetch failed.',
      repair: 'Keep working; queued changes are sent when the connection returns.',
    },
  })
  const proxy: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(inner))) {
    if (key === 'constructor') continue
    proxy[key] = refuse
  }
  return proxy as unknown as CloudBackend
}

/** Wraps one method of a backend, leaving the rest of the deployment real. */
export function overrideBackend(
  inner: CloudBackend,
  overrides: Partial<CloudBackend>,
): CloudBackend {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const replacement = (overrides as Record<string | symbol, unknown>)[property]
      if (typeof replacement === 'function') return replacement
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function makeUiHarness(options: UiHarnessOptions = {}): UiHarness {
  const document = options.document ?? blankProject('doc_ui', 'Rover chassis')
  const engine = new CadEngine(document)
  const driver = options.driver ?? new MemoryDriver()
  const deployment = options.deployment ?? new FakeConvexDeployment()
  const real = deployment.as(options.as ?? ALICE)
  const decorated = options.unreachable ? unreachableBackend(real) : real
  const backend = options.wrapBackend ? options.wrapBackend(decorated) : decorated

  const dispatches: UiHarness['dispatches'] = []
  const openedProjects: string[] = []

  const kernel: CloudKernelBridge = {
    driver,
    onCommit: (listener) => engine.onCommit(listener),
    document: () => engine.getSnapshot().document,
    dispatch(label, operations, expectedRevision) {
      dispatches.push({ label, expectedRevision, operations })
      const result = engine.execute(label, operations, 'human', expectedRevision)
      return result.ok
        ? { ok: true as const, revision: result.value.resultRevision }
        : {
            ok: false as const,
            code: result.error.code,
            message: result.error.message,
            repair: result.error.repair,
          }
    },
    async openProject(projectId) {
      openedProjects.push(projectId)
      return { ok: true as const }
    },
  }

  const cloud: CloudConnection = options.configured
    ? {
        status: 'ready',
        url: 'https://deployment.test',
        backend,
        setIdentity: () => {},
        close: async () => {},
      }
    : {
        status: 'unconfigured',
        reason:
          'VITE_CONVEX_URL is not set, so there is no cloud deployment to talk to. Projects are saved in this browser only.',
      }

  const runtime = new CloudRuntime({
    kernel,
    cloud,
    autoDrainMs: 0,
    initialOnline: options.online ?? true,
  })
  if (options.identity) runtime.setIdentity(options.identity)

  return { engine, driver, deployment, backend, runtime, kernel, dispatches, openedProjects }
}

/** Wraps a surface in the provider with the account probe switched off. */
export function withRuntime(runtime: CloudRuntime, children: ReactNode) {
  return (
    <CloudSyncProvider runtime={runtime} lifecycle={false}>
      {children}
    </CloudSyncProvider>
  )
}

/** A `CloudWorkbenchApi` that records what a surface asked the editor to do. */
export function fakeWorkbenchApi(
  engine: CadEngine,
  overrides: Partial<CloudWorkbenchApi> = {},
): CloudWorkbenchApi & { calls: { capability: string[]; modal: (string | null)[]; notices: string[] } } {
  const calls = { capability: [] as string[], modal: [] as (string | null)[], notices: [] as string[] }
  return {
    get snapshot() {
      return engine.getSnapshot()
    },
    online: true,
    activeModal: null,
    notify: (notice) => calls.notices.push(`${notice.kind}:${notice.title}`),
    openModal: (id) => calls.modal.push(id),
    runCapability: (capability, args) => {
      calls.capability.push(`${capability}:${JSON.stringify(args ?? {})}`)
      // The real planner is exercised by the workbench's own suite; here the
      // seam is what matters — a rename of the open document must go through a
      // capability and not through a store write.
      const name = typeof args?.name === 'string' ? args.name : null
      if (!name) return false
      const result = engine.execute(
        'Rename project',
        [{ type: 'document.rename', name }],
        'human',
        engine.getSnapshot().document.revision,
      )
      return result.ok
    },
    ...overrides,
    calls,
  }
}
