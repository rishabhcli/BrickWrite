import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSlot,
  concurrencyCeiling,
  concurrencyStatus,
  configureConcurrency,
  DEFAULT_MAX_IN_FLIGHT,
  SLOT_LEASE_SECONDS,
} from './concurrency'
import type { BudgetStore } from './budget'

/**
 * The in-flight ceiling.
 *
 * The arithmetic is not the interesting part. What has to be checkable without
 * reading the implementation is the direction each edge falls in: an outage
 * closes, an unconfigured store is off rather than open, and a slot that leaks
 * heals instead of refusing the account forever.
 */

interface Recorded {
  readonly key: string
  readonly by: number
  readonly ttlSeconds?: number
}

const counter = () => {
  const rows = new Map<string, number>()
  const seen: Recorded[] = []
  const store: BudgetStore & { rows: Map<string, number>; seen: Recorded[] } = {
    rows,
    seen,
    async read(key) {
      const value = rows.get(key)
      return value === undefined ? null : String(value)
    },
    async write(key, value) {
      rows.set(key, Number.parseInt(value, 10))
    },
    async adjust(key, by, ttlSeconds) {
      seen.push({ key, by, ttlSeconds })
      const next = (rows.get(key) ?? 0) + by
      rows.set(key, next)
      return next
    },
  }
  return store
}

/** A store that can meter spend but cannot run a gauge. */
const withoutAdjust = (): BudgetStore => ({
  async read() {
    return null
  },
  async write() {},
  async increment() {
    return 0
  },
})

const failing = (): BudgetStore => ({
  async read() {
    return null
  },
  async write() {},
  async adjust() {
    throw new Error('counter unreachable')
  },
})

afterEach(() => configureConcurrency(null))

describe('a per-account in-flight ceiling', () => {
  it('is off, and says it is off, when no store is configured', () => {
    configureConcurrency(null)
    expect(concurrencyStatus()).toBe('unconfigured')
  })

  it('is off when the store cannot adjust a signed counter', async () => {
    // Unlike the spend meter, this control has no useful approximation: a gauge
    // built on read-modify-write miscounts in both directions and leaks slots
    // that never heal. Treating that store as unconfigured is the same
    // judgement `budgetStoreFromEnv` makes about a half-configured meter.
    configureConcurrency(withoutAdjust())
    expect(concurrencyStatus()).toBe('unconfigured')
    expect((await acquireSlot('user_a')).ok).toBe(true)
  })

  it('admits up to the ceiling and refuses beyond it', async () => {
    const store = counter()
    configureConcurrency(store, 2)
    expect((await acquireSlot('user_a')).ok).toBe(true)
    expect((await acquireSlot('user_a')).ok).toBe(true)

    const refused = await acquireSlot('user_a')
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe('too_many_in_flight')
      expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    }
  })

  it('adds before it compares, so concurrent callers cannot all read the same total', async () => {
    // The order is the whole mechanism. Reading first and adding second is the
    // race this exists to close — it is why the spend ceiling above it cannot
    // bound a burst on its own.
    const store = counter()
    configureConcurrency(store, 2)
    const results = await Promise.all([acquireSlot('user_a'), acquireSlot('user_a'), acquireSlot('user_a')])
    expect(results.filter((result) => result.ok)).toHaveLength(2)
  })

  it('returns the slot a refused caller took, so a refusal costs nothing', async () => {
    const store = counter()
    configureConcurrency(store, 1)
    await acquireSlot('user_a')
    await acquireSlot('user_a')
    expect(store.rows.get('api-inflight:user_a')).toBe(1)
  })

  it('frees a slot on release and admits the next caller', async () => {
    const store = counter()
    configureConcurrency(store, 1)
    const held = await acquireSlot('user_a')
    expect((await acquireSlot('user_a')).ok).toBe(false)
    if (held.ok) await held.release()
    expect((await acquireSlot('user_a')).ok).toBe(true)
  })

  it('releases once however many times it is called', async () => {
    // The entry point releases in a `finally` that can be reached twice on some
    // paths; a second release would hand back a slot this request never held.
    const store = counter()
    configureConcurrency(store, 2)
    const held = await acquireSlot('user_a')
    if (held.ok) {
      await held.release()
      await held.release()
    }
    expect(store.rows.get('api-inflight:user_a')).toBe(0)
  })

  it('counts each account separately', async () => {
    const store = counter()
    configureConcurrency(store, 1)
    expect((await acquireSlot('user_a')).ok).toBe(true)
    expect((await acquireSlot('user_b')).ok).toBe(true)
  })

  it('refuses when a configured counter cannot be reached', async () => {
    // Same direction as `checkBudget` and the edge limiter. An operator who
    // configured a ceiling asked for one; admitting traffic while it is unknown
    // is the one outcome they did not ask for.
    configureConcurrency(failing())
    const refused = await acquireSlot('user_a')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('concurrency_unavailable')
  })

  it('extends the lease on an admitted acquire and not on a refused one', async () => {
    // This is what makes a leaked slot heal. An account whose slots have all
    // leaked admits nothing, so nothing refreshes the key, so it expires and the
    // account recovers on its own. Refreshing on every attempt would keep a
    // fully-leaked account refused for as long as it kept retrying.
    const store = counter()
    configureConcurrency(store, 1)
    await acquireSlot('user_a')
    expect(store.seen.some((entry) => entry.ttlSeconds === SLOT_LEASE_SECONDS)).toBe(true)

    store.seen.length = 0
    await acquireSlot('user_a')
    expect(store.seen.every((entry) => entry.ttlSeconds === undefined)).toBe(true)
  })

  it('floors a counter that has gone negative rather than banking free slots', async () => {
    // A release against a key that expired mid-request would otherwise leave a
    // negative balance, and a negative balance is an allowance the next burst
    // spends before the ceiling notices.
    const store = counter()
    configureConcurrency(store, 2)
    const held = await acquireSlot('user_a')
    store.rows.set('api-inflight:user_a', 0)
    if (held.ok) await held.release()
    expect(store.rows.get('api-inflight:user_a')).toBe(0)
  })

  it('reports the ceiling it is enforcing', () => {
    configureConcurrency(counter())
    expect(concurrencyCeiling()).toBe(DEFAULT_MAX_IN_FLIGHT)
    configureConcurrency(counter(), 3)
    expect(concurrencyCeiling()).toBe(3)
  })
})
