import { getPagePrompt, type HandlerUrlOptions } from '@hexclave/react'

/**
 * Where the account layer lives, and whether it can exist at all.
 *
 * Brickwright is a pure browser application. The Hexclave project ID is never
 * checked in: `hexclave dev` injects it into the wrapped Vite process, and the
 * deployment environment supplies it in production. Everything that depends on
 * that ID therefore has to survive its absence, because the CAD editor still
 * has to boot when the account layer cannot — `vite` run bare, `vite preview`
 * against a build made without the wrapper, the browser smoke harness, and the
 * unit test run all take that path.
 *
 * This module is the single place that decides "is the account layer
 * configured?", so no other module has to guess.
 */

/** Brickwright's own routes, in the shape Hexclave's URL resolver expects. */
export const PLATFORM_PATHS = {
  home: '/',
  explore: '/explore',
  editor: '/editor',
  projects: '/projects',
  account: '/account',
  gallery: '/gallery',
  signIn: '/auth/sign-in',
  signUp: '/auth/sign-up',
} as const

/**
 * Destinations Hexclave redirects to, by name.
 *
 * `afterSignIn` and `afterSignUp` deliberately land on `/projects` rather than
 * `/editor`: signing in is how local work becomes cloud work, so the first
 * thing a freshly signed-in operator should see is where their work now lives.
 * The SDK's own runtime redirect-back takes precedence over these whenever a
 * guard sent the user to sign in from somewhere specific.
 */
export const PLATFORM_URL_DESTINATIONS = {
  home: PLATFORM_PATHS.home,
  signIn: PLATFORM_PATHS.signIn,
  signUp: PLATFORM_PATHS.signUp,
  accountSettings: PLATFORM_PATHS.account,
  afterSignIn: PLATFORM_PATHS.projects,
  afterSignUp: PLATFORM_PATHS.projects,
  afterSignOut: PLATFORM_PATHS.home,
} as const

export type PlatformUrlDestinations = typeof PLATFORM_URL_DESTINATIONS

/**
 * The environment variables the Hexclave SDK will read for the project ID, in
 * the SDK's own precedence order.
 *
 * Mirrored here rather than imported because the SDK's resolver throws when the
 * ID is missing, and "missing" is a state Brickwright has to render, not crash
 * on. Verified against `@hexclave/react@1.0.106`
 * (`dist/esm/generated/env.js`, getter `HEXCLAVE_PROJECT_ID`); `hexclave dev`
 * injects `VITE_HEXCLAVE_PROJECT_ID` for Vite projects
 * (`@hexclave/cli@1.0.106`, `dist/index.js`).
 */
export const PROJECT_ID_ENV_VARS = [
  'HEXCLAVE_PROJECT_ID',
  'NEXT_PUBLIC_HEXCLAVE_PROJECT_ID',
  'VITE_HEXCLAVE_PROJECT_ID',
  'STACK_PROJECT_ID',
  'NEXT_PUBLIC_STACK_PROJECT_ID',
  'VITE_STACK_PROJECT_ID',
] as const

/**
 * Declared locally because `tsconfig.app.json` deliberately excludes Node types
 * from the browser program. The guard below is a real runtime check — `process`
 * genuinely does not exist in the shipped bundle — so the declaration only tells
 * the type checker what the guard already establishes.
 */
declare const process: { env?: Record<string, string | undefined> } | undefined

export type PlatformEnvironmentSource = Record<string, string | undefined>

export type PlatformConfig =
  | {
      status: 'ready'
      projectId: string
      /** Which variable actually supplied the ID, for the diagnostics panel. */
      projectIdSource: string
      urls: PlatformUrlDestinations
    }
  | {
      status: 'misconfigured'
      /** Operator-facing sentence, not a stack trace. */
      reason: string
      /** Every name that was checked, so the fix is obvious. */
      checked: readonly string[]
      urls: PlatformUrlDestinations
    }

/**
 * Read the ambient environment.
 *
 * `import.meta.env` is the only source that survives into the browser bundle;
 * `process.env` exists in Node (tests, tooling) and is folded in so the same
 * resolution logic answers in both places.
 */
export function ambientEnvironment(): PlatformEnvironmentSource {
  const fromProcess: PlatformEnvironmentSource =
    typeof process !== 'undefined' && process.env ? (process.env as PlatformEnvironmentSource) : {}
  const fromVite = (import.meta.env ?? {}) as unknown as PlatformEnvironmentSource
  return { ...fromProcess, ...fromVite }
}

/** Resolve the account layer's configuration, or explain precisely why it is absent. */
export function resolvePlatformConfig(env: PlatformEnvironmentSource = ambientEnvironment()): PlatformConfig {
  for (const name of PROJECT_ID_ENV_VARS) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return {
        status: 'ready',
        projectId: value.trim(),
        projectIdSource: name,
        urls: PLATFORM_URL_DESTINATIONS,
      }
    }
  }
  return {
    status: 'misconfigured',
    reason:
      'No Hexclave project ID is present in this environment, so accounts, cloud projects and ' +
      'publication are unavailable. Local CAD work is unaffected. Start the dev server with ' +
      '`npm run dev`, which wraps Vite in `hexclave dev` and injects the ID.',
    checked: PROJECT_ID_ENV_VARS,
    urls: PLATFORM_URL_DESTINATIONS,
  }
}

/**
 * Look up the page-component version Hexclave currently expects for a custom
 * auth page.
 *
 * The `version` field on `{ type: 'custom' }` tells Hexclave which generation of
 * its page contract our route implements, so it can warn when the SDK moves
 * ahead of us. Reading it from `getPagePrompt` rather than hardcoding a number
 * means an SDK upgrade does not silently leave a stale claim behind.
 */
function pageVersion(page: 'signIn' | 'signUp' | 'accountSettings'): number {
  return getPagePrompt(page)?.latestVersion ?? 1
}

/**
 * The `urls` option for `HexclaveClientApp`.
 *
 * Sign-in, sign-up and account settings are Brickwright routes rendered with
 * Hexclave's own components, so they keep the application's chrome, its fonts
 * and its offline banner. Everything else — email verification, password reset,
 * the OAuth and magic-link callbacks, MFA, onboarding, team invitations — stays
 * on `{ type: 'hosted' }`, because those pages are security-sensitive, change
 * with the platform, and have no Brickwright-specific content. Verified with
 * Hexclave: the OAuth callback always terminates on Hexclave's API host, so a
 * custom sign-in page does not require a custom callback route.
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
