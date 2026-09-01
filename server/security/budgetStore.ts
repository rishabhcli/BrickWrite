import type { BudgetStore } from './budget.js'

/**
 * The durable counter behind the daily spend ceiling.
 *
 * Speaks the Upstash REST protocol, which Upstash Redis and several
 * compatible proxies serve. Chosen because it needs no client library — this
 * process already holds the model key and every dependency it does not have is
 * one that cannot be compromised — and because Redis `INCRBY` is the atomic
 * add-and-return that `BudgetStore.increment` is defined in terms of.
 *
 * Absent configuration is a supported mode, not a failure: `configureBudget`
 * accepts null and `budgetStatus()` then reports `unconfigured`. Local
 * development and self-hosting run that way.
 */

/** Two days, matching `KEY_TTL_SECONDS`, so yesterday's counter is still readable. */
export interface BudgetStoreEnv {
  BRICKWRIGHT_BUDGET_REDIS_URL?: string
  BRICKWRIGHT_BUDGET_REDIS_TOKEN?: string
}

/**
 * Loopback is exempt from the HTTPS requirement so a developer can point this at
 * a local counter. Anything else must be HTTPS: the token is a bearer credential
 * and this process is the one holding the model key.
 */
function usableEndpoint(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  return url
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

/**
 * Builds the counter from the environment, or returns null when it is not
 * configured. Half-configured is treated as not configured: a URL without its
 * token would fail every call, and a meter that fails every call is worse than
 * one that says it is off, because `checkBudget` fails closed on a configured
 * store and would refuse all paid traffic.
 */
export function budgetStoreFromEnv(env: BudgetStoreEnv = process.env): BudgetStore | null {
  const rawUrl = env.BRICKWRIGHT_BUDGET_REDIS_URL?.trim()
  const token = env.BRICKWRIGHT_BUDGET_REDIS_TOKEN?.trim()
  if (!rawUrl || !token) return null
  const endpoint = usableEndpoint(rawUrl)
  if (!endpoint) return null
  const base = trimTrailingSlash(endpoint.toString())
  const authorization = `Bearer ${token}`

  async function send(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`The spend counter answered ${response.status}.`)
    return response.json()
  }

  return {
    async read(key) {
      // `encodeURIComponent`, not template interpolation: a key is not trusted
      // to stay inside its path segment.
      const payload = (await send(`/get/${encodeURIComponent(key)}`)) as { result?: unknown }
      const value = payload?.result
      return value === null || value === undefined ? null : String(value)
    },

    async write(key, value, ttlSeconds) {
      await send('/pipeline', [['SETEX', key, String(Math.max(1, Math.floor(ttlSeconds))), value]])
    },

    async increment(key, by, ttlSeconds) {
      // One round trip. Splitting the add from the expiry would reintroduce the
      // gap this store exists to close, and would leave a counter with no TTL if
      // the second call were lost.
      const payload = (await send('/pipeline', [
        ['INCRBY', key, String(Math.max(0, Math.round(by)))],
        ['EXPIRE', key, String(Math.max(1, Math.floor(ttlSeconds)))],
      ])) as Array<{ result?: unknown; error?: unknown }> | null
      const incremented = Array.isArray(payload) ? payload[0] : undefined
      if (!incremented || incremented.error !== undefined) {
        throw new Error('The spend counter did not accept the increment.')
      }
      const total = Number(incremented.result)
      if (!Number.isFinite(total)) throw new Error('The spend counter returned a total it cannot mean.')
      return total
    },
  }
}
