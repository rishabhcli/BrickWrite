/**
 * A per-user spend ceiling, not just a request ceiling.
 *
 * The edge already caps paid routes at 20 requests per 60 seconds. That bounds
 * *frequency*, not money: one request can be an `xhigh` chat leg against an 8192
 * token ceiling, and `/api/generate` can fan out to a dozen model calls. Twenty
 * of those a minute, sustained, is a bill nobody authorised — and until now there
 * was no mechanism *even in principle* to stop it, because the token counts the
 * provider already returns were written into the response stream and then
 * dropped.
 *
 * So this meters tokens, keyed on the Hexclave `userId` the auth layer already
 * establishes. Requests are the wrong unit; tokens are what is actually bought.
 *
 * ## The three states, and why an outage fails closed
 *
 * The finding that prompted this asked for a deliberate answer on whether a
 * metering outage fails open or closed. The answer here follows the shape the
 * cloud layer already uses for a missing deployment — `unconfigured` is a real,
 * working mode and says so, rather than pretending:
 *
 *   - **No store configured.** Metering is off and `status` says so. This is
 *     local development and self-hosting, and turning it into a 503 would make
 *     the app unusable for anyone who has not stood up a counter.
 *   - **Store configured and answering.** The ceiling is enforced exactly.
 *   - **Store configured and failing.** Fail **closed**. A configured meter that
 *     cannot be read means the balance is unknown, and this codebase does not
 *     claim things it cannot verify — the same reason `fetchVerifiedJson` refuses
 *     an asset whose digest it cannot check, and the same reason the edge limiter
 *     already treats an unparseable counter as over-limit rather than as zero.
 *     An operator who configures a meter has asked for a ceiling; silently
 *     removing it during an outage would be the one behaviour they did not ask
 *     for.
 *
 * ## Two ways to count, and why the interface has both
 *
 * `BudgetStore.increment` is an indivisible add-and-return. When a store offers
 * one it is the only thing `recordUsage` calls, and every token spent is
 * counted. When it does not, the fallback reads then writes — and two requests
 * that overlap read the same balance and one increment is lost. That is not a
 * theoretical difference: twenty-five overlapping writes of forty tokens record
 * forty, not one thousand, which `budget.test.ts` asserts.
 *
 * Both are kept because the choice belongs to the deployment. A self-hosted
 * instance with a plain key-value store should meter approximately rather than
 * not at all; a production deployment should bind a counter that increments.
 * `docs/deployment.md` names the ones that qualify.
 */

/** Tokens, weighted. Output costs several times input on every current model. */
export const OUTPUT_TOKEN_WEIGHT = 5

/**
 * Cache writes and reads, weighted against one ordinary input token.
 *
 * The provider reports four classes of input token and `input_tokens` is only
 * one of them: a cached prefix is billed as `cache_creation_input_tokens` the
 * leg that writes it and `cache_read_input_tokens` on every leg that reads it,
 * and neither is included in `input_tokens`. Counting only `input_tokens` would
 * therefore meter a heavily cached conversation as almost free — which is the
 * opposite of what the cache does, since it moves spend *into* those two fields
 * rather than removing it.
 *
 * The multipliers are the published ones for the five-minute TTL this codebase
 * asks for: a write is 1.25× an ordinary input token, a read is 0.1×. They are
 * ratios rather than prices, so they hold across the model tiers this
 * deployment can be pointed at.
 */
export const CACHE_WRITE_TOKEN_WEIGHT = 1.25
export const CACHE_READ_TOKEN_WEIGHT = 0.1

/**
 * Daily ceiling in weighted tokens.
 *
 * Deliberately generous: this is a runaway-cost backstop, not a product limit,
 * and a ceiling that interrupts ordinary building would be worse than none
 * because it would be raised until it stopped meaning anything.
 */
export const DEFAULT_DAILY_TOKEN_CEILING = 2_000_000

export interface UsageAmount {
  readonly inputTokens: number
  readonly outputTokens: number
  /** `cache_creation_input_tokens`: prefix written to the cache by this call. */
  readonly cacheWriteTokens?: number
  /** `cache_read_input_tokens`: prefix this call read back instead of re-sending. */
  readonly cacheReadTokens?: number
}

/** Non-negative integer, or zero for anything a provider reported nonsensically. */
const tokens = (value: number | undefined): number =>
  Number.isFinite(value) && (value as number) > 0 ? Math.round(value as number) : 0

/**
 * Weighted total, the unit the ceiling is denominated in.
 *
 * Summed as one expression and rounded once, rather than rounding each term:
 * a fractional weight rounded per-call would bias every small cache read to
 * zero, and a ceiling that ignores the cheapest class of token entirely is how
 * a caching change quietly uncaps an account.
 */
export const weightedTokens = (usage: UsageAmount): number =>
  Math.round(
    tokens(usage.inputTokens) +
      tokens(usage.outputTokens) * OUTPUT_TOKEN_WEIGHT +
      tokens(usage.cacheWriteTokens) * CACHE_WRITE_TOKEN_WEIGHT +
      tokens(usage.cacheReadTokens) * CACHE_READ_TOKEN_WEIGHT,
  )

/**
 * The durable counter this needs, as the smallest interface that will do.
 *
 * Deliberately not a Redis or KV type: the deployment picks the store, and a
 * two-method interface is what makes this testable without one.
 */
