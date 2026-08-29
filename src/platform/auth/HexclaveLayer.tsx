import { useMemo, type ReactNode } from 'react'
import { HexclaveProvider, HexclaveTheme } from '@hexclave/react'
import { getHexclaveClientApp } from '../../hexclave/client'
import { resolvePlatformConfig } from '../config'
import { AccountAvailabilityProvider, type AccountAvailability } from './account'

/**
 * The Hexclave provider tree.
 *
 * Loaded after first paint from `AppShell`, never imported by the landing
 * entry, so a visitor to `/` does not download the account SDK before the
 * headline. Keep this module the only place that constructs the client app
 * for the React tree — splitting `@hexclave/react` across chunks blanked
 * production once already.
 */
function accountAvailability(): AccountAvailability {
  const app = getHexclaveClientApp()
  if (app.status === 'ok') return { status: 'ready' }
  const config = resolvePlatformConfig()
  if (config.status === 'misconfigured') {
    return { status: 'unavailable', reason: config.reason, checked: config.checked }
  }
  return {
    status: 'unavailable',
    reason: `Hexclave could not be initialised in this environment: ${app.error.message}`,
    checked: [],
  }
}

export function HexclaveLayer({ children }: { children: ReactNode }) {
  const app = getHexclaveClientApp()
  const availability = useMemo(accountAvailability, [])

  if (app.status === 'error') {
    return <AccountAvailabilityProvider availability={availability}>{children}</AccountAvailabilityProvider>
  }

  return (
    <AccountAvailabilityProvider availability={availability}>
      <HexclaveProvider app={app.data}>
        <HexclaveTheme>{children}</HexclaveTheme>
      </HexclaveProvider>
    </AccountAvailabilityProvider>
  )
}

export default HexclaveLayer
