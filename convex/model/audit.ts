import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { redactAuditDetail } from './redaction'

/**
 * The audit trail.
 *
 * An audit log is only useful if an operator can hand it to somebody else, so
 * it records *what happened* and never *what the model contains*. Everything
 * written here goes through `redactAuditDetail` first; see `model/redaction.ts`
 * for the rule and why it is a positive filter.
 */

export { redactAuditDetail }
export type { AuditDetail } from './redaction'

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
