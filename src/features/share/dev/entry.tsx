import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { catalog } from '../../../cad/catalog'
import { loadCompiledCatalog } from '../../../cad/catalog-loader'
import { createShowcaseDocument } from '../../../cad/sample'
import { validateDocument } from '../../../cad/validation'
import type { ModelDocument, ValidationReport } from '../../../cad/types'
import { loadPublicationGeometry, residentGeometry } from '../viewer/geometry'
import SharePage from '../viewer/SharePage'
import { ShareStudio } from '../studio/ShareStudio'
import type { Publication } from '../types'
import '../share.css'

/**
 * Development harness for Share Studio and the read-only viewer.
 *
 * The application shell mounts these surfaces through the platform route
 * registry, which the integrator wires. This page exists so the acceptance run
 * — and anybody working on this workstream — can drive the real components
 * against the real compiled catalog before that wiring lands, without a stub
 * anywhere in the path.
 *
 * It is served by Vite at `/src/features/share/dev/studio.html`, is marked
 * `noindex`, and is never part of a production build: nothing in the
 * application's entry graph imports it.
 *
 *   ?view=studio            Share Studio over the showcase document (default)
 *   ?view=share&slug=<slug> the read-only viewer for a published model
 *   ?token=<secret>         bearer for the local publish endpoint
 */

type Boot =
  | { kind: 'loading'; detail: string }
  | { kind: 'ready'; document: ModelDocument; validation: ValidationReport }
  | { kind: 'error'; message: string }

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'studio'
const publishToken = params.get('token') ?? 'dev-publish-token'

function Harness() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading', detail: 'Loading the compiled catalog' })

  useEffect(() => {
    if (view !== 'studio') return
    let cancelled = false
    void (async () => {
      try {
        await loadCompiledCatalog()
        if (cancelled) return
        setBoot({ kind: 'loading', detail: 'Assembling the showcase model' })
        const document = createShowcaseDocument()
        setBoot({ kind: 'loading', detail: 'Loading compiled geometry' })
        await loadPublicationGeometry(Object.values(document.parts).map((part) => part.definitionId))
        if (cancelled) return
        setBoot({ kind: 'ready', document, validation: validateDocument(document) })
      } catch (cause) {
        if (!cancelled) {
          setBoot({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const publish = useCallback(
    async (publication: Publication, cards: Record<string, Uint8Array>) => {
      const encoded: Record<string, string> = {}
      for (const [preset, bytes] of Object.entries(cards)) {
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        encoded[preset] = btoa(binary)
      }
      const response = await fetch('/publications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${publishToken}`,
        },
        body: JSON.stringify({ publication, cards: encoded }),
      })
      const body = (await response.json()) as { slug?: string; message?: string }
      if (!response.ok || !body.slug) throw new Error(body.message ?? `The publish endpoint returned ${response.status}.`)
      return { slug: body.slug }
    },
    [],
  )

  if (view === 'share') {
    const slug = params.get('slug') ?? ''
    return <SharePage slug={slug} search={params.has('t') ? `?t=${encodeURIComponent(params.get('t')!)}` : ''} />
  }

  if (boot.kind === 'loading') {
    return (
      <main className="bw-share-route bw-share-state" aria-busy="true" data-testid="harness-loading">
        <span className="bw-share-eyebrow">BRICKWRIGHT</span>
        <h1>Share Studio harness</h1>
        <p>{boot.detail}…</p>
      </main>
    )
  }
  if (boot.kind === 'error') {
    return (
      <main className="bw-share-route bw-share-state" role="alert" data-testid="harness-error">
        <span className="bw-share-eyebrow">HARNESS</span>
        <h1>The harness could not start</h1>
        <p>{boot.message}</p>
      </main>
    )
  }

  return (
    <div data-testid="harness-ready" data-catalog={catalog.version} data-revision={boot.document.revision}>
      <ShareStudio
        document={boot.document}
        geometry={residentGeometry}
        validation={boot.validation}
        author={{ displayName: 'Acceptance Run', handle: null, url: null }}
        onPublish={publish}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)
