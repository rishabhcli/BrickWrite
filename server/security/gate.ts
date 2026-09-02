import { budgetStatus, checkBudget, recordUsage, type BudgetStatus, type UsageAmount } from './budget.js'
import { acquireSlot, concurrencyCeiling, concurrencyStatus, type ConcurrencyStatus } from './concurrency.js'
import type { RouteContext } from '../dispatch.js'

/**
 * The two spend controls, in the one order they are correct in.
 *
 * Both entry points ran paid routes and only one metered them: the Vercel
 * handler took a slot, read the ceiling and settled its writes, while the Node
 * process passed no context at all, so `reportUsage` was a no-op and a
 * configured counter counted nothing. Having the sequence written twice is what
 * let them differ, so it is written here once.
 *
 * The order is load-bearing. The slot comes first because it is what makes the
 * budget read mean anything — that read sees only *recorded* tokens, so without
 * a concurrency bound every caller in a burst reads the same total and passes.
 * Metering writes and the slot are both settled by `release`, before the
 * handler returns, because a serverless invocation may be frozen the moment it
 * does.
 *
 * Identity is the caller's problem. This module never decides who is asking; it
 * is handed a subject and meters against it.
 */

const PAID_PATHS = new Set(['/api/assistant', '/api/generate', '/api/brief'])

/** Only POSTs to a model-backed route spend anything. */
export const isPaidRequest = (pathname: string, method: string | undefined): boolean =>
  method === 'POST' && PAID_PATHS.has(pathname)

export interface GateRefusal {
  readonly status: number
  readonly code: string
  readonly detail: string
  readonly headers: Record<string, string>
}

export interface GateAdmission {
  readonly context: RouteContext
  /** Settles metering and hands the slot back. Never throws. */
  release(): Promise<void>
}

export type GateResult =
  { readonly ok: true; readonly admission: GateAdmission } | { readonly ok: false; readonly refusal: GateRefusal }

export interface GateStatus {
  readonly metering: BudgetStatus
  readonly concurrency: { readonly status: ConcurrencyStatus; readonly ceiling: number }
}

/** What `/api/health` reports about the controls in force. */
export const gateStatus = (): GateStatus => ({
  metering: budgetStatus(),
  concurrency: { status: concurrencyStatus(), ceiling: concurrencyCeiling() },
})

export async function openPaidGate(userId: string): Promise<GateResult> {
  const slot = await acquireSlot(userId)
  if (!slot.ok) {
    return {
      ok: false,
      refusal: {
        status: 429,
        code: slot.code,
        detail: slot.detail,
        headers: { 'retry-after': String(slot.retryAfterSeconds) },
      },
    }
  }

  const verdict = await checkBudget(userId)
  if (!verdict.ok) {
    await slot.release()
    return {
      ok: false,
      refusal: {
        status: 429,
        code: verdict.code,
        detail: verdict.detail,
        headers: verdict.retryAfterSeconds ? { 'retry-after': String(verdict.retryAfterSeconds) } : {},
      },
    }
  }

  // Usage writes are started as the route reports them and awaited by `release`.
  // Not awaited at the call site: a route reports mid-stream and blocking there
  // would stall the response. Not left floating either — an unsettled write is
  // a ceiling that has quietly stopped counting.
  const metering: Array<Promise<void>> = []
  let released = false
  return {
    ok: true,
    admission: {
      context: {
        userId,
        reportUsage(usage: UsageAmount) {
          metering.push(recordUsage(userId, usage))
        },
      },
      async release() {
        if (released) return
        released = true
        // `recordUsage` never rejects, so this only waits.
        if (metering.length) await Promise.allSettled(metering)
        await slot.release()
      },
    },
  }
}