export interface BudgetStore {
  read(key: string): Promise<string | null>
  write(key: string, value: string, ttlSeconds: number): Promise<void>
  /**
   * Add `by` to the counter at `key` and return the new total, indivisibly.
   *
   * Optional because not every store has one, and a deployment with only
   * `read`/`write` should still meter approximately rather than not at all. When
   * it is present `recordUsage` uses nothing else: the read in the fallback path
   * is precisely what makes two concurrent writers lose an increment.
   *
   * Redis `INCRBY`, a Cloudflare Durable Object, and Postgres
   * `UPDATE … SET n = n + $1 RETURNING n` all satisfy this.
   */
  increment?(key: string, by: number, ttlSeconds: number): Promise<number>
  /**
   * The same primitive, signed, for a counter that goes down as well as up.
   *
   * Separate from `increment` rather than a flag on it because the two want
   * opposite safety properties. `increment` clamps at zero so a nonsensical
   * usage report cannot rewind the spend meter, and that clamp is exactly what a
   * gauge cannot have — `server/security/concurrency.ts` releases a slot by
   * adding −1.
   *
   * `ttlSeconds` is optional and, when omitted, leaves the key's expiry alone.
   * That distinction is load-bearing for the in-flight limiter, which refreshes
   * the lease only on an admitted acquire so a leaked counter can expire.
   *
   * Optional, and a deployment whose store lacks it simply has no concurrency
   * ceiling: unlike the spend meter, this one has no useful approximation.
   */
  adjust?(key: string, by: number, ttlSeconds?: number): Promise<number>
}

export type BudgetStatus = 'unconfigured' | 'ready'

export type BudgetVerdict =
  | { readonly ok: true; readonly status: BudgetStatus; readonly spent: number; readonly ceiling: number }
  | {
      readonly ok: false
      readonly status: 'ready' | 'unavailable'
      readonly code: 'budget_exhausted' | 'budget_unavailable'
      readonly detail: string
      readonly retryAfterSeconds?: number
    }

let store: BudgetStore | null = null
let ceiling = DEFAULT_DAILY_TOKEN_CEILING

/** Installs the durable counter. Called once by the deployment's entry point. */
export function configureBudget(next: BudgetStore | null, dailyCeiling = DEFAULT_DAILY_TOKEN_CEILING): void {
  store = next
  ceiling = Math.max(1, Math.round(dailyCeiling))
}

/** Test seam, and the honest answer to "is a ceiling in force on this deployment?" */
export const budgetStatus = (): BudgetStatus => (store ? 'ready' : 'unconfigured')

/** UTC day, so a ceiling does not reset twice a year on a timezone shift. */
export function dayKey(at = new Date()): string {
  return at.toISOString().slice(0, 10)
}

const keyFor = (userId: string, day: string) => `api-spend:${day}:${userId}`
/** Two days, so the previous day's counter survives long enough to be read. */
const KEY_TTL_SECONDS = 60 * 60 * 48

const secondsUntilUtcMidnight = (at = new Date()): number => {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000))
}

/**
 * Whether this user may make another paid call today.
 *
 * Checked before the call, because refusing after the tokens are spent would
 * meter nothing. The check is on tokens *already* recorded rather than reserved
 * against a guess at the call's size, which would refuse legitimate work — so
 * the request that crosses the line is allowed and the next one is not.
 *
 * That makes the overshoot one request *per caller in flight*, not one request:
 * concurrent callers all read the same total, because the total only moves when
 * `recordUsage` writes. The bound is therefore whatever bounds concurrency, and
 * `server/security/concurrency.ts` is what supplies that number — without it the
 * overshoot is however many requests the layer above happened to admit at once.
 */
export async function checkBudget(userId: string, at = new Date()): Promise<BudgetVerdict> {
  const active = store
  if (!active) return { ok: true, status: 'unconfigured', spent: 0, ceiling }

  let raw: string | null
  try {
    raw = await active.read(keyFor(userId, dayKey(at)))
  } catch {
    return {
      ok: false,
      status: 'unavailable',
      code: 'budget_unavailable',
      detail: 'The spend meter could not be read, so this deployment cannot confirm you are within your daily limit.',
    }
  }

  const spent = raw === null ? 0 : Number.parseInt(raw, 10)
  // An unreadable counter is over-limit, matching the edge rate limiter: a
  // corrupt row must not read as a fresh allowance.
  if (!Number.isFinite(spent) || spent < 0) {
    return {
      ok: false,
      status: 'ready',
      code: 'budget_unavailable',
      detail: 'The spend meter holds a value this deployment cannot interpret, so it is treated as exhausted.',
    }
  }
  if (spent >= ceiling) {
    return {
      ok: false,
      status: 'ready',
      code: 'budget_exhausted',
      detail: `This account has used its daily model allowance. It resets at 00:00 UTC.`,
      retryAfterSeconds: secondsUntilUtcMidnight(at),
    }
  }
  return { ok: true, status: 'ready', spent, ceiling }
}

/**
 * Records what a completed call actually cost.
 *
 * Never throws. A metering write that fails must not fail a request the user has
 * already paid for in latency and that already produced a good answer — the
 * *next* call is the one that gets refused, via `checkBudget`, which does fail
 * closed. Losing one write undercounts by one call; losing the read would
 * uncap the account entirely, which is why the two directions differ.
 */
export async function recordUsage(userId: string, usage: UsageAmount, at = new Date()): Promise<void> {
  const active = store
  if (!active) return
  const key = keyFor(userId, dayKey(at))
  const spent = weightedTokens(usage)
  try {
    if (active.increment) {
      await active.increment(key, spent, KEY_TTL_SECONDS)
      return
    }
    const raw = await active.read(key)
    const previous = raw === null ? 0 : Number.parseInt(raw, 10)
    const base = Number.isFinite(previous) && previous > 0 ? previous : 0
    await active.write(key, String(base + spent), KEY_TTL_SECONDS)
  } catch {
    // Deliberately silent here; the read path is where the ceiling is enforced.
  }
}
