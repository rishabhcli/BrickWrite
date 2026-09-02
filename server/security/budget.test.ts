import { afterEach, describe, expect, it } from 'vitest'
import {
  budgetStatus,
  checkBudget,
  configureBudget,
  dayKey,
  CACHE_READ_TOKEN_WEIGHT,
  CACHE_WRITE_TOKEN_WEIGHT,
  DEFAULT_DAILY_TOKEN_CEILING,
  OUTPUT_TOKEN_WEIGHT,
  recordUsage,
  weightedTokens,
  type BudgetStore,
} from './budget'

/**
 * A spend ceiling, and the three states it can be in.
 *
 * The edge caps *requests*; this caps *tokens*, which is what is actually
 * bought. The interesting assertions are not the arithmetic — they are the
 * direction each failure falls in, because that is the part a reviewer has to be
 * able to check without reading the implementation.
 */

const memory = (): BudgetStore & { readonly rows: Map<string, string> } => {
  const rows = new Map<string, string>()
  return {
    rows,
    async read(key) {
      return rows.get(key) ?? null
    },
    async write(key, value) {
      rows.set(key, value)
    },
  }
}

const failing = (): BudgetStore => ({
  async read() {
    throw new Error('meter unreachable')
  },
  async write() {
    throw new Error('meter unreachable')
  },
})

afterEach(() => configureBudget(null))

describe('a per-user spend ceiling', () => {
  it('is off, and says it is off, when no store is configured', () => {
    // Local development and self-hosting. Turning this into a 503 would make the
    // app unusable for anyone who has not stood up a counter, so `unconfigured`
    // is a real working mode that reports itself rather than pretending.
    configureBudget(null)
    expect(budgetStatus()).toBe('unconfigured')
  })

  it('allows a signed-in user under the ceiling', async () => {
    configureBudget(memory(), 1000)
    const verdict = await checkBudget('user_a')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.status).toBe('ready')
      expect(verdict.spent).toBe(0)
      expect(verdict.ceiling).toBe(1000)
    }
  })

  it('weights output tokens, because that is where the cost is', () => {
    expect(weightedTokens({ inputTokens: 100, outputTokens: 0 })).toBe(100)
    expect(weightedTokens({ inputTokens: 0, outputTokens: 100 })).toBe(100 * OUTPUT_TOKEN_WEIGHT)
    // A ceiling denominated in raw tokens would let an output-heavy workload cost
    // several times what an input-heavy one of the same count does.
    expect(weightedTokens({ inputTokens: 0, outputTokens: 10 })).toBeGreaterThan(
      weightedTokens({ inputTokens: 10, outputTokens: 0 }),
    )
  })

  it('counts cached tokens, which the provider reports outside inputTokens', () => {
    // `input_tokens` excludes both cache classes. Counting only it would meter a
    // cached prefix as free — and the assistant route caches its whole
    // transcript, so "free" would be most of every leg.
    expect(weightedTokens({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 })).toBe(
      1000 * CACHE_WRITE_TOKEN_WEIGHT,
    )
    expect(weightedTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 })).toBe(
      1000 * CACHE_READ_TOKEN_WEIGHT,
    )
  })

  it('prices a cache read below an ordinary input token and a write above one', () => {
    // The direction is the assertion. A read that cost the same as a fresh
    // token would make caching look like no saving at all; a write that cost
    // the same would hide the premium the first leg actually pays.
    const plain = weightedTokens({ inputTokens: 1000, outputTokens: 0 })
    expect(weightedTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 })).toBeLessThan(plain)
    expect(weightedTokens({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 })).toBeGreaterThan(plain)
  })

  it('rounds the weighted total once, so a small cache read is not lost to zero', () => {
    // Rounding each term would floor every read under five tokens, and a meter
    // that discards its smallest increments undercounts a long conversation.
    expect(weightedTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 4 })).toBe(0)
    expect(weightedTokens({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 4 })).toBe(1)
    expect(weightedTokens({ inputTokens: 6, outputTokens: 0, cacheReadTokens: 4 })).toBe(6)
  })

  it('treats a token count that is not a number as zero rather than poisoning the counter', () => {
    // A provider that answers with a missing or malformed count must not be able
    // to write NaN into the durable meter: `checkBudget` would then read a value
    // it cannot interpret and refuse the account entirely.
    expect(weightedTokens({ inputTokens: Number.NaN, outputTokens: 10 })).toBe(10 * OUTPUT_TOKEN_WEIGHT)
    expect(weightedTokens({ inputTokens: 10, outputTokens: -5 })).toBe(10)
  })

  it('meters all four token classes through the store', async () => {
    const store = memory()
    configureBudget(store, 1_000_000)
    await recordUsage('user_cache', { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 100, cacheReadTokens: 200 })
    const verdict = await checkBudget('user_cache')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.spent).toBe(
        10 + 2 * OUTPUT_TOKEN_WEIGHT + 100 * CACHE_WRITE_TOKEN_WEIGHT + 200 * CACHE_READ_TOKEN_WEIGHT,
      )
    }
  })

  it('refuses the call after the ceiling is crossed, not the one that crosses it', async () => {
    // Metering on tokens already recorded means the request that goes over is
    // allowed and the next is refused. The alternative is reserving against a
    // guess at the call's size, which would refuse legitimate work.
    configureBudget(memory(), 1000)
    await recordUsage('user_b', { inputTokens: 900, outputTokens: 0 })
    expect((await checkBudget('user_b')).ok).toBe(true)

    await recordUsage('user_b', { inputTokens: 200, outputTokens: 0 })
    const over = await checkBudget('user_b')
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.code).toBe('budget_exhausted')
      expect(over.detail).toContain('00:00 UTC')
      expect(over.retryAfterSeconds).toBeGreaterThan(0)
    }
  })

  it('fails closed when a configured meter cannot be read', async () => {
    // The deliberate answer the finding asked for. An operator who configures a
    // meter has asked for a ceiling; silently removing it during an outage is
    // the one behaviour they did not ask for.
    configureBudget(failing(), 1000)
    const verdict = await checkBudget('user_c')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.status).toBe('unavailable')
      expect(verdict.code).toBe('budget_unavailable')
    }
  })

  it('treats an uninterpretable counter as exhausted, not as a fresh allowance', async () => {
    const store = memory()
    configureBudget(store, 1000)
    store.rows.set(`api-spend:${dayKey()}:user_d`, 'not-a-number')
    expect((await checkBudget('user_d')).ok).toBe(false)
  })

  it('does not fail a completed call when the meter write fails', async () => {
    // Asymmetric on purpose: losing a write undercounts by one call, while
    // failing the request would discard an answer the user already waited for.
    // Losing the *read* would uncap the account, which is why that direction
    // fails closed instead.
    configureBudget(failing(), 1000)
    await expect(recordUsage('user_e', { inputTokens: 10, outputTokens: 10 })).resolves.toBeUndefined()
  })

  it('meters each account separately, and resets on the UTC day', async () => {
    configureBudget(memory(), 1000)
    await recordUsage('user_f', { inputTokens: 2000, outputTokens: 0 })
    expect((await checkBudget('user_f')).ok).toBe(false)
    // A different account is unaffected.
    expect((await checkBudget('user_g')).ok).toBe(true)
    // And the same account tomorrow is a new day. UTC, so a ceiling does not
    // reset twice a year on a timezone shift.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    expect((await checkBudget('user_f', tomorrow)).ok).toBe(true)
  })

  it('has a generous default, because a limit that interrupts building gets raised until it means nothing', () => {
    expect(DEFAULT_DAILY_TOKEN_CEILING).toBeGreaterThanOrEqual(1_000_000)
  })
})

