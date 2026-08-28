import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  isCloudRole,
  roleAllows,
  ROLES,
  type Capability,
  type CloudRole,
} from '../../convex/model/capabilities'

/**
 * The capability matrix on the client.
 *
 * Imported from the deployment directory rather than restated, because two
 * copies of an authorisation table drift and the copy that drifts is always the
 * permissive one. The server checks every mutation against this same data; what
 * the client adds is presentation — knowing in advance that a viewer's "delete"
 * button would be refused, so it can be disabled instead of failing on click.
 *
 * Nothing here is a security boundary. A caller that skips these helpers gets
 * the same answer from the deployment, one round trip later.
 */

export type { Capability, CloudRole }
export { CAPABILITIES, CAPABILITY_MATRIX, ROLES, isCloudRole, roleAllows }

/** Capabilities `role` holds, in declaration order. */
export function capabilitiesFor(role: CloudRole | null | undefined): readonly Capability[] {
  if (!role) return []
  return CAPABILITY_MATRIX[role]
}

/**
 * Why an action is unavailable, in words an operator can act on.
 *
 * Returns null when the action is allowed, so a caller can use it directly as
 * the disabled-reason for a control.
 */
export function refusalReason(
  role: CloudRole | null | undefined,
  capability: Capability,
): string | null {
  if (roleAllows(role, capability)) return null
  if (!role) return 'You are not a member of this project.'
  const holders = ROLES.filter((candidate) => roleAllows(candidate, capability))
  if (holders.length === 0) return 'No role can do that.'
  return `Only ${holders.join(' or ')} can do that; you are ${role}.`
}

/** True when `role` is at least as capable as `atLeast` on every capability. */
export function roleAtLeast(role: CloudRole | null | undefined, atLeast: CloudRole): boolean {
  if (!role) return false
  return CAPABILITY_MATRIX[atLeast].every((capability) => roleAllows(role, capability))
}
