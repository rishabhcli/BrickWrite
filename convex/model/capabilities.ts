/**
 * The capability matrix — the single definition, owned by the server.
 *
 * The client mirrors this table so it can grey out an action it knows will be
 * refused, but the mirror is advisory: every mutation re-derives the caller's
 * role from the `members` table and checks it again. A capability matrix that
 * exists only in the browser is decoration, and one that exists twice drifts,
 * so `src/cloud/permissions.ts` imports this file rather than restating it.
 *
 * Deliberately dependency-free: it is evaluated inside a Convex function and
 * inside the browser bundle, so it may not import `convex/server`, React or the
 * CAD kernel.
 */

export type CloudRole = 'owner' | 'editor' | 'commenter' | 'viewer'

export type Capability =
  | 'project.read'
  | 'project.rename'
  | 'project.delete'
  | 'transaction.write'
  | 'snapshot.write'
  | 'version.create'
  | 'version.restore'
  | 'branch.create'
  | 'branch.propose'
  | 'branch.merge'
  | 'member.list'
  | 'member.invite'
  | 'member.setRole'
  | 'member.remove'
  | 'comment.read'
  | 'comment.create'
  | 'comment.resolve'
  | 'presence.publish'
  | 'audit.read'

/** Every capability, in declaration order, for exhaustive tests and UI listing. */
export const CAPABILITIES: readonly Capability[] = [
  'project.read',
  'project.rename',
  'project.delete',
  'transaction.write',
  'snapshot.write',
  'version.create',
  'version.restore',
  'branch.create',
  'branch.propose',
  'branch.merge',
  'member.list',
  'member.invite',
  'member.setRole',
  'member.remove',
  'comment.read',
  'comment.create',
  'comment.resolve',
  'presence.publish',
  'audit.read',
]

export const ROLES: readonly CloudRole[] = ['owner', 'editor', 'commenter', 'viewer']

/**
 * Role → capabilities.
 *
 * Three deliberate choices:
 *
 *   - A commenter may publish presence and write comments but not one document
 *     mutation, because a review seat that can silently edit the model is not a
 *     review seat.
 *   - An editor may open a branch and propose a merge but not land it. Landing
 *     someone else's work into `main` is an owner decision.
 *   - Only an owner reads the audit log or changes roles, because both of those
 *     are how a compromised editor seat would escalate.
 */
export const CAPABILITY_MATRIX: Readonly<Record<CloudRole, readonly Capability[]>> = {
  owner: CAPABILITIES,
  editor: [
    'project.read',
    'project.rename',
    'transaction.write',
    'snapshot.write',
    'version.create',
    'version.restore',
    'branch.create',
    'branch.propose',
    'member.list',
    'comment.read',
    'comment.create',
    'comment.resolve',
    'presence.publish',
  ],
  commenter: ['project.read', 'member.list', 'comment.read', 'comment.create', 'presence.publish'],
  viewer: ['project.read', 'member.list', 'comment.read', 'presence.publish'],
}

const INDEXED: Readonly<Record<CloudRole, ReadonlySet<Capability>>> = {
  owner: new Set(CAPABILITY_MATRIX.owner),
  editor: new Set(CAPABILITY_MATRIX.editor),
  commenter: new Set(CAPABILITY_MATRIX.commenter),
  viewer: new Set(CAPABILITY_MATRIX.viewer),
}

/** True when `role` holds `capability`. A null role is a non-member. */
export function roleAllows(role: CloudRole | null | undefined, capability: Capability): boolean {
  if (!role) return false
  return INDEXED[role].has(capability)
}

/** Narrowing guard for values arriving from storage or the wire. */
export function isCloudRole(value: unknown): value is CloudRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}
