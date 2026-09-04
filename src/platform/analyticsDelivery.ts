import { setPlatformAnalyticsSink, type RecordedPlatformEvent } from './analytics'
import type { RecordedLandingEvent } from '../features/landing/analytics'

const ENDPOINT = '/api/analytics/events'

/**
 * Telemetry that must never be visible when it fails.
 *
 * `fetch(...).catch(() => {})` only swallows a *rejected* promise — a
 * network-level failure. A proxy with nothing behind it (every acceptance
 * suite except the one that boots its own edge process, and plausibly a real
 * deployment mid-redeploy) answers with a plain HTTP error instead, which
 * `fetch` resolves rather than rejects, and the browser logs to the console
 * as a failed resource load regardless of what the calling code does with the
 * response. `sendBeacon` is the platform's actual answer to this: a fire-and-
 * forget transmission that survives page unload and reports nothing back, so
 * there is nothing here to catch and nothing for the browser to log either.
 * `fetch` is only the fallback for the browsers new enough to run this build
 * but without it, which is a compatibility floor, not a load-bearing path.
 */
function post(surface: 'platform' | 'landing', recorded: { event: unknown; at: number }): void {
  const body = JSON.stringify({ surface, event: recorded.event, at: recorded.at })
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
    return
  }
  if (typeof fetch !== 'function') return
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {})
}

let installed = false

/**
 * Delivers both closed-vocabulary event systems to `server/analytics`.
 *
 * Landing and explore are bridged through the `brickwright:analytics` window
 * event rather than `setLandingAnalyticsSink` directly, so this module never
 * imports `features/landing` at runtime — doing so would pull its lazily
 * loaded bundle into the shell's own chunk. `RecordedLandingEvent` above is a
 * type-only import and is erased before that would matter.
 *
 * Call once, from `main.tsx`, before the tree mounts — not from a component,
 * where a render in a test could register this ahead of the sink the test
 * itself installs.
 */
export function installAnalyticsDelivery(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  setPlatformAnalyticsSink((recorded: RecordedPlatformEvent) => post('platform', recorded))
  window.addEventListener('brickwright:analytics', (event) => {
    post('landing', (event as CustomEvent<RecordedLandingEvent>).detail)
  })
}
