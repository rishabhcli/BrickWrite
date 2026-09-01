import { redactAuditDetail } from './redaction'

/**
 * Structured logs from the Convex deployment.
 *
 * The other two backend surfaces already emit one JSON object per failure —
 * `server/log.ts` to stderr, `functions/_lib/log.ts` through `console.error`.
 * Convex emitted nothing at all, so a failing invitation send or a rejected
 * delivery credential was visible only as a `deliveryStatus` column somebody
 * had to go and look at.
 *
 * The shape here matches the other two on purpose: `ts`, `level`, `service`,
 * `message`, `cause`. One aggregator query should find a failure wherever in
 * this system it happened, and three log formats is three queries and two of
 * them forgotten. Convex ships `console.*` to its own log stream, which is what
 * an Axiom/Datadog sink subscribes to; see `docs/deployment.md`.
 *
 * **Nothing content-bearing may be passed here.** This deployment stores an
 * email address in exactly one table and copies it nowhere; a log line is a
 * copy. `detail` is therefore restricted to the same scalar record the audit
 * trail accepts, and runs through the same redactor.
 */

export type LogLevel = 'info' | 'error'

/** Model and delivery credentials, matched by shape rather than by name. */
export function redactConvexText(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ***')
    .replace(/HEXCLAVE_SECRET_SERVER_KEY|INVITATION_EMAIL_TOKEN/g, '[REDACTED_ENV]')
    // An address is content. It reaches a log only by mistake, and this is the
    // rule that makes the mistake cheap.
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, '[REDACTED_EMAIL]')
}

export function logConvexEvent(event: {
  readonly level: LogLevel
  readonly service: string
  readonly message: string
  readonly detail?: Record<string, string | number | boolean>
  readonly cause?: unknown
}): void {
  const payload = {
    ts: new Date().toISOString(),
    level: event.level,
    service: event.service,
    message: redactConvexText(event.message),
    detail: event.detail ? redactAuditDetail(event.detail) : undefined,
    cause:
      event.cause === undefined
        ? undefined
        : redactConvexText(
            event.cause instanceof Error ? (event.cause.stack ?? event.cause.message) : String(event.cause),
          ),
  }
  const line = JSON.stringify(payload)
  if (event.level === 'error') console.error(line)
  else console.log(line)
}
