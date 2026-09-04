import { setPlatformAnalyticsSink, type RecordedPlatformEvent } from './analytics'
import type { RecordedLandingEvent } from '../features/landing/analytics'

const ENDPOINT = '/api/analytics/events'

function post(surface: 'platform' | 'landing', recorded: { event: unknown; at: number }): void {
  if (typeof fetch !== 'function') return
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ surface, event: recorded.event, at: recorded.at }),
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
