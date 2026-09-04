import { browserCloudRuntime } from '../cloud/browserRuntime'
import { canReachCloud } from '../cloud/runtime'
import type { ModelDocument } from './types'

/**
 * Auto-saving to the cloud: a local build with enough of the operator's work
 * in it should not depend on remembering to click "Save to cloud" before
 * switching browsers or devices. 25 is the same threshold the gallery
 * auto-publish uses, kept as its own constant rather than shared — the two
 * features answer different questions and have no reason to move together.
 */
export const MIN_CLOUD_SAVED_PARTS = 25

/** Projects a claim attempt is in flight for, so a burst of commits crossing
 *  the threshold at once cannot fire two concurrent claims for the same
 *  project. */
const inFlight = new Set<string>()

/**
 * Claims a project into the cloud the moment it first reaches the minimum
 * part count — but only for a real, signed-in account. There is no "other
 * browser" for an anonymous session's guest identity to sync to, so unlike
 * gallery auto-publish this does nothing until the operator actually signs
 * in. Never throws; a failed attempt (offline, no deployment configured,
 * not signed in yet) leaves the project unclaimed and the next commit tries
 * again — `store.claim` itself is what makes a repeat attempt on an
 * already-claimed project a safe no-op.
 */
export async function autoClaimIfEligible(document: ModelDocument): Promise<void> {
  const projectId = document.id
  if (inFlight.has(projectId)) return
  if (Object.keys(document.parts).length < MIN_CLOUD_SAVED_PARTS) return

  // Marked before the first `await`, not after: the check above and this
  // marker have to be one atomic, synchronous step, or two commits racing
  // the same project both pass the check before either one sets it.
  inFlight.add(projectId)
  try {
    const runtime = browserCloudRuntime()
    const snapshot = runtime.getSnapshot()
    if (snapshot.configuration.status !== 'ready' || !snapshot.store) return
    if (!canReachCloud(snapshot.identity)) return
    if (await snapshot.links.get(projectId)) return

    const claimed = await snapshot.store.claim(projectId)
    if (claimed.ok) runtime.notifyLinksChanged()
  } catch {
    // Left unclaimed; the next commit retries.
  } finally {
    inFlight.delete(projectId)
  }
}