describe('atomic metering', () => {
  /** A store whose increment is a single indivisible operation. */
  const atomic = (): BudgetStore & { readonly rows: Map<string, number>; reads: number } => {
    const rows = new Map<string, number>()
    return {
      rows,
      reads: 0,
      async read(key) {
        this.reads += 1
        const value = rows.get(key)
        return value === undefined ? null : String(value)
      },
      async write(key, value) {
        rows.set(key, Number.parseInt(value, 10))
      },
      async increment(key, by) {
        const next = (rows.get(key) ?? 0) + by
        rows.set(key, next)
        return next
      },
    }
  }

  it('uses the atomic increment when the store offers one', async () => {
    const store = atomic()
    configureBudget(store, 1000)
    await recordUsage('user_atomic', { inputTokens: 100, outputTokens: 0 })
    expect([...store.rows.values()]).toEqual([100])
    // The read-modify-write path must not run: its read is what makes two
    // concurrent writers lose an increment.
    expect(store.reads).toBe(0)
  })

  it('does not lose an increment when writers overlap', async () => {
    const store = atomic()
    configureBudget(store, 100_000)
    await Promise.all(
      Array.from({ length: 25 }, () => recordUsage('user_race', { inputTokens: 40, outputTokens: 0 })),
    )
    expect([...store.rows.values()]).toEqual([25 * 40])
  })

  it('still meters through read-modify-write when the store has no increment', async () => {
    const store = memory()
    configureBudget(store, 1000)
    await recordUsage('user_legacy', { inputTokens: 100, outputTokens: 0 })
    expect([...store.rows.values()]).toEqual(['100'])
  })

  it('reports the ceiling as exhausted once the atomic counter passes it', async () => {
    const store = atomic()
    configureBudget(store, 500)
    await recordUsage('user_over', { inputTokens: 600, outputTokens: 0 })
    const verdict = await checkBudget('user_over')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.code).toBe('budget_exhausted')
  })

  it('never throws when the atomic increment fails', async () => {
    configureBudget({
      async read() {
        return null
      },
      async write() {},
      async increment() {
        throw new Error('counter unreachable')
      },
    })
    await expect(recordUsage('user_h', { inputTokens: 10, outputTokens: 10 })).resolves.toBeUndefined()
  })
})
