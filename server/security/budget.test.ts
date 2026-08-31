import { afterEach, describe, expect, it } from 'vitest'
import {
  budgetStatus,
  checkBudget,
  configureBudget,
  dayKey,
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
