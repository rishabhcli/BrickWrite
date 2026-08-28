import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  Suspense,
  type ReactNode,
} from 'react'
import { accountLabel, useAccountAvailability, useAccountSession } from '../platform'
import { browserCloudRuntime } from './browserRuntime'
import type { CloudRuntime, CloudRuntimeSnapshot, CloudIdentity } from './runtime'

/**
 * Mounting the cloud layer.
 *
 * This is the whole integration the shell asks for: one component, no props,
 * one line in the composition root. It attaches `attachCloudSync` to the
 * session's storage driver and the engine's commit stream, resolves who is
 * signed in from the platform's account layer, and publishes both through a
 * context every cloud surface reads.
 *
 * Three things it deliberately does not do:
 *
 *   - **It does not gate the editor.** An unconfigured deployment, an absent
 *     account layer and a signed-out browser are all supported ways to run, and
 *     in each of them this provider mounts, reports the reason, and gets out of
 *     the way.
 *   - **It does not own document state.** Sync state is not document truth: the
 *     kernel is authoritative about the model, and this layer only ever reports
 *     what the replica has been told.
 *   - **It does not construct a second store.** The runtime is a singleton over
 *     `session.driver`, because the outbox lives in the same object store as
 *     the local checkpoints.
 */

interface CloudSyncContextValue {
  runtime: CloudRuntime
  snapshot: CloudRuntimeSnapshot
}

const CloudSyncContext = createContext<CloudSyncContextValue | null>(null)

export interface CloudSyncProviderProps {
  children?: ReactNode
  /** Supplied by tests; the application uses the browser singleton. */
  runtime?: CloudRuntime
  /** Set false to skip the account-layer probe, for tests that drive identity directly. */
  resolveIdentity?: boolean
}

export function CloudSyncProvider({ children, runtime, resolveIdentity = true }: CloudSyncProviderProps) {
  const resolved = useMemo(() => runtime ?? browserCloudRuntime(), [runtime])
  useEffect(() => resolved.start(), [resolved])

  const snapshot = useSyncExternalStore(
    resolved.subscribe,
    () => resolved.getSnapshot(),
    () => resolved.getSnapshot(),
  )
  const value = useMemo<CloudSyncContextValue>(
    () => ({ runtime: resolved, snapshot }),
    [resolved, snapshot],
  )

  return (
    <CloudSyncContext.Provider value={value}>
      {resolveIdentity && <CloudIdentityBridge runtime={resolved} />}
      {children}
    </CloudSyncContext.Provider>
  )
}

/**
 * The live cloud state.
 *
 * Throws rather than inventing an unconfigured snapshot when there is no
 * provider: a panel that silently reported "no cloud" because somebody forgot
 * to mount the provider would be indistinguishable from a genuinely
 * unconfigured deployment, which is exactly the confusion this workstream
 * exists to remove.
 */
export function useCloudSync(): CloudSyncContextValue {
  const value = useContext(CloudSyncContext)
  if (!value) {
    throw new Error('useCloudSync must be used inside <CloudSyncProvider>.')
  }
  return value
}

/** The cloud state if a provider is mounted, and null otherwise. */
export function useOptionalCloudSync(): CloudSyncContextValue | null {
  return useContext(CloudSyncContext)
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Reports the signed-in Hexclave user into the runtime.
 *
 * Two components rather than one branch, because `useAccountSession` calls a
 * suspending hook that requires the Hexclave provider above it. Availability is
 * decided once by the shell and does not flip, so choosing the component by it
 * is safe; calling the hook unconditionally would not be.
 */
function CloudIdentityBridge({ runtime }: { runtime: CloudRuntime }) {
  const availability = useAccountAvailability()
  if (availability.status !== 'ready') {
    return (
      <ReportIdentity
        runtime={runtime}
        identity={{
          status: 'unavailable',
          reason: `${availability.reason} Projects are saved in this browser only.`,
        }}
      />
    )
  }
  return (
    <Suspense fallback={null}>
      <AccountIdentity runtime={runtime} />
    </Suspense>
  )
}

function AccountIdentity({ runtime }: { runtime: CloudRuntime }) {
  const session = useAccountSession()
  const identity = useMemo<CloudIdentity>(() => {
    switch (session.status) {
      case 'signed-in':
        // Keyed on the Hexclave user id. The label is display text only and is
        // never what the deployment authorises against.
        return { status: 'signed-in', reason: null, userId: session.user.id, label: accountLabel(session.user) }
      case 'restricted':
        return {
          status: 'restricted',
          reason: `This account is restricted (${session.restriction.replace(/_/g, ' ')}), so the cloud will refuse it.`,
          userId: session.user.id,
          label: accountLabel(session.user),
        }
      case 'expired':
        return {
          status: 'expired',
          reason: 'Your session expired, so nothing can be sent to the cloud until you sign in again.',
        }
      default:
        return {
          status: 'signed-out',
          reason: 'You are not signed in, so this browser is the only place these projects exist.',
        }
    }
  }, [session])
  return <ReportIdentity runtime={runtime} identity={identity} />
}

function ReportIdentity({ runtime, identity }: { runtime: CloudRuntime; identity: CloudIdentity }) {
  // A ref rather than a dependency on the object: the identity is rebuilt on
  // every render of the account hook, and `setIdentity` already ignores an
  // unchanged one, but re-running the effect for a new object identity would
  // churn the Convex client's auth on every keystroke elsewhere in the editor.
  const latest = useRef(identity)
  latest.current = identity
  useEffect(() => {
    runtime.setIdentity(latest.current)
  }, [runtime, identity.status, 'userId' in identity ? identity.userId : null, identity.reason])
  return null
}
