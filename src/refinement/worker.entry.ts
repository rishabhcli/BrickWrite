import { installRefinementWorker } from './worker'

/**
 * The module a `new Worker(...)` points at.
 *
 * Nothing but the wiring lives here so that importing the protocol, the handler
 * or the client from ordinary code never registers a global message listener as
 * a side effect.
 */
installRefinementWorker(self as unknown as Parameters<typeof installRefinementWorker>[0])
