import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { roleAllows, type Capability, type CloudRole } from './capabilities'
import { identityFromClaims, type CloudIdentity } from './identity'
import { cloudFailure, type CloudErrorShape, type CloudResult } from './protocol'

export type { CloudIdentity } from './identity'

/**
 * Server-side identity and authorisation.
 *
 * Every public function in this deployment starts here. Two rules hold without
 * exception:
 *
 *   1. Identity is whatever `ctx.auth.getUserIdentity()` says and nothing else.
 *      No function accepts a subject, an owner or a role as an argument — a
 *      caller that could name itself could name anybody.
 *   2. A caller that is not a member of a private project is told `NOT_FOUND`,
 *      not `FORBIDDEN`. `FORBIDDEN` confirms the project exists, which is a
 *      fact a stranger is not entitled to. Members who simply lack the
 *      capability do get `FORBIDDEN`, because for them the existence of the
 *      project is not a secret.
 */

/**
 * Reads the caller's identity.
 *
 * `tokenIdentifier` is used rather than `subject` where available because it is
 * issuer-qualified: two identity providers can both mint `sub: "1"`, and a
 * project owned by one of them must not be reachable by the other.
 */
export async function readIdentity(ctx: QueryCtx | MutationCtx): Promise<CloudIdentity | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return null
  // `email` is deliberately not read here. Nothing downstream stores it, and a
  // value that is never loaded cannot be leaked by a later careless spread.
  return identityFromClaims(identity)
}

export const UNAUTHENTICATED: CloudErrorShape = {
  code: 'UNAUTHENTICATED',
  message: 'This request carried no signed-in identity.',
  repair: 'Sign in, then retry. Local projects keep working while signed out.',
}

const notFound = (): CloudErrorShape => ({
  code: 'NOT_FOUND',
  message: 'That project is not available to this account.',
  repair: 'Check the project link, or ask its owner for access.',
})

export interface AuthorisedProject {
  identity: CloudIdentity
  project: Doc<'projects'>
  role: CloudRole
}

/** Resolves the caller's membership row, or null when they are not a member. */
export async function memberRole(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'projects'>,
  subject: string,
): Promise<CloudRole | null> {
  const membership = await ctx.db
    .query('members')
    .withIndex('by_project_subject', (q) => q.eq('projectId', projectId).eq('subject', subject))
    .unique()
  return membership?.role ?? null
}

/**
 * The single authorisation gate.
 *
 * Resolves identity, loads the project, derives the caller's role from the
 * `members` table and checks the capability against the matrix. A public
 * project grants an implicit `viewer` role so that a share link works without
 * anybody being added as a member — read-only, and never for a mutation, since
 * no mutating capability is in the viewer row of the matrix.
 */
export async function authoriseProject(
  ctx: QueryCtx | MutationCtx,
  projectId: string,
  capability: Capability,
): Promise<CloudResult<AuthorisedProject>> {
  const identity = await readIdentity(ctx)
  if (!identity) return { ok: false, error: UNAUTHENTICATED }

  const project = await ctx.db.get(projectId as Id<'projects'>)
  if (!project || project.deletedAt !== undefined) return { ok: false, error: notFound() }

  const explicit = await memberRole(ctx, project._id, identity.subject)
  const role: CloudRole | null = explicit ?? (project.visibility === 'public' ? 'viewer' : null)
  if (!role) return { ok: false, error: notFound() }

  if (!roleAllows(role, capability)) {
    return cloudFailure(
      'FORBIDDEN',
      `A ${role} may not ${capability.replace('.', ' ')} on this project.`,
      'Ask an owner to raise your role on this project.',
      { role, capability },
    )
  }
  return { ok: true, value: { identity, project, role } }
}

/**
 * Resolves a branch within an already-authorised project.
 *
 * A branch id from another project is treated as absent rather than followed:
 * an id is not a capability, and cross-project branch ids are exactly how one
 * would try to write into somebody else's history.
 */
export async function resolveBranch(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'projects'>,
  branchId?: string,
): Promise<CloudResult<Doc<'branches'>>> {
  const id = (branchId ?? project.defaultBranchId) as Id<'branches'> | undefined
  if (!id) {
    return cloudFailure(
      'NOT_FOUND',
      'This project has no branch to write to.',
      'Reopen the project; its default branch is created with it.',
    )
  }
  const branch = await ctx.db.get(id)
  if (!branch || branch.projectId !== project._id) {
    return cloudFailure(
      'NOT_FOUND',
      'That branch does not belong to this project.',
      'Reload the branch list and choose again.',
    )
  }
  return { ok: true, value: branch }
}

export const iso = (epochMs: number) => new Date(epochMs).toISOString()
