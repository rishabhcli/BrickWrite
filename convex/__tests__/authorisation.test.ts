// @vitest-environment edge-runtime
import type { FunctionReference } from 'convex/server'
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { CAPABILITIES, CAPABILITY_MATRIX, ROLES, type Capability, type CloudRole } from '../model/capabilities'
import {
  anonymous,
  codeOf,
  harness,
  person,
  restricted,
  seedProject,
  snapshotUpload,
  subjectOf,
  type Identity,
  type SeededProject,
} from './harness'

/**
 * The authorisation gate, against the handlers that enforce it.
 *
 * Three properties are asserted here that no unit test of the matrix can reach,
 * because all three are about the wiring rather than the table:
 *
 *   1. Every public function routes through `authoriseProject` with the
 *      capability its name implies. A mutation that forgot to call the gate, or
 *      called it with a weaker capability than it needs, passes a matrix test
 *      and fails this one.
 *   2. A non-member is told `NOT_FOUND`, not `FORBIDDEN`. `FORBIDDEN` confirms
 *      the project exists, which `model/auth.ts` documents as a fact a stranger
 *      is not entitled to.
 *   3. An anonymous or restricted token is not a principal, at the database
 *      layer and not only at the paid HTTP route.
 */

type ProbeArgs = (seed: SeededProject) => Record<string, never>

/**
 * Discriminated rather than a union of references: `t.query` and `t.mutation`
 * accept different reference types, and a single field typed as either would
 * satisfy neither without a cast at the call site.
 */
type Probe =
  | { readonly kind: 'query'; readonly fn: FunctionReference<'query', 'public'>; readonly args: ProbeArgs }
  | { readonly kind: 'mutation'; readonly fn: FunctionReference<'mutation', 'public'>; readonly args: ProbeArgs }

const q = (fn: FunctionReference<'query', 'public'>, args: (seed: SeededProject) => Record<string, unknown>): Probe =>
  ({ kind: 'query', fn, args: args as ProbeArgs })
const m = (fn: FunctionReference<'mutation', 'public'>, args: (seed: SeededProject) => Record<string, unknown>): Probe =>
  ({ kind: 'mutation', fn, args: args as ProbeArgs })

/**
 * One call per capability, made at the role under test.
 *
 * Arguments are deliberately valid. A call refused by argument validation would
 * satisfy a "was not forbidden" assertion for the wrong reason, and would keep
 * satisfying it after the gate was removed.
 */
