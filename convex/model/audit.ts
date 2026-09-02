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

/**
 * Which question an event answers.
 *
 * `content` is somebody changing the model or its annotations; `control` is
 * somebody changing who may do that, or whether the project exists. An audit is
 * read for the second, and the first outnumbers it by whole orders of magnitude
 * — an edit session writes an event per sync, a role change writes one a
 * quarter. Recording the split is what lets `auditTrail` answer the question it
 * is for instead of returning five hundred brick movements.
 */
export type AuditCategory = 'content' | 'control'

/**
 * Actions that record a change to the model.
 *
 * A positive list, so an action added later is `control` until somebody says
 * otherwise: appearing in an audit that did not need it is recoverable, and
 * being absent from one that did is not.
 */
const CONTENT_ACTIONS: ReadonlySet<string> = new Set([
  'transaction.append',
  'project.checkpoint',
  'version.create',
  'comment.create',
  'branch.create',
  'branch.propose',
])

export const auditCategory = (action: string): AuditCategory =>
  CONTENT_ACTIONS.has(action) ? 'content' : 'control'

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
    category: auditCategory(args.action),
    at: Date.now(),
    detail: redactAuditDetail(args.detail ?? {}),
  })
}
