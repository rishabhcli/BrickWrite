// @vitest-environment node
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteContext, RouteModule } from '../server/dispatch'

/**
 * The production API entrypoint.
 *
 * This file is the only thing between the public internet and a process holding
 * the model provider key, and until now nothing tested it. The properties below
 * are the ones an outage or a bill depends on, in the order the handler applies
 * them: the proxy proof, the session, then the spend ceiling.
 *
 * The route modules are replaced with a recorder. The real ones need a provider
 * and a network; what is under test here is the gate in front of them and the
 * context handed through it, not what the model says.
 */

const calls: Array<{ prefix: string; context?: RouteContext }> = []

let usageCost: { inputTokens: number; outputTokens: number } | undefined

/**
 * Stands in for both paid routes, and reports whatever the current test set as
 * a cost. Read at handle time, not at construction: the entry point builds its
 * route list once at module scope, so a cost captured in this closure would be
 * whatever it was when the module first loaded.
 */
let parked: Promise<void> | null = null

const recorder = (prefix: string): RouteModule => ({
  prefix,
  async handle(_request, response, url, context) {
    if (!url.pathname.startsWith(prefix)) return false
    calls.push({ prefix, context })
    // Held open so a test can have several requests genuinely in flight at once
    // — the only way to observe a ceiling that exists to bound concurrency.
    if (parked) await parked
    if (usageCost) context?.reportUsage?.(usageCost)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return true
  },
})
vi.mock('../server/assistant/handler.js', () => ({
  createAssistantRoute: () => recorder('/api/assistant'),
}))
vi.mock('../server/generation/index.js', () => ({
  createGenerationRoute: () => recorder('/api/generate'),
}))

const verified = { ok: true as const, identity: { userId: 'user_1', displayName: 'Ada' } }
let authorization: Awaited<ReturnType<typeof import('../server/security/auth.js').authorizePaidRoute>> = verified
vi.mock('../server/security/auth.js', () => ({
  authorizePaidRoute: async () => authorization,
}))

/** An in-memory counter with the atomic increment the real store provides. */
const rows = new Map<string, number>()
vi.mock('../server/security/budgetStore.js', () => ({
  budgetStoreFromEnv: () => ({
    async read(key: string) {
      const value = rows.get(key)
      return value === undefined ? null : String(value)
    },
    async write(key: string, value: string) {
      rows.set(key, Number.parseInt(value, 10))
    },
    async increment(key: string, by: number) {
      const next = (rows.get(key) ?? 0) + by
      rows.set(key, next)
      return next
    },
    async adjust(key: string, by: number) {
      const next = (rows.get(key) ?? 0) + by
      rows.set(key, next)
      return next
    },
  }),
}))

const { default: handler } = await import('./[...route]')
const { configureBudget, DEFAULT_DAILY_TOKEN_CEILING } = await import('../server/security/budget.js')
const { configureConcurrency, DEFAULT_MAX_IN_FLIGHT } = await import('../server/security/concurrency.js')
const { budgetStoreFromEnv } = await import('../server/security/budgetStore.js')
const { GATE_REFUSALS } = await import('../src/agent/protocol')

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Awaits the handler, not the response.
 *
 * A route writes its body and returns while the handler still has metering
 * writes to settle. Resolving on `end()` would step past that and observe a
 * counter that has not been incremented yet — which is exactly the race the
 * handler's `finally` exists to remove, so a harness that reproduces it would
 * hide the fix rather than test it.
 */
async function call(pathname: string, options: { method?: string; proxied?: boolean } = {}): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const request = {
    url: pathname,
    method: options.method ?? 'POST',
    headers: {
      host: 'api.brickwrite.tech',
      ...(options.proxied === false ? {} : { 'x-brickwright-proxy-key': 'proxy-proof' }),
    },
  } as unknown as IncomingMessage

  const response: { headersSent: boolean; writeHead: unknown; end: unknown } = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status
      captured.headers = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
      )
      response.headersSent = true
      return response
    },
    end(chunk?: string) {
      captured.body = chunk ?? ''
      return response
    },
  }

  await handler(request, response as unknown as ServerResponse)
  return captured
}

const json = (captured: Captured) => JSON.parse(captured.body || '{}')

/** Spend rows only. The in-flight gauge shares the counter and is not spend. */
const spendRows = () => [...rows].filter(([key]) => key.startsWith('api-spend:')).map(([, value]) => value)

beforeEach(() => {
  process.env.BRICKWRIGHT_PROXY_SECRET = 'proxy-proof'
  calls.length = 0
  rows.clear()
  usageCost = undefined
  authorization = verified
  parked = null
  configureBudget(budgetStoreFromEnv(), 1000)
  configureConcurrency(budgetStoreFromEnv())
})

describe('the proxy proof', () => {
  it('refuses a caller that did not come through the edge', async () => {
    const response = await call('/api/assistant', { proxied: false })
    expect(response.status).toBe(403)
    expect(json(response).error).toBe('proxy_required')
    expect(calls).toHaveLength(0)
  })

  it('refuses every caller when no proxy secret is configured', async () => {
    delete process.env.BRICKWRIGHT_PROXY_SECRET
    // Absent configuration closes the door rather than opening it: an empty
    // expected secret must not match an empty presented one.
    expect((await call('/api/assistant')).status).toBe(403)
  })
})

