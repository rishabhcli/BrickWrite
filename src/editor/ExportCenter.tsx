import {
  BookOpenCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileBox,
  FileSpreadsheet,
  LoaderCircle,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { exportBomCsv } from '../cad/bom'
import { describeBrickLinkExport, exportBrickLinkXml } from '../cad/bricklink'
import { catalog } from '../cad/catalog'
import { describeArchiveImport } from '../cad/archive'
import { downloadText, exportLDraw, exportMpd } from '../cad/ldraw'
import { geometryCache } from '../cad/mesh'
import { session } from '../cad/session'
import type { RasterImage } from '../cad/raster'
import type { EngineSnapshot } from '../cad/types'
import { useFocusTrap } from '../platform/a11y'

interface Notice {
  kind: 'success' | 'error' | 'info'
  title: string
  detail: string
}

interface ExportCenterProps {
  state: EngineSnapshot
  onImport: (file: File) => Promise<void>
  onNotice: (notice: Notice) => void
}

type GuideState =
  | { kind: 'idle' }
  | { kind: 'loading'; loaded: number; total: number; phase: 'geometry' | 'rendering' }
  | { kind: 'done' }

const safeFilename = (name: string) => name.trim().replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'brickwright_model'

/** Converts a software-rendered RGBA buffer into an inline PNG. */
function encodePng(image: RasterImage): string {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The browser could not create the instruction renderer.')
  context.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * A compact delivery surface rather than three unrelated toolbar buttons.
 * Exports are derived from the current revision and never mutate it.
 */
export function ExportCenter({ state, onImport, onNotice }: ExportCenterProps) {
  const [open, setOpen] = useState(false)
  const [guide, setGuide] = useState<GuideState>({ kind: 'idle' })
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const panel = useFocusTrap(open, { onEscape: close, restoreTo: trigger })
  const name = safeFilename(state.document.name)
  const ready = state.validation.healthy && state.validation.unverifiedCollisions === 0
  const archiveInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
    }
  }, [open])

  const generateGuide = async () => {
    if (guide.kind === 'loading') return
    const definitions = Array.from(new Set(Object.values(state.document.parts).map((part) => part.definitionId)))
      .map((id) => catalog.get(id))
      .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))

    setGuide({ kind: 'loading', loaded: 0, total: definitions.length, phase: 'geometry' })
    // Let React paint the progress state before the CPU renderer starts.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    try {
      for (const [index, definition] of definitions.entries()) {
        await geometryCache.load(definition)
        setGuide({ kind: 'loading', loaded: index + 1, total: definitions.length, phase: 'geometry' })
      }
      setGuide({ kind: 'loading', loaded: definitions.length, total: definitions.length, phase: 'rendering' })
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

      // Kept behind a dynamic import: printable output is a delivery feature,
      // not part of the editor's startup path.
      const { buildBooklet } = await import('../cad/booklet')
      const result = buildBooklet({
        document: state.document,
        geometry: (definitionId) => {
          const definition = catalog.get(definitionId)
          const geometry = definition ? geometryCache.get(definition) : null
          const positions = geometry?.surface.getAttribute('position')
          const indices = geometry?.surface.getIndex()
          if (!geometry || !positions || !indices) return null
          return {
            positions:
              positions.array instanceof Float32Array
                ? positions.array
                : Float32Array.from(positions.array as ArrayLike<number>),
            indices:
              indices.array instanceof Uint32Array
                ? indices.array
                : Uint32Array.from(indices.array as ArrayLike<number>),
            slices: geometry.slices,
          }
        },
        encode: encodePng,
      })
      downloadText(`${name}_BUILD_GUIDE.html`, result.html, 'text/html;charset=utf-8')
      setGuide({ kind: 'done' })
      onNotice({
        kind: result.warnings.length ? 'info' : 'success',
        title: 'Build guide exported',
        detail: result.warnings.length
          ? `${result.steps} steps rendered with ${result.warnings.length} explicit warning${result.warnings.length === 1 ? '' : 's'}.`
          : `${result.steps} fixed-camera steps, a parts list and provenance are embedded in one offline HTML file.`,
      })
    } catch (cause) {
      setGuide({ kind: 'idle' })
      onNotice({
        kind: 'error',
        title: 'Build guide failed',
        detail: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return (
    <div className="export-center" ref={root}>
      <div className="export-split">
        <button
          ref={trigger}
          className="export-primary"
          onClick={() => downloadText(`${name}.ldr`, exportLDraw(state.document))}
          aria-label="Export LDR"
        >
          <Download size={13} /> EXPORT LDR
        </button>
        <button
          className="export-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-label="More export options"
          aria-expanded={open}
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {open && (
        <div ref={panel as RefObject<HTMLDivElement>} className="export-panel" role="dialog" aria-modal="true" aria-label="Deliverables">
          <header>
            <div><strong>Export</strong></div>
            <button onClick={() => setOpen(false)} aria-label="Close export"><X size={13} /></button>
          </header>

          <div className={`release-readiness ${ready ? 'ready' : 'review'}`}>
            <span>{ready ? <Check size={14} /> : <CircleAlert size={14} />}</span>
            <div>
              <strong>{ready ? 'Revision ready to deliver' : 'Review before building'}</strong>
              <small>
                r{state.document.revision} · {state.validation.partCount} parts · {state.validation.connectionCount} connections ·{' '}
                {state.validation.collisions.length} collision issue{state.validation.collisions.length === 1 ? '' : 's'}
              </small>
            </div>
          </div>

          <div className="export-grid">
            <button onClick={() => downloadText(`${name}.ldr`, exportLDraw(state.document))}>
              <FileBox size={17} />
              <span><strong>Flat LDraw</strong><small>.ldr · exact transforms + STEP</small></span>
            </button>
            <button onClick={() => downloadText(`${name}.mpd`, exportMpd(state.document))}>
              <FileBox size={17} />
              <span><strong>Assembly MPD</strong><small>.mpd · submodels preserved</small></span>
            </button>
            <button onClick={() => downloadText(`${name}_BOM.csv`, exportBomCsv(state.document), 'text/csv')}>
              <FileSpreadsheet size={17} />
              <span><strong>Parts manifest</strong><small>.csv · LDraw + external IDs</small></span>
            </button>
            <button
              onClick={() => {
                const { xml, report } = exportBrickLinkXml(state.document)
                downloadText(`${name}_wanted.xml`, xml, 'application/xml')
                const copy = describeBrickLinkExport(report)
                if (copy) onNotice({ kind: 'info', title: copy.title, detail: copy.detail })
              }}
            >
              <FileSpreadsheet size={17} />
              <span><strong>BrickLink wanted list</strong><small>.xml · for ordering</small></span>
            </button>
            <button
              onClick={() => {
                void session.exportArchive().then(
                  (json) => {
                    downloadText(`${name}.brickwright.json`, json, 'application/json')
                  },
                  (cause: unknown) => {
                    onNotice({
                      kind: 'error',
                      title: 'Archive not exported',
                      detail: cause instanceof Error ? cause.message : String(cause),
                    })
                  },
                )
              }}
            >
              <FileBox size={17} />
              <span><strong>Project archive</strong><small>.json · connections, notes, history</small></span>
            </button>
            <button className="guide-export" onClick={() => void generateGuide()} disabled={guide.kind === 'loading'}>
              {guide.kind === 'loading' ? <LoaderCircle className="spin" size={17} /> : <BookOpenCheck size={17} />}
              <span>
                <strong>{guide.kind === 'loading' ? 'Rendering guide…' : guide.kind === 'done' ? 'Build guide again' : 'Printable build guide'}</strong>
                <small>
                  {guide.kind === 'loading'
                    ? guide.phase === 'geometry'
                      ? `${guide.loaded}/${guide.total} geometries ready`
                      : 'Drawing fixed-camera steps'
                    : '.html · offline, self-contained'}
                </small>
              </span>
            </button>
          </div>

          <button className="import-row" onClick={() => input.current?.click()}>
            <Upload size={14} />
            <span><strong>Import LDraw or MPD</strong><small>Unknown and uncompiled references are reported, never silently dropped.</small></span>
          </button>
          <button className="import-row" onClick={() => archiveInput.current?.click()}>
            <Upload size={14} />
            <span><strong>Import project archive</strong><small>.json · opens as a new local project, never overwrites.</small></span>
          </button>
          <input
            ref={input}
            hidden
            type="file"
            accept=".ldr,.mpd,text/plain"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (!file) return
              await onImport(file)
              event.target.value = ''
              setOpen(false)
            }}
          />
          <input
            ref={archiveInput}
            hidden
            type="file"
            accept=".json,application/json"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (!file) return
              const imported = await session.importArchive(await file.text())
              if (!imported.ok) {
                onNotice({ kind: 'error', title: 'Archive not imported', detail: imported.message })
              } else {
                const copy = describeArchiveImport(imported.report)
                onNotice({ kind: imported.report.unplaceableParts.length ? 'info' : 'success', title: copy.title, detail: copy.detail })
              }
              event.target.value = ''
              setOpen(false)
            }}
          />
          <footer>Every artifact is generated locally from revision {state.document.revision}. No model geometry is uploaded.</footer>
        </div>
      )}
    </div>
  )
}
