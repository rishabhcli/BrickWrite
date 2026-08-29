import type { SyncState, SyncStatus } from './outbox'
import type { CloudErrorCode } from './protocol'
import type { CloudConfiguration, CloudIdentity } from './runtime'

/**
 * Turning four facts into one honest line.
 *
 * The rule this file exists to enforce: **never say "synced" unless this
 * browser has watched something reach the deployment.** A status light is the
 * only thing most people will ever read about the cloud layer, so it has to be
 * wrong in the safe direction. "Local only" when a replica actually exists
 * costs somebody a moment of doubt; "Synced" when the queue is stuck costs them
 * their work.
 *
 * Four inputs, because any one of them alone lies:
 *
 *   - the **configuration** — with no `VITE_CONVEX_URL` there is no deployment
 *     and the queue would sit at `idle` forever, which reads as success;
 *   - the **identity** — a configured deployment plus a signed-out browser also
 *     sits at `idle`, and nothing has been or will be sent;
 *   - the **link** — an unclaimed project has no replica to fall behind, so its
 *     `idle` means "not in the cloud", not "up to date";
 *   - the **connection** — an empty queue proves nothing while the browser is
 *     offline, because nothing has been attempted since it went down.
 */

export interface SyncReadout {
  /** The state-machine status. Exactly the six the sync layer publishes. */
  status: SyncStatus
  /** Two or three words, for the status bar. */
  label: string
  /** Always populated, for every status including `idle`. Never null. */
  reason: string
  /** What repairs it, when anything can. */
  repair: string | null
  tone: 'neutral' | 'active' | 'warn' | 'error'
  pending: number
  lastSyncedAt: string | null
  /** The head the local tail has to rebase onto, while `conflict`. */
  conflictHeadRevision: number | null
  /** Stable machine code for choosing a recovery without reaching into runtime state. */
  code: CloudErrorCode | null
}

export interface SyncReadoutInput {
  configuration: CloudConfiguration
  identity: CloudIdentity
  sync: SyncState
  /** True when the open project has a recorded cloud replica. */
  linked: boolean
  online: boolean
  /** Identifies whether the global queue head belongs to the open project. */
  activeProjectId?: string
  blockedProjectName?: string | null
}

const time = (iso: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString()
}

export function describeSync(input: SyncReadoutInput): SyncReadout {
  const { configuration, identity, sync, linked, online } = input
  const base = {
    pending: sync.pending,
    lastSyncedAt: sync.lastSyncedAt,
    conflictHeadRevision: sync.conflict?.headRevision ?? null,
    code: sync.lastError?.code ?? null,
  }

  const blockedElsewhere =
    sync.blocked !== null &&
    input.activeProjectId !== undefined &&
    sync.blocked.localProjectId !== input.activeProjectId

  if (blockedElsewhere && (sync.status === 'conflict' || sync.status === 'error')) {
    const project = input.blockedProjectName ? ` “${input.blockedProjectName}”` : ' another project'
    return {
      ...base,
      status: sync.status,
      label: 'Sync blocked',
      reason: `Sync is blocked by${project}; the open project is not the one that was refused.`,
      repair: 'Open that project to inspect and repair its queued change.',
      tone: sync.status === 'conflict' ? 'warn' : 'error',
    }
  }

  // 1. No deployment. The editor is whole; it just has nowhere to replicate to.
  if (configuration.status === 'unconfigured') {
    return {
      ...base,
      status: 'unconfigured',
      label: 'Local only',
      reason:
        configuration.reason ??
        'No cloud deployment is configured; projects are saved in this browser only.',
      repair: 'Set VITE_CONVEX_URL to a Convex deployment to save projects to the cloud.',
      tone: 'neutral',
    }
  }

  // 2. Failures the queue has actually observed outrank everything below, because
  //    they are the only statuses backed by a real attempt.
  if (sync.status === 'conflict') {
    return {
      ...base,
      status: 'conflict',
      label: 'Conflict',
      reason: sync.reason ?? 'The cloud has moved on from the revision this browser sent.',
      repair: 'Reconcile the divergence: the local tail is kept and replays onto a fork.',
      tone: 'warn',
    }
  }
  if (sync.status === 'error') {
    return {
      ...base,
      status: 'error',
      label: 'Sync stopped',
      reason: sync.reason ?? 'A queued change was refused and the queue has stopped.',
      repair:
        'Your work is saved in this browser. The queue is parked rather than skipping the entry, so nothing is missing from the log.',
      tone: 'error',
    }
  }
  if (sync.status === 'offline') {
    return {
      ...base,
      status: 'offline',
      label: 'Offline',
      reason: sync.reason ?? 'The cloud is unreachable.',
      repair: 'Keep working; queued changes are sent when the connection returns.',
      tone: 'warn',
    }
  }
  if (sync.status === 'syncing') {
    return {
      ...base,
      status: 'syncing',
      label: 'Syncing',
      reason: sync.reason ?? `Sending ${sync.pending} change(s).`,
      repair: null,
      tone: 'active',
    }
  }

  // 3. Nobody is signed in, so nothing was ever going to be sent.
  if (identity.status !== 'signed-in') {
    return {
      ...base,
      status: 'idle',
      label: 'Local only',
      reason:
        identity.reason ??
        'You are not signed in, so this browser is the only place these projects exist.',
      repair:
        identity.status === 'unavailable'
          ? 'The account layer is not available in this build; local projects keep working.'
          : 'Sign in to save this project to the cloud.',
      tone: 'neutral',
    }
  }

  // 4. Signed in, but this project has no replica.
  if (!linked) {
    return {
      ...base,
      status: 'idle',
      label: 'Local only',
      reason: 'This project is saved in this browser only; it has not been claimed into the cloud.',
      repair: 'Use “Save to cloud” in the Projects panel to claim it.',
      tone: 'neutral',
    }
  }

  // 5. Claimed, queue empty — but the browser is offline, so "empty" is not
  //    evidence of anything. Nothing has been attempted since the link dropped.
  if (!online) {
    return {
      ...base,
      status: 'offline',
      label: 'Offline',
      reason: sync.lastSyncedAt
        ? `This browser is offline. Nothing has reached the cloud since ${time(sync.lastSyncedAt)}.`
        : 'This browser is offline, and nothing has been sent to the cloud since the editor loaded.',
      repair: 'Edits stay durable in this browser and are queued for when the connection returns.',
      tone: 'warn',
    }
  }

  // 6. Claimed, online, queue empty, and this browser has watched a change land.
  //    The only branch allowed to say "synced".
  if (sync.lastSyncedAt) {
    return {
      ...base,
      status: 'idle',
      label: 'Synced',
      reason: `Every change up to ${time(sync.lastSyncedAt)} has been accepted by the cloud.`,
      repair: null,
      tone: 'neutral',
    }
  }

  // 7. Claimed and online, but this browser has sent nothing since it loaded.
  //    The replica may be complete — the claim uploaded it — but that is not
  //    something this session watched happen, so it does not claim it.
  return {
    ...base,
    status: 'idle',
    label: 'In the cloud',
    reason:
      'This project has a cloud replica. Nothing has been queued from this browser since the editor loaded.',
    repair: null,
    tone: 'neutral',
  }
}
