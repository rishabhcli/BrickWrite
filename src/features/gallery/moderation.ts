import { createId } from '../../cad/ids'
import { LIMITS, sanitizeMultiline } from '../share/sanitize'
import { REPORT_REASONS, ShareError, type ModerationState, type Publication, type Report, type ReportReason } from '../share/types'
import { deepFreeze } from '../share/publish'

/**
 * Reports and moderation.
 *
 * A public gallery without a report path is a public gallery that will host
 * something it should not. This module is small on purpose: it validates a
 * report, records it, and applies a moderator's decision. It does not rank,
 * auto-hide, or score — every hide is a person's decision with a written
 * reason, and the reason is shown to the publisher.
 *
 * The reporter is stored as an opaque reference the caller supplies, never as
 * an identity. Whoever calls this owns the salting; this module refuses to
 * store anything that looks like an email address or a raw user id.
 */

export interface SubmitReportInput {
  publicationId: string
  slug: string
  reason: unknown
  detail: unknown
  /** Salted, opaque reference to the reporter. `null` for anonymous. */
  reporterRef?: string | null
  now?: Date
}

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value)
}

export function submitReport(input: SubmitReportInput): Report {
  if (!isReportReason(input.reason)) {
    throw new ShareError(
      'INVALID_INPUT',
      `"${String(input.reason)}" is not a report reason. Expected one of: ${REPORT_REASONS.join(', ')}.`,
    )
  }
  const detail = sanitizeMultiline(input.detail, LIMITS.reportDetail)
  if (input.reason === 'other' && detail.length < 10) {
    // "Other" with no explanation is unactionable, and a queue full of
    // unactionable reports is how real ones get missed.
    throw new ShareError('INVALID_INPUT', 'Tell us what is wrong — "other" needs at least a sentence.')
  }

  return deepFreeze({
    id: createId('rep'),
    publicationId: input.publicationId,
    slug: input.slug,
    reason: input.reason,
    detail,
    createdAt: (input.now ?? new Date()).toISOString(),
    status: 'open' as const,
    reporterRef: normaliseReporterRef(input.reporterRef ?? null),
    resolvedAt: null,
  })
}

/**
 * Refuses anything that looks like a real identity.
 *
 * The caller is meant to pass a salted hash. Accepting an email address because
 * it happened to be in the field is how a moderation table becomes a contact
 * list.
 */
function normaliseReporterRef(value: string | null): string | null {
  if (!value) return null
  if (value.includes('@') || value.includes(' ')) {
    throw new ShareError('INVALID_INPUT', 'A reporter reference must be an opaque hash, not an identity.')
  }
  return /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null
}

export function resolveReport(report: Report, status: 'upheld' | 'dismissed', now = new Date()): Report {
  if (report.status !== 'open') return report
  return deepFreeze({ ...report, status, resolvedAt: now.toISOString() })
}

/** Applies a moderator's decision to a publication. Never deletes it. */
export function applyModeration(
  publication: Publication,
  decision: { status: ModerationState['status']; reason: string; now?: Date },
): Publication {
  return deepFreeze({
    ...publication,
    moderation: {
      status: decision.status,
      reason: sanitizeMultiline(decision.reason, LIMITS.reportDetail),
      decidedAt: (decision.now ?? new Date()).toISOString(),
    },
  })
}

/** Open reports, newest first, grouped by publication for a review queue. */
export function moderationQueue(reports: readonly Report[]): Array<{ slug: string; reports: Report[] }> {
  const grouped = new Map<string, Report[]>()
  for (const report of reports) {
    if (report.status !== 'open') continue
    const bucket = grouped.get(report.slug)
    if (bucket) bucket.push(report)
    else grouped.set(report.slug, [report])
  }
  return [...grouped.entries()]
    .map(([slug, entries]) => ({
      slug,
      reports: [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }))
    // Most-reported first: the queue's job is to surface what needs a human
    // soonest, and repeat reports are the only signal available here.
    .sort((a, b) => b.reports.length - a.reports.length || a.slug.localeCompare(b.slug))
}
