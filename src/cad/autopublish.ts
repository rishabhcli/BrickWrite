import { hexclaveAuthorizationHeaderOrAnonymous } from '../hexclave/authorization'
import { createPublication } from '../features/share/publish'
import type { ModelDocument, ValidationReport } from './types'

/**
 * Auto-publishing: Brickwrite's gallery has no separate "make it public"
 * step. Every build is public by construction, and the moment one reaches
 * this many placed parts it publishes itself — with an account or without
 * one, since `hexclaveAuthorizationHeaderOrAnonymous` gives even a signed-out
 * builder a subject to own the result.
 */
export const MIN_PUBLISHABLE_PARTS = 25

const STORAGE_KEY = 'brickwrite:auto-published-projects'

function readPublished(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rememberPublished(projectId: string, slug: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPublished(), [projectId]: slug }))
  } catch {
    // Best effort: if this can't be written, the next commit tries to publish
    // again, which costs a wasted request rather than a lost build.
  }
}

/** The slug this project auto-published as, or null if it has not yet. */
export function autoPublishedSlug(projectId: string): string | null {
  return readPublished()[projectId] ?? null
}

/** Projects with a publish attempt in flight, so a burst of commits crossing
 *  the threshold in quick succession cannot mint two gallery entries for the
 *  same project before the first request's response comes back. */
const inFlight = new Set<string>()

/**
 * Publishes `document` if it has just become eligible.
 *
 * Called on every commit; a no-op until a project first reaches
 * `MIN_PUBLISHABLE_PARTS`, and a no-op forever after for that same project
 * once it has. Never throws — a failed attempt (offline, no Hexclave project
 * configured, a rejected request) leaves the project unpublished, and the
 * next commit tries again.
 */
export async function autoPublishIfEligible(document: ModelDocument, validation: ValidationReport | null): Promise<void> {
  const projectId = document.id
  if (inFlight.has(projectId) || autoPublishedSlug(projectId) !== null) return
  if (Object.keys(document.parts).length < MIN_PUBLISHABLE_PARTS) return

  inFlight.add(projectId)
  try {
    const authorization = await hexclaveAuthorizationHeaderOrAnonymous()
    if (!authorization) return

    const publication = await createPublication({ document, validation })
    const response = await fetch('/publications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authorization },
      body: JSON.stringify({ publication, cards: {} }),
    })
    if (!response.ok) return
    const body = (await response.json()) as { slug?: string }
    if (body.slug) rememberPublished(projectId, body.slug)
  } catch {
    // Left unpublished; the next commit retries.
  } finally {
    inFlight.delete(projectId)
  }
}
