import { afterEach, describe, expect, it, vi } from 'vitest'
import { budgetStoreFromEnv } from './budgetStore'

/**
 * The counter behind the spend ceiling.
 *
 * What matters here is not the wire format but the three properties the ceiling
 * depends on: the increment is one round trip and therefore indivisible, the
 * key never reaches a URL path unescaped, and a store that is only half
 * configured is no store rather than a broken one.
 */

afterEach(() => vi.unstubAllGlobals())

const env = {
  BRICKWRIGHT_BUDGET_REDIS_URL: 'https://counter.example.test',
  BRICKWRIGHT_BUDGET_REDIS_TOKEN: 'counter-token',
}

describe('configuring the counter', () => {
  it('is absent when neither variable is set', () => {
    expect(budgetStoreFromEnv({})).toBeNull()
  })

  it('is absent when only one of the pair is set', () => {
    expect(budgetStoreFromEnv({ BRICKWRIGHT_BUDGET_REDIS_URL: env.BRICKWRIGHT_BUDGET_REDIS_URL })).toBeNull()
    expect(budgetStoreFromEnv({ BRICKWRIGHT_BUDGET_REDIS_TOKEN: env.BRICKWRIGHT_BUDGET_REDIS_TOKEN })).toBeNull()
  })

  it('refuses a non-HTTPS endpoint outside loopback', () => {
    expect(
      budgetStoreFromEnv({ ...env, BRICKWRIGHT_BUDGET_REDIS_URL: 'http://counter.example.test' }),
    ).toBeNull()
    expect(budgetStoreFromEnv({ ...env, BRICKWRIGHT_BUDGET_REDIS_URL: 'http://127.0.0.1:6379' })).not.toBeNull()
  })

  it('is present when both are set', () => {
    expect(budgetStoreFromEnv(env)).not.toBeNull()
  })
})

describe('incrementing', () => {
  it('adds and expires in a single round trip and returns the new total', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify([{ result: 340 }, { result: 1 }]), { status: 200 })
    })

    const store = budgetStoreFromEnv(env)!
    await expect(store.increment!('api-spend:2026-09-01:user_a', 40, 172_800)).resolves.toBe(340)

    // One request, not two: an increment split across round trips is the race
    // this store exists to remove.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://counter.example.test/pipeline')
    expect(calls[0].auth).toBe('Bearer counter-token')
    expect(calls[0].body).toEqual([
      ['INCRBY', 'api-spend:2026-09-01:user_a', '40'],
      ['EXPIRE', 'api-spend:2026-09-01:user_a', '172800'],
    ])
  })

  it('rejects when the counter answers with an error status', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    const store = budgetStoreFromEnv(env)!
    await expect(store.increment!('k', 1, 10)).rejects.toThrow()
  })

  it('rejects when the counter answers with an unusable body', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ error: 'WRONGTYPE' }]), { status: 200 }))
    const store = budgetStoreFromEnv(env)!
    await expect(store.increment!('k', 1, 10)).rejects.toThrow()
  })
})

describe('reading', () => {
  it('returns the stored value', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ result: '1200' }), { status: 200 }))
    const store = budgetStoreFromEnv(env)!
    await expect(store.read('api-spend:2026-09-01:user_a')).resolves.toBe('1200')
  })

  it('returns null for a key that is not set', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ result: null }), { status: 200 }))
    const store = budgetStoreFromEnv(env)!
    await expect(store.read('missing')).resolves.toBeNull()
  })

  it('rejects rather than reporting zero when the counter is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    const store = budgetStoreFromEnv(env)!
    // `checkBudget` turns a rejection into a refusal. Answering `null` here
    // would read as a fresh allowance and uncap the account during an outage.
    await expect(store.read('k')).rejects.toThrow()
  })

  it('escapes a key rather than letting it alter the request path', async () => {
    let requested = ''
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested = String(input)
      return new Response(JSON.stringify({ result: null }), { status: 200 })
    })
    const store = budgetStoreFromEnv(env)!
    await store.read('user/../../flushall')
    expect(requested).toBe('https://counter.example.test/get/user%2F..%2F..%2Fflushall')
  })
})
