/**
 * Worker entry for derived viewport state.
 *
 * Intentionally thin: every line of logic lives in `derived.ts` so that the
 * worker path and the synchronous fallback are the same code. A worker with its
 * own copy of an algorithm is a second implementation to keep correct, and the
 * one that only runs in a real browser is the one that stops being tested.
 */
import { computeDerived, type DerivedRequest } from './derived'

self.onmessage = (event: MessageEvent<DerivedRequest>) => {
  ;(self as unknown as { postMessage: (message: unknown) => void }).postMessage(computeDerived(event.data))
}
