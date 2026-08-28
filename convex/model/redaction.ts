/**
 * The audit redaction filter.
 *
 * Split out of `model/audit.ts` because it is pure and is needed on both sides
 * of the wire: the deployment applies it before writing, and the client applies
 * the same rule when it renders an audit trail, so a row written by an older
 * deployment cannot surface content that today's filter would have removed.
 *
 * The rule is positive rather than negative: a value survives only if it is a
 * finite number, a boolean, or a short identifier-shaped string. That rejects
 * project names, part descriptions, comment bodies and email addresses without
 * having to enumerate them. A dropped key is named in `redacted` instead of
 * vanishing, so the log never quietly loses a field it was asked to write.
 */

/** Identifiers, revisions, role names, timestamps, error codes — nothing free-form. */
const IDENTIFIER = /^[A-Za-z0-9_.:\/|-]{1,64}$/

export type AuditDetail = Record<string, string | number | boolean>

export function redactAuditDetail(detail: Record<string, unknown>): AuditDetail {
  const safe: AuditDetail = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) safe[key] = value
      else dropped.push(key)
      continue
    }
    if (typeof value === 'boolean') {
      safe[key] = value
      continue
    }
    if (typeof value === 'string' && IDENTIFIER.test(value) && !value.includes('@')) {
      safe[key] = value
      continue
    }
    dropped.push(key)
  }
  if (dropped.length > 0) safe.redacted = dropped.sort().join(',')
  return safe
}
