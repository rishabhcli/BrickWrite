import { HexclaveClientApp } from '@hexclave/react'

/**
 * The Hexclave client app.
 *
 * Brickwright is a pure browser application: there is no server process that
 * could hold a secret server key, so only a `HexclaveClientApp` is ever
 * constructed here. A `HexclaveServerApp` must never appear in this bundle.
 *
 * The project ID is not read from a checked-in file. It arrives as an
 * environment variable injected by `hexclave dev` (see the `dev` script), or by
 * the deployment environment in production. That means the constructor throws
 * whenever the app is started outside that wrapper — `vite` run bare, `vite
 * preview` against a build made without it, the browser smoke harness. Those
 * paths still have to boot the CAD editor, so construction is reported as a
 * `Result` and the caller decides, rather than taking the whole editor down
 * with an exception at module-evaluation time.
 */
function createHexclaveClientApp() {
  return new HexclaveClientApp({
    tokenStore: 'cookie',
    urls: {
      default: {
        type: 'hosted',
      },
    },
  })
}

export type BrickwrightHexclaveApp = ReturnType<typeof createHexclaveClientApp>

export type HexclaveClientAppResult =
  | { status: 'ok'; data: BrickwrightHexclaveApp }
  | { status: 'error'; error: Error }

let resolved: HexclaveClientAppResult | null = null

/**
 * Construct the Hexclave client app once, or explain why it could not be built.
 *
 * Memoised because the constructor registers browser side effects (cookie token
 * store, session refresh, analytics capture) that must not be installed twice —
 * React 19 StrictMode renders every component twice in development.
 */
export function getHexclaveClientApp(): HexclaveClientAppResult {
  if (resolved) return resolved
  try {
    resolved = { status: 'ok', data: createHexclaveClientApp() }
  } catch (cause: unknown) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    // Deliberately a warning, not an error: an unconfigured account layer is a
    // degraded start, not a failure of the CAD kernel, and Brickwright's smoke
    // harness treats console errors as a failed run.
    console.warn(
      'Hexclave is not configured for this process, so account features are unavailable. ' +
        'Start the dev server with `npm run dev`, which wraps Vite in `hexclave dev` and injects the project ID.',
      error.message,
    )
    resolved = { status: 'error', error }
  }
  return resolved
}
