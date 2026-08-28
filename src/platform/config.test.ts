import { describe, expect, it } from 'vitest'
import {
  PLATFORM_PATHS,
  PLATFORM_URL_DESTINATIONS,
  PROJECT_ID_ENV_VARS,
  ambientEnvironment,
  hexclaveUrlOptions,
  resolvePlatformConfig,
} from './config'

describe('platform configuration', () => {
  it('reports "misconfigured" honestly when no project id is present anywhere', () => {
    const config = resolvePlatformConfig({})
    expect(config.status).toBe('misconfigured')
    if (config.status !== 'misconfigured') throw new Error('unreachable')
    expect(config.checked).toEqual(PROJECT_ID_ENV_VARS)
    expect(config.reason).toMatch(/Local CAD work is unaffected/)
    // Destinations stay available so links still resolve while accounts do not.
    expect(config.urls).toEqual(PLATFORM_URL_DESTINATIONS)
  })

  it('treats blank and whitespace-only values as absent', () => {
    expect(resolvePlatformConfig({ HEXCLAVE_PROJECT_ID: '' }).status).toBe('misconfigured')
    expect(resolvePlatformConfig({ VITE_HEXCLAVE_PROJECT_ID: '   ' }).status).toBe('misconfigured')
  })

  it('resolves the project id and names the variable that supplied it', () => {
    const config = resolvePlatformConfig({ VITE_HEXCLAVE_PROJECT_ID: ' proj-42 ' })
    expect(config).toMatchObject({ status: 'ready', projectId: 'proj-42', projectIdSource: 'VITE_HEXCLAVE_PROJECT_ID' })
  })

  it('follows the SDK precedence order', () => {
    const config = resolvePlatformConfig({
      HEXCLAVE_PROJECT_ID: 'first',
      VITE_HEXCLAVE_PROJECT_ID: 'second',
      VITE_STACK_PROJECT_ID: 'third',
    })
    expect(config).toMatchObject({ projectId: 'first' })
  })

  it('reads the ambient environment without throwing outside a browser', () => {
    expect(() => ambientEnvironment()).not.toThrow()
  })

  it('hosts sign-in, sign-up and account settings on Brickwright routes', () => {
    const urls = hexclaveUrlOptions()
    expect(urls.default).toEqual({ type: 'hosted' })
    expect(urls.signIn).toMatchObject({ type: 'custom', url: PLATFORM_PATHS.signIn })
    expect(urls.signUp).toMatchObject({ type: 'custom', url: PLATFORM_PATHS.signUp })
    expect(urls.accountSettings).toMatchObject({ type: 'custom', url: PLATFORM_PATHS.account })
  })

  it('claims a page-component version the installed SDK actually knows', () => {
    const urls = hexclaveUrlOptions()
    for (const key of ['signIn', 'signUp', 'accountSettings'] as const) {
      const target = urls[key]
      expect(typeof target === 'object' && target !== null && 'version' in target).toBe(true)
      const version = (target as { version: number }).version
      expect(Number.isInteger(version)).toBe(true)
      expect(version).toBeGreaterThanOrEqual(1)
    }
  })

  it('sends people somewhere real after every auth transition', () => {
    const urls = hexclaveUrlOptions()
    for (const key of ['home', 'afterSignIn', 'afterSignUp', 'afterSignOut'] as const) {
      expect(typeof urls[key]).toBe('string')
      expect(String(urls[key]).startsWith('/')).toBe(true)
    }
  })
})
