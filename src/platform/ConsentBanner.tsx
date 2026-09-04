import { useState } from 'react'
import { getAnalyticsConsent, setAnalyticsConsent, type AnalyticsConsent } from './consent'

/**
 * Asks before Hexclave's session-replay and click tracking ever start.
 *
 * Read once at mount rather than kept live: `setAnalyticsConsent` reloads the
 * page as soon as a choice is made, so this component is never asked to
 * transition from `unset` to a decided state in place.
 */
export function ConsentBanner() {
  const [consent] = useState<AnalyticsConsent>(getAnalyticsConsent)
  if (consent !== 'unset') return null

  return (
    <div className="pf-consent" role="region" aria-label="Analytics consent">
      <p>
        Brickwright can record page views, clicks and a masked session replay to help us see how the product is
        used. It stays off unless you say yes — see the <a href="/privacy">privacy policy</a> for what that does and
        does not include.
      </p>
      <div className="pf-consent__actions">
        <button type="button" className="pf-button" onClick={() => setAnalyticsConsent('denied')}>
          Reject
        </button>
        <button type="button" className="pf-button pf-button--primary" onClick={() => setAnalyticsConsent('granted')}>
          Accept
        </button>
      </div>
    </div>
  )
}
