import { cadEngine, commandBus } from '../cad/engine'
import { session } from '../cad/session'
import type { CadOperation } from '../cad/types'
import { createConvexCloud, type AccessTokenSource, type ConvexCloudResult } from './convexClient'
import { CloudRuntime, canReachCloud, type CloudKernelBridge, type CloudRuntimeOptions } from './runtime'

/**
 * The cloud runtime this browser actually mounts.
 *
 * Kept apart from `runtime.ts` on purpose: that module has to be constructible
 * from a `MemoryDriver` and a bare `CadEngine` so panels can be tested without
 * booting a session, and a static import of the kernel singletons there would
 * make every cloud test drag in the whole editor. This file is the one place
 * that names them.
 *
 * `session.driver` rather than a second `createDriver()`: the outbox and the
 * project links live in the same `meta` object store as the local checkpoints,
 * and two IndexedDB connections to one database is a race nobody needs.
 */

/** The kernel seam, bound to the singletons the editor runs on. */
export function browserKernelBridge(): CloudKernelBridge {
  return {
    driver: session.driver,
    onCommit: (listener) => cadEngine.onCommit(listener),
    document: () => cadEngine.getSnapshot().document,
    dispatch(label: string, operations: CadOperation[], expectedRevision: number) {
      // `commandBus` with an explicit expected revision, exactly like every
      // other writer in the application. A restore planned against revision 12
      // must not land on revision 14: the kernel refuses it and the operator is
      // told, rather than silently overwriting two transactions of somebody
      // else's work.
      const result = commandBus.dispatch(label, operations, 'human', expectedRevision)
      return result.ok
        ? { ok: true as const, revision: result.value.resultRevision }
        : {
            ok: false as const,
            code: result.error.code,
            message: result.error.message,
            repair: result.error.repair,
          }
    },
    async openProject(projectId: string) {
      const outcome = await session.openProject(projectId)
      return outcome.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            code: outcome.code ?? 'NOT_FOUND',
            message: outcome.message ?? 'That project could not be opened.',
          }
    },
  }
}

/**
 * An access token for the signed-in Hexclave user, or null.
 *
 * The import is dynamic so that `src/cloud` never pulls the account SDK into a
 * module graph that has not asked for it, and so a build with no account layer
 * degrades to "signed out" instead of failing to load. Ownership on the
 * deployment is keyed on the `sub` claim inside this token — the Hexclave user
 * id — and never on an email address.
 */
const browserTokenSource: AccessTokenSource = async () => {
  try {
    const { getHexclaveClientApp } = await import('../hexclave/client')
    const app = getHexclaveClientApp()
    return app.status === 'ok' ? await app.data.getAccessToken() : null
  } catch {
    // An absent or unconfigured account layer is a supported way to run the
    // editor. Every cloud call then answers UNAUTHENTICATED with a reason.
    return null
  }
}

/** `VITE_CONVEX_URL` or a truthful `unconfigured`, with the Hexclave token attached. */
export function browserCloud(): ConvexCloudResult {
  return createConvexCloud({ tokenSource: browserTokenSource })
}

let singleton: CloudRuntime | null = null

/**
 * The runtime, built once.
 *
 * A singleton because everything it wires is one: one session, one engine, one
 * IndexedDB connection. Built lazily rather than at module scope so importing
 * this file for a type does not construct a Convex client.
 */
export function browserCloudRuntime(overrides: Partial<CloudRuntimeOptions> = {}): CloudRuntime {
  singleton ??= new CloudRuntime({
    kernel: overrides.kernel ?? browserKernelBridge(),
    cloud: overrides.cloud ?? browserCloud(),
    autoDrainMs: overrides.autoDrainMs,
    initialOnline: overrides.initialOnline,
    // Signing out clears the client's token rather than leaving it holding the
    // previous user's, which would keep reading somebody else's projects.
    tokenSourceFor: overrides.tokenSourceFor ?? ((identity) => (canReachCloud(identity) ? browserTokenSource : null)),
  })
  return singleton
}

/** Drops the singleton. Tests use this; the application has no reason to. */
export function resetBrowserCloudRuntime(): void {
  singleton?.dispose()
  singleton = null
}