const PROBES: Readonly<Record<Exclude<Capability, 'version.restore'>, Probe>> = {
  'project.read': q(api.projects.get, (s) => ({ projectId: s.projectId })),
  'project.rename': m(api.projects.rename, (s) => ({ projectId: s.projectId, name: 'Renamed' })),
  'project.delete': m(api.projects.remove, (s) => ({ projectId: s.projectId })),
  'transaction.write': m(api.transactions.append, (s) => ({
    projectId: s.projectId,
    branchId: s.branchId,
    clientTransactionId: 'tx-authorisation-probe',
    baseRevision: 0,
    resultRevision: 1,
    transaction: { kind: 'probe' },
    checksum: 'probe',
    schemaVersion: 2,
    catalogVersion: 'fixture-1',
  })),
  'snapshot.write': m(api.projects.saveCheckpoint, (s) => ({
    projectId: s.projectId,
    snapshot: snapshotUpload(),
  })),
  'version.create': m(api.versions.create, (s) => ({
    projectId: s.projectId,
    branchId: s.branchId,
    label: 'v1',
    snapshot: snapshotUpload(),
  })),
  'branch.create': m(api.versions.createBranch, (s) => ({
    projectId: s.projectId,
    name: 'from-probe',
    fromBranchId: s.branchId,
  })),
  'branch.propose': m(api.versions.proposeMerge, (s) => ({
    projectId: s.projectId,
    branchId: s.sideBranchId,
    summary: 'probe',
  })),
  'branch.merge': m(api.versions.decideMerge, (s) => ({
    projectId: s.projectId,
    branchId: s.proposedBranchId,
    decision: 'rejected',
  })),
  'member.list': q(api.members.list, (s) => ({ projectId: s.projectId })),
  'member.invite': m(api.invitations.create, (s) => ({
    projectId: s.projectId,
    email: 'probe@example.test',
    role: 'viewer',
  })),
  'member.setRole': m(api.members.setRole, (s) => ({
    projectId: s.projectId,
    subject: subjectOf('bystander'),
    role: 'viewer',
  })),
  // Removing somebody else. Removing yourself is authorised as a plain read,
  // because leaving does not need an owner's consent.
  'member.remove': m(api.members.remove, (s) => ({
    projectId: s.projectId,
    subject: subjectOf('bystander'),
  })),
  'comment.read': q(api.comments.list, (s) => ({ projectId: s.projectId })),
  'comment.create': m(api.comments.add, (s) => ({
    projectId: s.projectId,
    body: 'probe',
    anchor: { partId: 'part-1', revision: 0, poseChecksum: 'probe' },
  })),
  'comment.resolve': m(api.comments.setStatus, (s) => ({
    projectId: s.projectId,
    commentId: s.commentId,
    status: 'resolved',
  })),
  'presence.publish': m(api.presence.heartbeat, (s) => ({
    projectId: s.projectId,
    sessionId: 'probe-session',
    revision: 0,
    selection: [],
  })),
  'audit.read': q(api.projects.auditTrail, (s) => ({ projectId: s.projectId })),
}

/** The gate's own refusal. Any other code means the gate was never reached. */
const REFUSED = 'FORBIDDEN'

const probed = Object.keys(PROBES) as Array<Exclude<Capability, 'version.restore'>>

async function call(t: ReturnType<typeof harness>, as: Identity, probe: Probe, seed: SeededProject) {
  const caller = t.withIdentity(as)
  const args = probe.args(seed)
  return probe.kind === 'query' ? caller.query(probe.fn, args) : caller.mutation(probe.fn, args)
}

describe('capability matrix, enforced by the real handlers', () => {
  test('every capability is either probed or recorded as unenforced', () => {
    expect([...probed, 'version.restore'].sort()).toEqual([...CAPABILITIES].sort())
  })

  /**
   * `version.restore` is in the matrix and in no handler.
   *
   * `versions.document` — the only read a restore performs — gates on
   * `project.read`, so a viewer can fetch any version's document and the client
   * applies it locally. The capability is therefore advisory: it greys out a
   * button and nothing more. Asserted rather than deleted because removing a
   * capability changes `src/cloud/permissions.ts` too; this pins the current,
   * documented reality so it cannot drift unnoticed.
   */
  test('version.restore is enforced by no handler', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      Promise.all(
        ['projects', 'versions', 'members', 'comments', 'invitations', 'presence', 'transactions', 'discovery'].map(
          (name) => fs.readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8'),
        ),
      ),
    )
    expect(source.join('\n')).not.toContain("'version.restore'")
  })

  for (const role of ROLES) {
    for (const capability of probed) {
      const allowed = CAPABILITY_MATRIX[role].includes(capability)
      test(`${role} ${allowed ? 'may' : 'may not'} ${capability}`, async () => {
        const t = harness()
        const actor = 'actor'
        const seed = await seedProject(t, {
          owner: role === 'owner' ? actor : 'owner-account',
          members: role === 'owner' ? { bystander: 'viewer' } : { [actor]: role, bystander: 'viewer' },
        })
        const result = await call(t, person(actor), PROBES[capability], seed)

        if (allowed) {
          // The call may still fail on its own terms — an already-proposed
          // branch is `INVALID_ARGUMENT`, not a refusal. What must not appear is
          // the gate's own code.
          expect(codeOf(result as never)).not.toBe(REFUSED)
        } else {
          expect(codeOf(result as never)).toBe(REFUSED)
        }
      })
    }
  }
})