describe('health', () => {
  it('answers without a session and reports whether metering is in force', async () => {
    const response = await call('/api/health', { method: 'GET' })
    expect(response.status).toBe(200)
    expect(json(response)).toMatchObject({
      ok: true,
      metering: 'ready',
      concurrency: { status: 'ready', ceiling: DEFAULT_MAX_IN_FLIGHT },
    })
  })

  it('says so when no in-flight counter is configured', async () => {
    configureConcurrency(null)
    expect(json(await call('/api/health', { method: 'GET' })).concurrency.status).toBe('unconfigured')
  })

  it('says so when no counter is configured', async () => {
    configureBudget(null)
    expect(json(await call('/api/health', { method: 'GET' })).metering).toBe('unconfigured')
  })
})

describe('the session gate', () => {
  it('refuses a paid route without a verified session, before any route runs', async () => {
    authorization = { ok: false, status: 401, code: 'unauthorized', detail: 'Sign in to use model-backed tools.' }
    const response = await call('/api/assistant')
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('passes a restricted account through as 403 rather than 401', async () => {
    authorization = { ok: false, status: 403, code: 'restricted', detail: 'Complete the required account checks.' }
    expect((await call('/api/generate')).status).toBe(403)
  })

  it('does not gate a GET on a paid path', async () => {
    authorization = { ok: false, status: 401, code: 'unauthorized', detail: 'no' }
    // Only POST spends money. A GET reaches the route and 404s there.
    const response = await call('/api/assistant/health', { method: 'GET' })
    expect(response.status).toBe(200)
  })
})

describe('the spend ceiling', () => {
  it('admits a call when the account is under its ceiling', async () => {
    const response = await call('/api/assistant')
    expect(response.status).toBe(200)
    expect(calls[0].context?.userId).toBe('user_1')
  })

  it('meters what a completed call actually cost', async () => {
    usageCost = { inputTokens: 100, outputTokens: 10 }
    await call('/api/assistant')
    // 100 input + 10 output × 5 = 150 weighted tokens.
    expect(spendRows()).toEqual([150])
  })

  it('refuses the next call once the ceiling is passed, and never reaches the route', async () => {
    usageCost = { inputTokens: 2000, outputTokens: 0 }
    expect((await call('/api/assistant')).status).toBe(200)

    calls.length = 0
    const refused = await call('/api/assistant')
    expect(refused.status).toBe(429)
    expect(json(refused).error).toBe('budget_exhausted')
    expect(refused.headers['retry-after']).toMatch(/^\d+$/)
    expect(calls).toHaveLength(0)
  })

  it('meters each account separately', async () => {
    usageCost = { inputTokens: 2000, outputTokens: 0 }
    await call('/api/assistant')
    authorization = { ok: true, identity: { userId: 'user_2', displayName: null } }
    expect((await call('/api/assistant')).status).toBe(200)
  })

  it('refuses paid traffic when a configured counter cannot be read', async () => {
    configureBudget({
      async read() {
        throw new Error('counter unreachable')
      },
      async write() {},
    })
    const refused = await call('/api/generate')
    // A configured meter that cannot answer means the balance is unknown, and
    // an unknown balance is not an allowance.
    expect(refused.status).toBe(429)
    expect(json(refused).error).toBe('budget_unavailable')
    expect(calls).toHaveLength(0)
  })

  it('does not meter at all when no counter is configured', async () => {
    configureBudget(null)
    usageCost = { inputTokens: 5_000_000, outputTokens: 0 }
    expect((await call('/api/assistant')).status).toBe(200)
    expect((await call('/api/assistant')).status).toBe(200)
    expect(spendRows()).toEqual([])
  })

  it('uses the documented default ceiling when none is given', async () => {
    configureBudget(budgetStoreFromEnv())
    usageCost = { inputTokens: DEFAULT_DAILY_TOKEN_CEILING - 1, outputTokens: 0 }
    expect((await call('/api/assistant')).status).toBe(200)
    expect((await call('/api/assistant')).status).toBe(200)
    expect((await call('/api/assistant')).status).toBe(429)
  })
})

describe('the in-flight ceiling', () => {
  /** Yields to the event loop, draining every pending microtask first. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('refuses a burst past the ceiling without reaching the route', async () => {
    // The spend ceiling above cannot do this: it reads tokens already recorded,
    // so every caller in a burst reads the same total and every one passes.
    configureConcurrency(budgetStoreFromEnv(), 2)
    let open!: () => void
    parked = new Promise<void>((resolve) => {
      open = resolve
    })

    const inFlight = [call('/api/assistant'), call('/api/assistant')]
    await settle()
    expect(calls).toHaveLength(2)

    const refused = await call('/api/assistant')
    expect(refused.status).toBe(429)
    expect(json(refused).error).toBe('too_many_in_flight')
    expect(refused.headers['retry-after']).toMatch(/^\d+$/)
    expect(calls).toHaveLength(2)

    open()
    for (const response of await Promise.all(inFlight)) expect(response.status).toBe(200)
  })

  it('frees the slot when the request finishes', async () => {
    configureConcurrency(budgetStoreFromEnv(), 1)
    expect((await call('/api/assistant')).status).toBe(200)
    expect((await call('/api/assistant')).status).toBe(200)
    expect((await call('/api/assistant')).status).toBe(200)
  })

  it('frees the slot when the spend ceiling refuses the call', async () => {
    // A refusal that kept its slot would turn one exhausted account into an
    // account that is also permanently over its concurrency ceiling, and the
    // second refusal would name the wrong cause.
    configureConcurrency(budgetStoreFromEnv(), 1)
    usageCost = { inputTokens: 2000, outputTokens: 0 }
    await call('/api/assistant')

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await call('/api/assistant')
      expect(json(refused).error).toBe('budget_exhausted')
    }
  })

  it('does not gate a path that spends nothing', async () => {
    configureConcurrency(budgetStoreFromEnv(), 1)
    let open!: () => void
    parked = new Promise<void>((resolve) => {
      open = resolve
    })
    const held = call('/api/assistant')
    await settle()

    // `/api/health` takes no slot, so an account at its ceiling can still be
    // asked whether the deployment is up.
    expect((await call('/api/health', { method: 'GET' })).status).toBe(200)
    open()
    await held
  })

  it('refuses paid traffic when a configured counter cannot be adjusted', async () => {
    configureConcurrency({
      async read() {
        return null
      },
      async write() {},
      async adjust() {
        throw new Error('counter unreachable')
      },
    })
    const refused = await call('/api/generate')
    expect(refused.status).toBe(429)
    expect(json(refused).error).toBe('concurrency_unavailable')
    expect(calls).toHaveLength(0)
  })

  it('does not limit anything when no counter is configured', async () => {
    configureConcurrency(null)
    let open!: () => void
    parked = new Promise<void>((resolve) => {
      open = resolve
    })
    const inFlight = Array.from({ length: 12 }, () => call('/api/assistant'))
    await settle()
    open()
    for (const response of await Promise.all(inFlight)) expect(response.status).toBe(200)
  })
})

describe('what the caller is told', () => {
  /**
   * Every refusal in front of the route answers `{ error, detail }`, which is a
   * different envelope from the route's own. The browser transport used to
   * understand only the route's, so a spend ceiling — the one refusal with a
   * genuinely useful sentence attached — reached the user as "the assistant API
   * returned 429".
   *
   * This drives each control to refuse and asserts the client can name what
   * happened and has a sentence to show for it.
   */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  const refusals = async (): Promise<Array<{ error: string; detail: unknown }>> => {
    const seen: Array<{ error: string; detail: unknown }> = []
    const record = (captured: Captured) => seen.push(json(captured))

    record(await call('/api/assistant', { proxied: false }))

    authorization = { ok: false, status: 401, code: 'unauthorized', detail: 'Sign in to use model-backed tools.' }
    record(await call('/api/assistant'))
    authorization = { ok: false, status: 403, code: 'restricted', detail: 'Complete the required account checks.' }
    record(await call('/api/assistant'))
    authorization = verified

    record(await call('/api/nothing-here', { method: 'GET' }))

    configureConcurrency(budgetStoreFromEnv(), 1)
    let open!: () => void
    parked = new Promise<void>((resolve) => {
      open = resolve
    })
    const held = call('/api/assistant')
    await settle()
    record(await call('/api/assistant'))
    open()
    await held
    parked = null

    configureConcurrency({
      async read() {
        return null
      },
      async write() {},
      async adjust() {
        throw new Error('counter unreachable')
      },
    })
    record(await call('/api/assistant'))
    configureConcurrency(budgetStoreFromEnv())

    usageCost = { inputTokens: 2000, outputTokens: 0 }
    await call('/api/assistant')
    record(await call('/api/assistant'))
    usageCost = undefined

    configureBudget({
      async read() {
        throw new Error('counter unreachable')
      },
      async write() {},
    })
    record(await call('/api/assistant'))

    return seen
  }

  it('names every refusal in a way the browser transport understands', async () => {
    const seen = await refusals()
    const codes = [...new Set(seen.map((body) => body.error))]
    expect(codes.length).toBeGreaterThan(6)

    // A code the client cannot place becomes a status number on screen.
    const unknown = codes.filter((code) => !(code in GATE_REFUSALS))
    expect(unknown).toEqual([])
  })

  it('carries a sentence, since it is the only place the reason exists', async () => {
    for (const body of await refusals()) {
      expect(typeof body.detail).toBe('string')
      expect((body.detail as string).length).toBeGreaterThan(10)
    }
  })
})

describe('unclaimed paths', () => {
  it('answers 404 rather than falling through silently', async () => {
    const response = await call('/api/nothing-here', { method: 'GET' })
    expect(response.status).toBe(404)
    expect(json(response).error).toBe('not_found')
  })
})
