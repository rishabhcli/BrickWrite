import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/**
 * The audit trail, and the filter that keeps it safe to read.
 *
 * An audit log is only useful if an operator can hand it to someone else, so it
 * records *what happened* and never *what the model contains*. The filter is
 * positive rather than negative: a value survives only if it is a finite
 * number, a boolean, or a short identifier-shaped string. That rejects project
 * names, part descriptions, comment bodies and email addresses without needing
 * to enumerate them, and a dropped key is named in the `redacted` field rather
 * than vanishing, so the log never quietly loses a field it was asked to write.
 */

/** Identifiers, revisions, role names, error codes — nothing free-form. */
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

export async function writeAuditEvent(
  ctx: MutationCtx,
  args: {
    projectId: Id<'projects'>
    actorSubject: string
    action: string
    detail?: Record<string, unknown>
  },
): Promise<void> {
  await ctx.db.insert('auditEvents', {
    projectId: args.projectId,
    actorSubject: args.actorSubject,
    action: args.action,
    at: Date.now(),
    detail: redactAuditDetail(args.detail ?? {}),
  })
}