describe('a stranger is not told the project exists', () => {
  for (const capability of probed) {
    test(`${capability} answers NOT_FOUND to a non-member`, async () => {
      const t = harness()
      const seed = await seedProject(t, { owner: 'owner-account', members: { bystander: 'viewer' } })
      const result = await call(t, person('stranger'), PROBES[capability], seed)
      expect(codeOf(result as never)).toBe('NOT_FOUND')
    })
  }

  test('a deleted project is NOT_FOUND even to its owner', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', deleted: true })
    const result = await t.withIdentity(person('owner-account')).query(api.projects.get, { projectId: seed.projectId })
    expect(codeOf(result as never)).toBe('NOT_FOUND')
  })
})

describe('public projects grant an implicit viewer, and nothing more', () => {
  test('a signed-in stranger may read a public project', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', visibility: 'public' })
    const result = await t.withIdentity(person('stranger')).query(api.projects.get, { projectId: seed.projectId })
    expect(codeOf(result as never)).toBe('ok')
  })

  for (const capability of probed) {
    const implicit = CAPABILITY_MATRIX.viewer.includes(capability)
    test(`implicit viewer ${implicit ? 'may' : 'may not'} ${capability}`, async () => {
      const t = harness()
      const seed = await seedProject(t, { owner: 'owner-account', visibility: 'public', members: { bystander: 'viewer' } })
      const result = await call(t, person('stranger'), PROBES[capability], seed)
      const code = codeOf(result as never)
      if (implicit) expect(code).not.toBe(REFUSED)
      else expect(code).toBe(REFUSED)
    })
  }

  test('publishing a model does not publish the member roster', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', visibility: 'public', members: { colleague: 'editor' } })
    const result = await t.withIdentity(person('stranger')).query(api.members.list, { projectId: seed.projectId })
    expect(codeOf(result as never)).toBe(REFUSED)
  })

  test('publishing a model does not publish live presence', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', visibility: 'public' })
    const stranger = t.withIdentity(person('stranger'))
    expect(codeOf((await stranger.query(api.presence.list, { projectId: seed.projectId })) as never)).toBe(REFUSED)
    expect(
      codeOf(
        (await stranger.mutation(api.presence.heartbeat, {
          projectId: seed.projectId,
          sessionId: 's',
          revision: 0,
          selection: [],
        })) as never,
      ),
    ).toBe(REFUSED)
  })

  test('an unlisted project grants no implicit role at all', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', visibility: 'unlisted' })
    const result = await t.withIdentity(person('stranger')).query(api.projects.get, { projectId: seed.projectId })
    expect(codeOf(result as never)).toBe('NOT_FOUND')
  })
})

describe('a token is not automatically a principal', () => {
  test('no identity is UNAUTHENTICATED', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    expect(codeOf((await t.query(api.projects.get, { projectId: seed.projectId })) as never)).toBe('UNAUTHENTICATED')
  })

  for (const [label, claims] of [
    ['anonymous', anonymous('owner-account')],
    ['restricted', restricted('owner-account')],
  ] as const) {
    test(`an ${label} token is refused even when it names the owner`, async () => {
      const t = harness()
      const seed = await seedProject(t, { owner: 'owner-account' })
      const caller = t.withIdentity(claims)
      expect(codeOf((await caller.query(api.projects.get, { projectId: seed.projectId })) as never)).toBe('UNAUTHENTICATED')
      expect(codeOf((await caller.query(api.projects.list, {})) as never)).toBe('UNAUTHENTICATED')
      expect(
        codeOf((await caller.mutation(api.projects.rename, { projectId: seed.projectId, name: 'x' })) as never),
      ).toBe('UNAUTHENTICATED')
    })
  }

  test('a token from the anonymous issuer is refused however it is shaped', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account' })
    const result = await t
      .withIdentity({
        subject: 'owner-account',
        tokenIdentifier: 'https://hexclave.test/api/v1/projects-anonymous-users/p1|owner-account',
        issuer: 'https://hexclave.test/api/v1/projects-anonymous-users/p1',
      })
      .query(api.projects.get, { projectId: seed.projectId })
    expect(codeOf(result as never)).toBe('UNAUTHENTICATED')
  })
})

