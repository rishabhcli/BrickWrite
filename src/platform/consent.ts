/**
 * Analytics consent, stored locally.
 *
 * Hexclave's session-replay and click tracking configure only at
 * `HexclaveClientApp` construction (see `src/hexclave/client.ts`) — there is
 * no documented runtime toggle — so a changed choice takes effect on the next
 * load rather than instantly. `setAnalyticsConsent` reloads the page for that
 * reason; nothing here contacts Hexclave directly.
 */

export type AnalyticsConsent = 'granted' | 'denied' | 'unset'

const STORAGE_KEY = 'brickwright:analytics-consent'

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Thrown by some browsers' strict-privacy modes and sandboxed iframes,
    // even just reading the property. Absent storage means "ask again", never
    // "assume granted".
    return null
  }
}

export function getAnalyticsConsent(): AnalyticsConsent {
  const value = storage()?.getItem(STORAGE_KEY)
  return value === 'granted' || value === 'denied' ? value : 'unset'
}

/** Records the choice and reloads, so the next `HexclaveClientApp` construction sees it. */
export function setAnalyticsConsent(value: 'granted' | 'denied'): void {
  storage()?.setItem(STORAGE_KEY, value)
  window.location.reload()
}

/** Re-asks on the next load. Used by a "cookie preferences" control, not by the banner itself. */
export function reopenAnalyticsConsent(): void {
  storage()?.removeItem(STORAGE_KEY)
  window.location.reload()
}
