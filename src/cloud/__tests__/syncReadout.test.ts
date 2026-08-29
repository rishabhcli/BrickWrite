import { describe, expect, it } from 'vitest'
import { UNCONFIGURED_SYNC_STATE, type SyncState } from '../outbox'
import { describeSync } from '../syncReadout'
import { SIGNED_OUT_IDENTITY, type CloudConfiguration, type CloudIdentity } from '../runtime'

/**
 * The one rule: never print "Synced" without evidence.
 *
 * Everything else in this workstream is verifiable by reading a database. The
 * status line is what most people will ever see of it, so its honesty is
 * checked here as a property, over every state the machine can be in.
 */

const READY: CloudConfiguration = { status: 'ready', reason: null, url: 'https://d.test' }
const UNCONFIGURED: CloudConfiguration = {
  status: 'unconfigured',
  reason: 'VITE_CONVEX_URL is not set, so there is no cloud deployment to talk to.',
  url: null,
}
const SIGNED_IN: CloudIdentity = { status: 'signed-in', reason: null, userId: 'hexclave|alice', label: 'Alice' }

const idle: SyncState = {
  status: 'idle',
  reason: null,
  pending: 0,
  lastSyncedAt: null,
  lastError: null,
  conflict: null,
  blocked: null,
}

const sync = (over: Partial<SyncState> = {}): SyncState => ({ ...idle, ...over })

describe('describeSync', () => {
  it('reports the unconfigured deployment with its reason, not as an error', () => {
    const readout = describeSync({
      configuration: UNCONFIGURED,
      identity: SIGNED_OUT_IDENTITY,
      sync: UNCONFIGURED_SYNC_STATE,
      linked: false,
      online: true,
    })
    expect(readout.status).toBe('unconfigured')
    expect(readout.label).toBe('Local only')
    expect(readout.tone).toBe('neutral')
    expect(readout.reason).toContain('VITE_CONVEX_URL')
    expect(readout.repair).toContain('VITE_CONVEX_URL')
  })

  it('says local-only, with the identity reason, when nobody is signed in', () => {
    const readout = describeSync({
      configuration: READY,
      identity: SIGNED_OUT_IDENTITY,
      sync: sync(),
      linked: false,
      online: true,
    })
    expect(readout.label).toBe('Local only')
    expect(readout.reason).toContain('not signed in')
    expect(readout.repair).toContain('Sign in')
  })

  it('distinguishes an unclaimed project from a synced one', () => {
    const readout = describeSync({
      configuration: READY,
      identity: SIGNED_IN,
      sync: sync(),
      linked: false,
      online: true,
    })
    expect(readout.status).toBe('idle')
    expect(readout.label).toBe('Local only')
    expect(readout.reason).toContain('has not been claimed')
  })

  it('will not say "Synced" for a claimed project this session has sent nothing for', () => {
    const readout = describeSync({
      configuration: READY,
      identity: SIGNED_IN,
      sync: sync(),
      linked: true,
      online: true,
    })
    expect(readout.label).toBe('In the cloud')
    expect(readout.label).not.toBe('Synced')
    expect(readout.reason).toContain('Nothing has been queued from this browser')
  })

  it('says "Synced" only once a change has actually been accepted', () => {
    const readout = describeSync({
      configuration: READY,
      identity: SIGNED_IN,
      sync: sync({ lastSyncedAt: '2026-08-28T09:00:00.000Z' }),
      linked: true,
      online: true,
    })
    expect(readout.label).toBe('Synced')
    expect(readout.reason).toContain('accepted by the cloud')
  })

  it('refuses to call an empty queue "synced" while the browser is offline', () => {
    const readout = describeSync({
      configuration: READY,
      identity: SIGNED_IN,
      sync: sync({ lastSyncedAt: '2026-08-28T09:00:00.000Z' }),
      linked: true,
      online: false,
    })
    expect(readout.status).toBe('offline')
    expect(readout.label).toBe('Offline')
    expect(readout.reason).toContain('Nothing has reached the cloud since')
  })

  it('carries the queue’s own reason for syncing, offline, conflict and error', () => {
    const states: Array<[SyncState['status'], string, string]> = [
      ['syncing', 'Sending 3 change(s).', 'Syncing'],
      ['offline', 'The cloud is unreachable: fetch failed.', 'Offline'],
      ['conflict', 'Expected revision 4; the branch head is 6.', 'Conflict'],
      ['error', 'That change is larger than the deployment accepts.', 'Sync stopped'],
    ]
    for (const [status, reason, label] of states) {
      const readout = describeSync({
        configuration: READY,
        identity: SIGNED_IN,
        sync: sync({ status, reason, pending: 3 }),
        linked: true,
        online: true,
      })
      expect(readout.status).toBe(status)
      expect(readout.label).toBe(label)
      expect(readout.reason).toBe(reason)
      expect(readout.pending).toBe(3)
    }
  })

  it('surfaces the head a conflicted tail has to rebase onto', () => {
    const readout = describeSync({
      configuration: READY,
      identity: SIGNED_IN,
      sync: sync({
        status: 'conflict',
        reason: 'stale',
        conflict: { headRevision: 9, branchId: 'main' },
      }),
      linked: true,
      online: true,
    })
    expect(readout.conflictHeadRevision).toBe(9)
    expect(readout.tone).toBe('warn')
  })

  it('reports which project is blocking when it is not the open one', () => {
    const readout = describeSync({
      configuration: READY,
      identity: SIGNED_IN,
      sync: sync({
        status: 'conflict',
        reason: 'stale',
        lastError: {
          code: 'STALE_DOCUMENT',
          message: 'stale',
          repair: 'Reconcile.',
        },
        blocked: { projectId: 'cloud_a', localProjectId: 'doc_a' },
      }),
      linked: true,
      online: true,
      activeProjectId: 'doc_b',
      blockedProjectName: 'Rover chassis',
    })
    expect(readout.label).toBe('Sync blocked')
    expect(readout.reason).toContain('Rover chassis')
    expect(readout.code).toBe('STALE_DOCUMENT')
    expect(readout.repair).toContain('Open that project')
  })

  it('always populates a reason, in every reachable state', () => {
    const identities: CloudIdentity[] = [
      SIGNED_OUT_IDENTITY,
      SIGNED_IN,
      { status: 'expired', reason: 'Your session expired.' },
      { status: 'unavailable', reason: 'No account layer in this build.' },
      { status: 'restricted', reason: 'Verify your email.', userId: 'u', label: 'U' },
    ]
    const statuses: SyncState['status'][] = ['idle', 'syncing', 'offline', 'conflict', 'error']
    for (const configuration of [READY, UNCONFIGURED]) {
      for (const identity of identities) {
        for (const status of statuses) {
          for (const linked of [true, false]) {
            for (const online of [true, false]) {
              const readout = describeSync({
                configuration,
                identity,
                sync: sync({ status, reason: status === 'idle' ? null : `${status} reason` }),
                linked,
                online,
              })
              expect(readout.reason.length, `${configuration.status}/${identity.status}/${status}`).toBeGreaterThan(0)
              expect(readout.label.length).toBeGreaterThan(0)
              // "Synced" is only ever reachable with a watched acceptance.
              expect(readout.label).not.toBe('Synced')
            }
          }
        }
      }
    }
  })
})
