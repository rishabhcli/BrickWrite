import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource-variable/manrope'
import { StrictMode, useEffect, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { CatalogUnavailableError, loadCompiledCatalog, preloadDocumentGeometry, type CatalogLoadResult } from './cad/catalog-loader'
import './styles.css'

/**
 * Boot sequence.
 *
 * The compiled catalog must be resident before any CAD module evaluates, so the
 * editor is loaded dynamically after the fetch resolves. There is no procedural
 * fallback catalog: if the compiled assets are missing, Brickwright says so and
 * refuses to start rather than rendering invented parts.
 */

type BootStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; App: ComponentType; info: CatalogLoadResult }
  | { kind: 'error'; message: string }

let bootPromise: Promise<{ App: ComponentType; info: CatalogLoadResult }> | null = null

function boot() {
  bootPromise ??= (async () => {
    const info = await loadCompiledCatalog()
    const [editor, engine] = await Promise.all([import('./App'), import('./cad/engine')])
    // Warm the geometry the opening document needs so the first painted frame
    // shows real meshes instead of streaming placeholders.
    await preloadDocumentGeometry(
      Object.values(engine.cadEngine.getDocument().parts).map((part) => part.definitionId),
    )
    return { App: editor.default, info }
  })()
  return bootPromise
}

function BootScreen({ status }: { status: BootStatus }) {
  if (status.kind === 'error') {
    return (
      <main className="boot-screen error" role="alert">
        <span className="eyebrow">CATALOG UNAVAILABLE</span>
        <h1>Brickwright cannot start without its compiled catalog</h1>
        <p>
          The editor deliberately has no stand-in parts. Every placeable element must come from compiled
          LDraw geometry with LDCad connection metadata, so a missing catalog is a hard stop.
        </p>
        <pre>{status.message}</pre>
      </main>
    )
  }
  return (
    <main className="boot-screen" aria-busy="true">
      <div className="boot-mark"><span /><span /><span /><span /></div>
      <span className="eyebrow">BRICKWRIGHT</span>
      <h1>Compiling catalog into the CAD kernel</h1>
      <p>Loading LDraw identities, LDCad connection metadata and the LDraw colour table.</p>
    </main>
  )
}

function Boot() {
  const [status, setStatus] = useState<BootStatus>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    boot()
      .then(({ App, info }) => {
        if (!cancelled) setStatus({ kind: 'ready', App, info })
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        const message =
          cause instanceof CatalogUnavailableError || cause instanceof Error ? cause.message : String(cause)
        setStatus({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (status.kind !== 'ready') return <BootScreen status={status} />
  const { App } = status
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
)