/**
 * Losing a role takes what the role earned with it.
 *
 * Four destructive mutations read `project.read` and then accepted a creator
 * match in place of a capability. `viewer` holds `project.read`, and a public
 * project hands an implicit `viewer` to any signed-in stranger — so removal
 * from a public project revoked nothing, and demotion on a private one revoked
 * nothing either. `versions.removeBranch` cascades to every transaction and
 * checkpoint on the branch, so this was history a non-member could destroy.
 */
describe('a creator who lost the role that let them create', () => {
  /** A branch and a named version on it, both authored by `actor`. */
  async function seedOwnWork(t: ReturnType<typeof harness>, actor: string, role: CloudRole | null) {
    const seed = await seedProject(t, {
      owner: 'owner-account',
      visibility: 'public',
      members: role ? { [actor]: role } : {},
    })
    const branchId = await t.run(async (ctx) => {
      const now = Date.now()
      return ctx.db.insert('branches', {
        projectId: seed.projectId as Id<'projects'>,
        name: 'actor-work',
        headRevision: 0,
        baseRevision: 0,
        kind: 'named',
        createdBySubject: subjectOf(actor),
        createdAt: now,
        updatedAt: now,
        forkedFromBranchId: seed.branchId as Id<'branches'>,
      })
    })
    return { ...seed, ownBranchId: branchId }
  }

  test('a removed member of a public project may not delete the branch they made', async () => {
    const t = harness()
    // No membership row at all: the implicit viewer a public project grants is
    // the whole of this caller's standing.
    const seed = await seedOwnWork(t, 'ex-editor', null)
    const result = await t
      .withIdentity(person('ex-editor'))
      .mutation(api.versions.removeBranch, { projectId: seed.projectId, branchId: seed.ownBranchId })
    expect(codeOf(result as never)).toBe('FORBIDDEN')

    const survived = await t.run(async (ctx) => ctx.db.get(seed.ownBranchId as Id<'branches'>))
    expect(survived).not.toBeNull()
  })

  test('a member demoted to viewer may not delete the branch they made', async () => {
    const t = harness()
    const seed = await seedOwnWork(t, 'demoted', 'viewer')
    const result = await t
      .withIdentity(person('demoted'))
      .mutation(api.versions.removeBranch, { projectId: seed.projectId, branchId: seed.ownBranchId })
    expect(codeOf(result as never)).toBe('FORBIDDEN')
  })

  test('an editor who still holds branch.create may still delete their own branch', async () => {
    const t = harness()
    const seed = await seedOwnWork(t, 'editor-account', 'editor')
    const result = await t
      .withIdentity(person('editor-account'))
      .mutation(api.versions.removeBranch, { projectId: seed.projectId, branchId: seed.ownBranchId })
    expect(codeOf(result as never)).toBe('ok')
  })

  test('a commenter demoted to viewer may not resolve the thread they opened', async () => {
    const t = harness()
    const seed = await seedProject(t, { owner: 'owner-account', visibility: 'public', members: { demoted: 'viewer' } })
    const commentId = await t.run(async (ctx) => {
      const now = Date.now()
      return ctx.db.insert('comments', {
        projectId: seed.projectId as Id<'projects'>,
        branchId: seed.branchId as Id<'branches'>,
        authorSubject: subjectOf('demoted'),
        authorDisplayName: 'demoted',
        body: 'Mine',
        anchor: { partId: 'part-1', revision: 0, poseChecksum: 'seed' },
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })
    })
    const result = await t
      .withIdentity(person('demoted'))
      .mutation(api.comments.setStatus, { projectId: seed.projectId, commentId, status: 'resolved' })
    expect(codeOf(result as never)).toBe('FORBIDDEN')
  })
})
