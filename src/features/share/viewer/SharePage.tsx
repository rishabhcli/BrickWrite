import { useCallback, useEffect, useState } from 'react'
import { createRepository } from '../../../cad/persistence'
import type { ModelDocument } from '../../../cad/types'
import type { ForkProvenance, Publication, ShareCapabilities } from '../types'
import { loadPublicationGeometry, residentGeometry, type GeometryProgress } from './geometry'
import { SharedViewer } from './SharedViewer'
import '../share.css'

/**
 * The `/share/:slug` client route.
 *
 * The Cloudflare Function already served a complete, crawlable page at this
 * address — see `functions/share/[slug].ts`. This surface is what an in-app
 * navigation gets instead: the same publication, with the interactive viewer on
 * top. Neither depends on the other, and the Function remains the only one a
 * crawler ever sees.
 *
 * It fetches `/share/:slug/view.json`, which returns the publication and the
 * capabilities the access gate granted *this* request — including whatever the
 * `?t=` token in the address unlocked. The gate runs server-side; nothing here
 * decides what a visitor may do.
 */

type Phase =
  | { kind: 'loading'; detail: string }
  | { kind: 'ready'; publication: Publication; capabilities: ShareCapabilities; geometry: GeometryProgress }
  | { kind: 'error'; status: number; message: string }

export interface SharePageProps {
  /** Overrides the slug taken from `location.pathname`; used by the harness. */
  slug?: string
  /** Overrides `location.search`, so a token can be supplied explicitly. */
  search?: string
  /** Called after a fork is persisted, so the host can navigate to the editor. */
  onForked?: (result: { document: ModelDocument; provenance: ForkProvenance }) => void
}

function slugFromLocation(): string | null {
  if (typeof window === 'undefined') return null
  const match = /^\/share\/([a-z0-9][a-z0-9-]{0,95})(?:\/|$)/.exec(window.location.pathname)
  return match ? match[1] : null
}

export default function SharePage({ slug: slugOverride, search: searchOverride, onForked }: SharePageProps = {}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading', detail: 'Fetching the publication' })
  const [forkNotice, setForkNotice] = useState<string | null>(null)

  const slug = slugOverride ?? slugFromLocation()
  const search = searchOverride ?? (typeof window === 'undefined' ? '' : window.location.search)

  useEffect(() => {
    if (!slug) {
      setPhase({ kind: 'error', status: 404, message: 'That address does not name a published model.' })
      return
    }
    let cancelled = false

    void (async () => {
      try {
        setPhase({ kind: 'loading', detail: 'Fetching the publication' })
        const response = await fetch(`/share/${slug}/view.json${search}`, {
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { message?: string }
          if (cancelled) return
          setPhase({
            kind: 'error',
            status: response.status,
            message: body.message ?? 'This model is not available.',
          })
          return
        }
        const payload = (await response.json()) as {
          publication: Publication
          capabilities: ShareCapabilities
        }
        if (cancelled) return

        setPhase({ kind: 'loading', detail: 'Loading compiled geometry' })
        const geometry = await loadPublicationGeometry(
          payload.publication.document.parts.map((part) => part.definitionId),
        )
        if (cancelled) return
        setPhase({
          kind: 'ready',
          publication: payload.publication,
          capabilities: payload.capabilities,
          geometry,
        })
      } catch (cause) {
        if (cancelled) return
        setPhase({
          kind: 'error',
          status: 0,
          message: cause instanceof Error ? cause.message : 'The publication could not be loaded.',
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [slug, search])

  /**
   * Persists a fork into the operator's own local project store.
   *
   * This is the only write anywhere in `viewer/`, and it writes a *new* project:
   * `forkPublication` produced a document with a fresh id, and the repository is
   * keyed by that id, so there is no key under which it could overwrite the
   * publication's source project even if it wanted to.
   */
  const handleFork = useCallback(
    (result: { document: ModelDocument; provenance: ForkProvenance }) => {
      void (async () => {
        try {
          await createRepository().saveCheckpoint(result.document)
          setForkNotice(`Saved “${result.document.name}” as a new project. Open it from Projects.`)
          onForked?.(result)
        } catch (cause) {
          setForkNotice(
            `The copy was created but could not be saved locally: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      })()
    },
    [onForked],
  )

  if (phase.kind === 'loading') {
    return (
      <main className="bw-share-route bw-share-state" aria-busy="true">
        <span className="bw-share-eyebrow">BRICKWRIGHT</span>
        <h1>Opening the published model</h1>
        <p>{phase.detail}…</p>
      </main>
    )
  }

  if (phase.kind === 'error') {
    return (
      <main className="bw-share-route bw-share-state" role="alert">
        <span className="bw-share-eyebrow">{phase.status || 'ERROR'}</span>
        <h1>This model is not available</h1>
        <p>{phase.message}</p>
        <p>
          <a className="bw-share-action" href="/gallery">
            Browse published models
          </a>
        </p>
      </main>
    )
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <main className="bw-share-route">
      {forkNotice ? (
        <p className="bw-share-notice" role="status" data-testid="fork-notice">
          {forkNotice}
        </p>
      ) : null}
      <SharedViewer
        publication={phase.publication}
        capabilities={phase.capabilities}
        geometry={residentGeometry}
        shareUrl={`${origin}/share/${phase.publication.slug}`}
        embedUrl={`${origin}/embed/${phase.publication.slug}`}
        unavailableDefinitionIds={[
          ...phase.geometry.unavailable,
          ...phase.geometry.failed.map((entry) => entry.definitionId),
        ]}
        onFork={phase.capabilities.fork ? handleFork : undefined}
      />
    </main>
  )
}
