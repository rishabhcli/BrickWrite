import { defineHexclaveConfig, type HexclaveConfig } from '@hexclave/react'

/**
 * Hexclave project configuration, as code.
 *
 * `hexclave dev` reads this file, reconciles the local project against it and
 * injects the resulting project ID into the wrapped `dev:inner` process, so this
 * is the source of truth for which Hexclave apps Brickwright has installed —
 * not the dashboard.
 *
 * Environment-specific material deliberately does not live here: OAuth client
 * IDs and secrets, email delivery credentials and trusted domains are configured
 * per environment. Google and GitHub work out of the box in development because
 * Hexclave supplies shared development credentials for them.
 */
export const config: HexclaveConfig = defineHexclaveConfig({
  apps: {
    installed: {
      authentication: { enabled: true },
      emails: { enabled: true },
      analytics: { enabled: true },
    },
  },
  auth: {
    password: { allowSignIn: true },
    otp: { allowSignIn: true },
    passkey: { allowSignIn: true },
    oauth: {
      providers: {
        google: { type: 'google', allowSignIn: true, allowConnectedAccounts: true },
        github: { type: 'github', allowSignIn: true, allowConnectedAccounts: true },
      },
    },
  },
  emails: {
    selectedThemeId: 'a0172b5d-cff0-463b-83bb-85124697373a',
  },
})
