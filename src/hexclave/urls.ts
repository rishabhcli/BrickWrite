import { getPagePrompt, type HandlerUrlOptions } from '@hexclave/react'
import { PLATFORM_PATHS, PLATFORM_URL_DESTINATIONS, type PlatformUrlDestinations } from '../platform/config'

/**
 * Look up the page-component version Hexclave currently expects for a custom
 * auth page.
 *
 * Lives next to the client app rather than in `platform/config.ts` so the
 * landing entry can resolve configuration without pulling the account SDK.
 */
function pageVersion(page: 'signIn' | 'signUp' | 'accountSettings'): number {
  return getPagePrompt(page)?.latestVersion ?? 1
}

/**
 * The `urls` option for `HexclaveClientApp`.
 *
 * Sign-in, sign-up and account settings are Brickwright routes rendered with
 * Hexclave's own components, so they keep the application's chrome, its fonts
 * and its offline banner. Everything else stays hosted.
 */
export function hexclaveUrlOptions(urls: PlatformUrlDestinations = PLATFORM_URL_DESTINATIONS): HandlerUrlOptions {
  return {
    default: { type: 'hosted' },
    signIn: { type: 'custom', url: urls.signIn, version: pageVersion('signIn') },
    signUp: { type: 'custom', url: urls.signUp, version: pageVersion('signUp') },
    accountSettings: { type: 'custom', url: urls.accountSettings, version: pageVersion('accountSettings') },
    home: urls.home,
    afterSignIn: urls.afterSignIn,
    afterSignUp: urls.afterSignUp,
    afterSignOut: urls.afterSignOut,
  }
}

export { PLATFORM_PATHS }
