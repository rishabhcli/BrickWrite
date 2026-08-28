import { HexclaveServerApp } from '@hexclave/react'
import { renderPlatformEmail, type PlatformEmailRequest } from '../emails'

/**
 * Email delivery. Server only.
 *
 * This is the only module in `src/platform` that touches
 * `HEXCLAVE_SECRET_SERVER_KEY`, and nothing under `src/platform` outside this
 * directory imports it — `emails.test.ts` asserts that, and
 * `secret-scan.test.ts` asserts the client entry cannot reach it. The runtime
 * guard below is the third layer: if a bundler ever did drag this into a
 * browser chunk, it fails loudly on evaluation rather than shipping a key.
 *
 * Nothing here has been executed against the live project. `sendPlatformEmail`
 * has never been called outside a type check, and no Brickwright test invokes
 * it — see the NOT_COMPLETE list in `docs/integration/platform-shell.md`.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'src/platform/server/emails.server.ts was evaluated in a browser. This module reads ' +
      'HEXCLAVE_SECRET_SERVER_KEY and must never be reachable from the client entry.',
  )
}

/** Declared locally: `tsconfig.app.json` excludes Node types from the browser program. */
declare const process: { env?: Record<string, string | undefined> } | undefined

export type EmailTransport =
  | { status: 'ready'; app: HexclaveServerApp<true, string> }
  | { status: 'unavailable'; reason: string }

function readEnv(name: string): string | undefined {
  const value = typeof process !== 'undefined' ? process.env?.[name] : undefined
  return value && value.trim() !== '' ? value.trim() : undefined
}

let transport: EmailTransport | null = null

/**
 * Construct the server app once, or explain why it could not be built.
 *
 * A `Result` rather than a throw for the same reason the client app is one: a
 * missing key is a deployment fact the caller has to report, not a crash.
 */
export function getEmailTransport(): EmailTransport {
  if (transport) return transport
  const projectId = readEnv('HEXCLAVE_PROJECT_ID')
  const secretServerKey = readEnv('HEXCLAVE_SECRET_SERVER_KEY')
  if (!projectId || !secretServerKey) {
    transport = {
      status: 'unavailable',
      reason:
        'Email delivery needs HEXCLAVE_PROJECT_ID and HEXCLAVE_SECRET_SERVER_KEY in the server ' +
        'environment. Neither is checked in; CI and production supply them as secrets.',
    }
    return transport
  }
  transport = {
    status: 'ready',
    app: new HexclaveServerApp({ tokenStore: 'memory', projectId, secretServerKey }),
  }
  return transport
}

/** Drop the memoised transport. Tests use this; runtime code does not. */
export function resetEmailTransport(): void {
  transport = null
}

export type SendResult = { status: 'sent' } | { status: 'unavailable'; reason: string }

/**
 * Deliver one rendered message through Hexclave's emails app.
 *
 * The theme comes from `hexclave.config.ts`, so branding is configured once and
 * not restated per message.
 */
export async function sendPlatformEmail(request: PlatformEmailRequest): Promise<SendResult> {
  const active = getEmailTransport()
  if (active.status === 'unavailable') return { status: 'unavailable', reason: active.reason }
  const rendered = renderPlatformEmail(request.email)
  await active.app.sendEmail({
    ...request.recipients,
    subject: rendered.subject,
    html: rendered.html,
    notificationCategoryName: rendered.notificationCategoryName,
  } as Parameters<typeof active.app.sendEmail>[0])
  return { status: 'sent' }
}
