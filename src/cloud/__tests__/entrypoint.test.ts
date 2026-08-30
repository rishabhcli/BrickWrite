import { describe, expect, it } from 'vitest'
import * as cloud from '../index'

/**
 * The published surface, pinned.
 *
 * `docs/integration/cloud-projects.md` tells nine other workstreams what they
 * may import from here. This test is what keeps that table from becoming
 * fiction: a rename that forgets the entry point fails here rather than in
 * somebody else's build.
 */

const RUNTIME_EXPORTS = [
  // integration seam
  'attachCloudSync',
  'settled',
  // permissions
  'CAPABILITY_MATRIX',
  'CAPABILITIES',
  'ROLES',
  'capabilitiesFor',
  'roleAllows',
  'roleAtLeast',
  'refusalReason',
  'isCloudRole',
  // stores
  'LocalProjectStore',
  'CloudProjectStore',
  'MirroredProjectStore',
  'ProjectLinks',
  // sync
  'Outbox',
  'startAutoDrain',
  'UNCONFIGURED_SYNC_STATE',
  'OUTBOX_CAPACITY',
  'RETRY_BASE_MS',
  'RETRY_CEILING_MS',
  // divergence
  'planRebase',
  'executeConflictFork',
  'scopeOf',
  'overlapOf',
  'isDisjoint',
  // claim
  'claimLocalProject',
  'claimIntegrityReport',
  'provenanceOf',
  'transactionIds',
  // versions
  'diffDocuments',
  'compareToVersion',
  'restorePlan',
  'summariseDiff',
  // comments
  'anchorFor',
  'resolveAnchor',
  'resolveAnchors',
  'threadsOf',
  'anchorSummary',
  // presence
  'PresenceSession',
  'presenceView',
  // client
  'createConvexCloud',
  'convexUrlFromEnv',
  'hexclaveTokenSource',
  'ConvexCloudBackend',
  // serialization
  'snapshotUploadFor',
  'documentChecksum',
  'transactionChecksum',
  'validateTransactionPayload',
  'poseChecksumOf',
  'canonicalJson',
  'checksumOf',
  'checksumOfText',
  'chunkText',
  'utf8Bytes',
  // protocol values
  'cloudFailure',
  'cloudSuccess',
  'MAX_SNAPSHOT_BYTES',
  'MAX_TRANSACTION_BYTES',
  'MAX_COMMENT_BYTES',
  'SNAPSHOT_CHUNK_BYTES',
  'PRESENCE_TTL_MS',
  // react
  'useSyncState',
  'useProjectList',
  'useAnchorReports',
  // function references
  'refs',
] as const

describe('published entry point', () => {
  it('exports everything the integration document promises', () => {
    const missing = RUNTIME_EXPORTS.filter(
      (name) => (cloud as Record<string, unknown>)[name] === undefined,
    )
    expect(missing).toEqual([])
  })

  it('exports no page UI', () => {
    // This workstream owns synchronisation, not screens. A React component
    // leaking out of here would put routing decisions in the wrong place.
    const components = Object.entries(cloud as Record<string, unknown>).filter(
      ([name, value]) => typeof value === 'function' && /^[A-Z]/.test(name) && name.endsWith('Page'),
    )
    expect(components).toEqual([])
  })

  it('names every capability in the matrix', () => {
    for (const role of cloud.ROLES) {
      for (const capability of cloud.CAPABILITY_MATRIX[role]) {
        expect(cloud.CAPABILITIES).toContain(capability)
      }
    }
    // Owner holds everything; nobody else holds the owner-only capabilities.
    expect([...cloud.CAPABILITY_MATRIX.owner].sort()).toEqual([...cloud.CAPABILITIES].sort())
    expect(cloud.roleAtLeast('owner', 'editor')).toBe(true)
    expect(cloud.roleAtLeast('editor', 'owner')).toBe(false)
    expect(cloud.refusalReason('viewer', 'transaction.write')).toContain('owner or editor')
    expect(cloud.refusalReason('owner', 'transaction.write')).toBeNull()
    expect(cloud.refusalReason(null, 'project.read')).toBe('You are not a member of this project.')
  })

  it('names a function reference for every deployment module', () => {
    expect(Object.keys(cloud.refs).sort()).toEqual([
      'comments',
      'invitations',
      'members',
      'presence',
      'projects',
      'transactions',
      'versions',
    ])
    expect(cloud.refs.transactions.append).toBeTruthy()
  })
})
