import { getHexclaveClientApp } from '../hexclave/client';
import { IndexedDbProjectStore, ConvexProjectStore, type ProjectStore } from './projectStore';

/**
 * Resolve the appropriate {@link ProjectStore} for the current session.
 *
 * - If Hexclave is configured and the user is signed in, we intend to use the
 *   remote Convex implementation.
 * - Otherwise we fall back to the local IndexedDB store, preserving the
 *   existing offline‑first experience.
 */
let cachedStore: ProjectStore | null = null;

export async function getProjectStore(): Promise<ProjectStore> {
  const hexResult = getHexclaveClientApp();
  if (hexResult.status === 'ok') {
    // TODO: check authentication state – for now we assume presence of a valid
    // client means the user can access Convex.
    if (!cachedStore) cachedStore = new ConvexProjectStore();
    return cachedStore;
  }
  // No Hexclave client – use the local store.
  if (!cachedStore) cachedStore = new IndexedDbProjectStore();
  return cachedStore;
}

export type { ProjectStore } from './projectStore';
