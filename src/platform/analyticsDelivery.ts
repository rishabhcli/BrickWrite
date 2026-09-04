import { setPlatformAnalyticsSink, type RecordedPlatformEvent } from './analytics'
import type { RecordedLandingEvent } from '../features/landing/analytics'

const ENDPOINT = '/api/analytics/events'

/**
 * Telemetry that must never hold up or outlive the page it describes.
 *
 * `sendBeacon` is fire-and-forget: it survives page unload and there is no
 * response for this code to wait on or react to, which is what a "did the
 * user leave before this landed" event needs. It is not a fix for a 502 —
 * Chromium logs "Failed to load resource" for a beacon's underlying request
 * exactly as it does for `fetch`, independent of which API sent it, because
 * that logging is tied to the network stack, not to whether calling code
 * observes the response. A proxy with nothing behind it (fixed for the
 * acceptance suites in `tools/e2e/production.mjs` and `run-all.mjs`, which
 * now start `server/index.ts` the way local dev already does) is what
 * actually keeps this quiet. `fetch` is only the fallback for the browsers
 * new enough to run this build but without `sendBeacon`, which is a
 * compatibility floor, not a load-bearing path.
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
