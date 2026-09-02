import type { BudgetStore } from './budget.js'

/**
 * A per-account ceiling on requests that are in flight at once.
 *
 * ## Why this exists where it does
 *
 * Two controls stand in front of the model credential and neither bounds a
 * burst. The edge limiter in `functions/api/[[route]].ts` reads a Cloudflare KV
 * counter, compares, and writes it back; `wrangler.toml` records why it cannot
 * be atomic — Pages rejects a `[[ratelimits]]` binding outright — and is honest
 * about the consequence: it holds on average, and the overshoot is bounded by
 * concurrency. The token ceiling in `budget.ts` reads what has already been
 * *recorded*, so concurrent callers all read the same total and all pass.
 *
 * Concurrency is therefore the term neither layer bounds, and it is the term the
 * token ceiling's overshoot is expressed in. Bounding it here turns "however
 * many the edge let through" into a stated number.
 *
 * It runs on the Vercel handler rather than at the edge because that is where an
 * atomic counter is already reachable: the Upstash Redis the spend meter uses,
 * whose `INCRBY` is an indivisible add-and-return. `wrangler.toml` concludes
 * that an atomic ceiling means moving the proxy to a Worker; it means moving the
 * ceiling to where the counter is, which is one layer further in.
 *
 * ## A gauge, not a rate
 *
 * A per-minute ceiling would have to guess at a legitimate number. One
 * generation fans out to a model call per candidate per phase — up to a dozen
 * candidates — and the browser sends each as its own request, so any rate low
 * enough to bound spend is low enough to refuse a build somebody asked for.
 * Concurrency has no such problem: sequential fan-out occupies one slot however
 * long it runs.
 *
 * ## The three states, matching the spend meter
 *
 *   - **No store, or a store without an atomic adjust.** Off, and `status()`
 *     says so. A gauge built on read-modify-write would miscount in both
 *     directions and leak slots that never heal, which is worse than not having
 *     one; treating that as unconfigured is the same judgement
 *     `budgetStoreFromEnv` makes about a half-configured meter.
 *   - **Configured and answering.** Exact. `INCRBY` cannot be read stale.
 *   - **Configured and failing.** Closed, like `checkBudget` and the edge. An
 *     operator who configured a ceiling asked for one.
 */

/**
 * Slots per account.
 *
 * Real per-account concurrency is a tab or two. Candidate generation is
 * sequential today, and the parallel version discussed in
 * `docs/improvements/09-ai-agent.md` is a pool of two or three. Six is generous
 * for everything legitimate and well under the twenty the edge admits.
 */
export const DEFAULT_MAX_IN_FLIGHT = 6

/**
 * How long an unattended slot survives.
 *
 * Comfortably longer than the 120 s request deadline, so a slot never expires
 * under a request that is still running, and short enough that a leak is
 * measured in minutes.
 */
export const SLOT_LEASE_SECONDS = 300

export type ConcurrencyStatus = 'unconfigured' | 'ready'

export interface SlotRefusal {
  readonly ok: false
  readonly code: 'too_many_in_flight' | 'concurrency_unavailable'
  readonly detail: string
  readonly retryAfterSeconds: number
}

export interface SlotHeld {
  readonly ok: true
  /** Returns the slot. Never throws, and never fails a request that already ran. */
  release(): Promise<void>
}

export type SlotResult = SlotHeld | SlotRefusal

let store: BudgetStore | null = null
let ceiling = DEFAULT_MAX_IN_FLIGHT

/**
 * Installs the counter. Called once by the deployment's entry point.
 *
 * A store that cannot adjust a signed counter is stored as null: this is the one
 * control that cannot degrade gracefully to an approximation.
 */
export function configureConcurrency(next: BudgetStore | null, maxInFlight = DEFAULT_MAX_IN_FLIGHT): void {
  store = next?.adjust ? next : null
  ceiling = Math.max(1, Math.round(maxInFlight))
}

/** The honest answer to "is a concurrency ceiling in force on this deployment?" */
export const concurrencyStatus = (): ConcurrencyStatus => (store ? 'ready' : 'unconfigured')

/** Slots per account on this deployment, for `/api/health`. */
export const concurrencyCeiling = (): number => ceiling

const keyFor = (userId: string) => `api-inflight:${userId}`

/** A held slot that answers to nothing, for the unconfigured path. */
const unmetered: SlotHeld = { ok: true, release: async () => {} }

/**
 * Takes a slot for this account, or refuses.
 *
 * The add happens first and the comparison second, because that order is what
 * makes the check atomic: every concurrent caller sees its own position in the
 * queue rather than a total they all read before any of them wrote. A caller
 * that lands over the line puts its slot straight back.
 */
export async function acquireSlot(userId: string): Promise<SlotResult> {
  const active = store
  if (!active?.adjust) return unmetered
  const key = keyFor(userId)

  let held: number
  try {
    held = await active.adjust(key, 1)
  } catch {
    return {
      ok: false,
      code: 'concurrency_unavailable',
      detail: 'The in-flight counter could not be reached, so this deployment cannot confirm it has capacity for you.',
      retryAfterSeconds: 5,
    }
  }

  if (held > ceiling) {
    // Put it back, and deliberately do not touch the expiry. A key whose slots
    // have all leaked stops being refreshed the moment it starts refusing, so it
    // expires and the account recovers without anybody intervening. Refreshing
    // here would make a leaked account refused for as long as it kept trying.
    await release(active, key, held)
    return {
      ok: false,
      code: 'too_many_in_flight',
      detail: `This account already has ${ceiling} model requests in flight. Wait for one to finish.`,
      retryAfterSeconds: 5,
    }
  }

  // Only an admitted acquire extends the lease; see above.
  try {
    await active.adjust(key, 0, SLOT_LEASE_SECONDS)
  } catch {
    // The slot is held and the request may proceed. A missing expiry costs a
    // lease that outlives its request, not a request that should have run.
  }

  let released = false
  return {
    ok: true,
    async release() {
      if (released) return
      released = true
      await release(active, key, held)
    },
  }
}

/**
 * Hands a slot back.
 *
 * Silent on failure by design: the request it belonged to has already run and
 * already cost what it cost, so turning a counter write into a user-visible
 * failure would report the wrong thing. A lost decrement costs one slot until
 * the lease expires, which is the direction this should fail in.
 */
async function release(active: BudgetStore, key: string, held: number): Promise<void> {
  try {
    const remaining = await active.adjust?.(key, -1)
    // A counter that has gone negative means more releases than acquires — a
    // stale key from a previous lease, most likely. Floor it rather than leave a
    // negative balance that would silently grant free slots later.
    if (typeof remaining === 'number' && remaining < 0) await active.adjust?.(key, -remaining)
  } catch {
    void held
  }
}
