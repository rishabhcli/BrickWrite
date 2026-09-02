import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { catalog } from '../../../cad/catalog'
import { rgbFromHex } from '../../../cad/raster'
import type { ModelDocument, ValidationReport } from '../../../cad/types'
import { sha256Hex } from '../canonical'
import { renderCard, renderFrame, type CardRenderInput } from '../render/cards'
import { CARD_GEOMETRY, CARD_PRESET_IDS, STUDIO_PRESET_IDS, type StudioPresetId } from '../render/presets'
import type { GeometryResolver } from '../render/scene'
import { sanitizeFilename } from '../sanitize'
import { serializePublishedDocument } from '../serialize'
import { createPublication } from '../publish'
import {
  CAPABILITY_KEYS,
  type CardPresetId,
  type Publication,
  type PublicationAuthor,
  type PublicationCard,
  type ShareCapabilities,
  type Visibility,
} from '../types'
import { useStudioSettings } from './useStudioSettings'
import '../share.css'

/**
 * Share Studio.
 *
 * The job is narrow and worth doing well: take the revision the operator is
 * looking at, let them decide how it should *look* to a stranger, and then
 * freeze that decision into an immutable publication with real rendered cards.
 *
 * Two things shape the interface.
 *
 * **The preview is the artifact.** It is produced by the same `renderFrame`
 * call that produces the published card, at a smaller size — not an
 * approximation of it. What is on screen is what gets published, which is the
 * only way a studio is worth using.
 *
 * **Publishing is a commitment.** The panel says which revision is being
 * captured and states plainly that later edits will not change it, because the
 * immutability guarantee is only useful if the person relying on it knows it is
 * there.
 */

export interface ShareStudioProps {
  document: ModelDocument
  geometry: GeometryResolver
  validation?: ValidationReport | null
  /** Attribution the account layer supplied. Never invented here. */
  author?: PublicationAuthor | null
  /**
   * Persists the publication and its card bytes. The studio does not talk to
   * storage itself — the host owns the endpoint and the credentials.
   */
  onPublish: (
    publication: Publication,
    cards: Record<string, Uint8Array>,
  ) => Promise<{ slug: string; token?: string; shareUrl?: string }>
  /** Offers a rendered card as a download. Defaults to an anchor click. */
  onDownload?: (filename: string, bytes: Uint8Array) => void
  origin?: string
}

type PublishPhase =
  | { kind: 'idle' }
  | { kind: 'rendering'; preset: string; done: number; total: number }
  | { kind: 'publishing' }
  | {
      kind: 'published'
      slug: string
      revision: number
      contentHash: string
      visibility: Visibility
      token?: string
      shareUrl?: string
    }
  | { kind: 'error'; message: string }

const PREVIEW_WIDTH = 520
const palette = (code: number) => rgbFromHex(catalog.color(code).hex)

/** Presets rendered at publish time. The animations are opt-in: they are slow. */
const PUBLISHED_CARDS: CardPresetId[] = [...CARD_PRESET_IDS]

export function ShareStudio({
  document,
  geometry,
  validation = null,
  author = null,
  onPublish,
  onDownload,
  origin = typeof window === 'undefined' ? '' : window.location.origin,
}: ShareStudioProps) {
  const { settings, presetId, modified, dispatch } = useStudioSettings()
  const [crop, setCrop] = useState<CardPresetId>('opengraph')
  const [title, setTitle] = useState(document.name)
  const [description, setDescription] = useState('')
  const [tagText, setTagText] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('unlisted')
  const [capabilities, setCapabilities] = useState<ShareCapabilities>({
    view: true,
    comment: false,
    fork: true,
    download: false,
    embed: false,
  })
  const [phase, setPhase] = useState<PublishPhase>({ kind: 'idle' })
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const published = useMemo(() => serializePublishedDocument(document), [document])
  const input = useMemo<CardRenderInput>(
    () => ({ document: published, geometry, palette, settings, attribution: author?.displayName ?? null }),
    [published, geometry, settings, author],
  )

  const geometryReady = useMemo(
    () => published.parts.some((part) => geometry(part.definitionId) !== null),
    [published, geometry],
  )

  const aspect = CARD_GEOMETRY[crop].height / CARD_GEOMETRY[crop].width
  const previewHeight = Math.round(PREVIEW_WIDTH * aspect)

  // -- live preview ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !geometryReady) return
    const context = canvas.getContext('2d')
    if (!context) return
    const forced = CARD_GEOMETRY[crop].forceTransparent
      ? { ...input, settings: { ...settings, background: { kind: 'transparent' as const } } }
      : input
    const frame = renderFrame(forced, PREVIEW_WIDTH, previewHeight)
    context.clearRect(0, 0, PREVIEW_WIDTH, previewHeight)
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.image.rgba), PREVIEW_WIDTH, previewHeight), 0, 0)
  }, [input, settings, crop, previewHeight, geometryReady])

  const download = useCallback(
    (filename: string, bytes: Uint8Array) => {
      if (onDownload) {
        onDownload(filename, bytes)
        return
      }
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/png' })
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    },
    [onDownload],
  )

  const downloadCrop = useCallback(() => {
    const rendered = renderCard(input, crop)
    download(`${sanitizeFilename(title || document.name, 'model')}-${crop}.png`, rendered.bytes)
  }, [input, crop, download, title, document.name])

  const publish = useCallback(async () => {
    try {
      const cards: PublicationCard[] = []
      const bytes: Record<string, Uint8Array> = {}
      for (const [index, preset] of PUBLISHED_CARDS.entries()) {
        setPhase({ kind: 'rendering', preset, done: index, total: PUBLISHED_CARDS.length })
        // Yield to the event loop so the progress line actually paints between
        // crops; each render is hundreds of milliseconds of synchronous work.
        await new Promise((resolve) => setTimeout(resolve, 0))
        const rendered = renderCard(input, preset)
        cards.push({
          preset,
          width: rendered.width,
          height: rendered.height,
          contentType: 'image/png',
          sha256: await sha256Hex(rendered.bytes),
          byteLength: rendered.bytes.byteLength,
          frames: 1,
          alt: `${title || document.name} rendered at revision ${document.revision}`,
        })
        bytes[preset] = rendered.bytes
      }

      setPhase({ kind: 'publishing' })
      const publication = await createPublication({
        document,
        validation,
        visibility,
        capabilities,
        title,
        description,
        tags: tagText.split(/[,\s]+/).filter(Boolean),
        author,
        cards,
      })
      const result = await onPublish(publication, bytes)
      setPhase({
        kind: 'published',
        slug: result.slug,
        revision: publication.revision,
        contentHash: publication.contentHash,
        visibility: publication.visibility,
        token: result.token,
        shareUrl: result.shareUrl,
      })
    } catch (cause) {
      setPhase({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [input, document, validation, visibility, capabilities, title, description, tagText, author, onPublish])

  const busy = phase.kind === 'rendering' || phase.kind === 'publishing'

  return (
    <section className="bw-studio" aria-label="Share Studio" data-testid="share-studio">
      <div className="bw-studio-preview">
        <div className="bw-studio-crops" role="tablist" aria-label="Card crop">
          {CARD_PRESET_IDS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="tab"
              aria-selected={crop === preset}
              className={crop === preset ? 'is-active' : ''}
              onClick={() => setCrop(preset)}
              data-testid={`crop-${preset}`}
            >
              {CARD_GEOMETRY[preset].label}
            </button>
          ))}
        </div>

        <div
          className="bw-studio-canvas-frame"
          data-transparent={CARD_GEOMETRY[crop].forceTransparent ? '' : undefined}
        >
          {geometryReady ? (
            <canvas
              ref={canvasRef}
              width={PREVIEW_WIDTH}
              height={previewHeight}
              className="bw-studio-canvas"
              data-testid="studio-preview"
              role="img"
              aria-label={`${CARD_GEOMETRY[crop].label} preview of ${title || document.name}`}
            />
          ) : (
            <p className="bw-studio-empty" data-testid="studio-no-geometry">
              No compiled geometry is resident for this model yet, so there is nothing to preview. The catalog pack
              loads on demand — open the model in the editor once and come back.
            </p>
          )}
        </div>

        <p className="bw-studio-caption">
          {CARD_GEOMETRY[crop].width} × {CARD_GEOMETRY[crop].height} · {CARD_GEOMETRY[crop].purpose}
        </p>

        <div className="bw-studio-preview-actions">
          <button type="button" onClick={downloadCrop} disabled={!geometryReady} data-testid="download-crop">
            Download this crop
          </button>
        </div>
      </div>

      <div className="bw-studio-controls">
        <fieldset>
          <legend>Preset</legend>
          <div className="bw-studio-presets">
            {STUDIO_PRESET_IDS.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={presetId === id && !modified}
                className={presetId === id ? 'is-active' : ''}
                onClick={() => dispatch({ type: 'preset', id: id as StudioPresetId })}
                data-testid={`preset-${id}`}
              >
                {id}
              </button>
            ))}
          </div>
          <p className="bw-studio-hint">
            {presetId}
            {modified ? ' · modified' : ' · unmodified'}. Presets are deterministic: the same revision and preset always
            produce the same bytes.
          </p>
        </fieldset>

        <fieldset>
          <legend>Camera</legend>
          <Slider
            id="yaw"
            label="Turntable"
            min={0}
            max={359}
            step={1}
            value={settings.camera.yaw}
            suffix="°"
            onChange={(yaw) => dispatch({ type: 'camera', yaw })}
          />
          <Slider
            id="pitch"
            label="Elevation"
            min={-85}
            max={85}
            step={1}
            value={settings.camera.pitch}
            suffix="°"
            onChange={(pitch) => dispatch({ type: 'camera', pitch })}
          />
          <Slider
            id="roll"
            label="Roll"
            min={0}
            max={359}
            step={1}
            value={settings.camera.roll}
            suffix="°"
            onChange={(roll) => dispatch({ type: 'camera', roll })}
          />
        </fieldset>

        <fieldset>
          <legend>Framing</legend>
          <Slider
            id="zoom"
            label="Zoom"
            min={0.25}
            max={4}
            step={0.05}
            value={settings.framing.zoom}
            onChange={(zoom) => dispatch({ type: 'framing', zoom })}
          />
          <Slider
            id="padding"
            label="Padding"
            min={0}
            max={0.4}
            step={0.01}
            value={settings.framing.padding}
            onChange={(padding) => dispatch({ type: 'framing', padding })}
          />
          <Slider
            id="offsetX"
            label="Pan X"
            min={-0.5}
            max={0.5}
            step={0.01}
            value={settings.framing.offsetX}
            onChange={(offsetX) => dispatch({ type: 'framing', offsetX })}
          />
          <Slider
            id="offsetY"
            label="Pan Y"
            min={-0.5}
            max={0.5}
            step={0.01}
            value={settings.framing.offsetY}
            onChange={(offsetY) => dispatch({ type: 'framing', offsetY })}
          />
        </fieldset>

        <fieldset>
          <legend>Background</legend>
          <div className="bw-studio-row">
            {(['transparent', 'solid', 'gradient', 'grid'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={settings.background.kind === kind}
                className={settings.background.kind === kind ? 'is-active' : ''}
                data-testid={`background-${kind}`}
                onClick={() =>
                  dispatch({
                    type: 'background',
                    background:
                      kind === 'transparent'
                        ? { kind: 'transparent' }
                        : kind === 'solid'
                          ? { kind: 'solid', color: '#0f1517' }
                          : kind === 'gradient'
                            ? { kind: 'gradient', from: '#12191c', to: '#090d0e', angle: 145 }
                            : { kind: 'grid', color: '#0b1a22', line: '#12313c', spacing: 48 },
                  })
                }
              >
                {kind}
              </button>
            ))}
          </div>
          {settings.background.kind === 'solid' ? (
            <label className="bw-studio-colour">
              Colour
              <input
                type="color"
                value={settings.background.color}
                onChange={(event) =>
                  dispatch({ type: 'background', background: { kind: 'solid', color: event.target.value } })
                }
              />
            </label>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>Tone</legend>
          <p className="bw-studio-hint">
            The rasteriser&rsquo;s key light is fixed in the model&rsquo;s own space — orbiting moves the model under
            it, like a turntable in a lit studio. These are tone controls on the rendered image, not a relight, and they
            are named for what they do.
          </p>
          <Slider
            id="exposure"
            label="Exposure"
            min={0.2}
            max={3}
            step={0.02}
            value={settings.tone.exposure}
            onChange={(exposure) => dispatch({ type: 'tone', exposure })}
          />
          <Slider
            id="contrast"
            label="Contrast"
            min={0.2}
            max={3}
            step={0.02}
            value={settings.tone.contrast}
            onChange={(contrast) => dispatch({ type: 'tone', contrast })}
          />
          <Slider
            id="shadowLift"
            label="Shadow lift"
            min={0}
            max={0.6}
            step={0.01}
            value={settings.tone.shadowLift}
            onChange={(shadowLift) => dispatch({ type: 'tone', shadowLift })}
          />
        </fieldset>

        <fieldset>
          <legend>Mark</legend>
          <label className="bw-studio-check">
            <input
              type="checkbox"
              checked={settings.watermark !== null}
              data-testid="watermark-toggle"
              onChange={(event) => dispatch({ type: 'watermark', enabled: event.target.checked })}
            />
            Draw a wordmark and attribution
          </label>
          {settings.watermark ? (
            <>
              <label className="bw-studio-text">
                Wordmark
                <input
                  type="text"
                  value={settings.watermark.text}
                  maxLength={48}
                  data-testid="watermark-text"
                  onChange={(event) => dispatch({ type: 'watermark', text: event.target.value })}
                />
              </label>
              <Slider
                id="markOpacity"
                label="Opacity"
                min={0}
                max={1}
                step={0.05}
                value={settings.watermark.opacity}
                onChange={(opacity) => dispatch({ type: 'watermark', opacity })}
              />
              <Slider
                id="markScale"
                label="Size"
                min={1}
                max={12}
                step={1}
                value={settings.watermark.scale}
                onChange={(scale) => dispatch({ type: 'watermark', scale })}
              />
              <p className="bw-studio-hint">
                {author
                  ? `Attribution reads “${author.displayName}”.`
                  : 'No account attribution is available, so only the wordmark is drawn. Nothing is invented.'}
              </p>
            </>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>Publication</legend>
          <label className="bw-studio-text">
            Title
            <input
              type="text"
              value={title}
              maxLength={120}
              data-testid="publish-title"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="bw-studio-text">
            Description
            <textarea
              value={description}
              maxLength={600}
              rows={3}
              data-testid="publish-description"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="bw-studio-text">
            Tags
            <input
              type="text"
              value={tagText}
              placeholder="rover technic"
              data-testid="publish-tags"
              onChange={(event) => setTagText(event.target.value)}
            />
          </label>

          <div className="bw-studio-row" role="radiogroup" aria-label="Visibility">
            {(['private', 'unlisted', 'public'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={visibility === option}
                className={visibility === option ? 'is-active' : ''}
                data-testid={`visibility-${option}`}
                onClick={() => setVisibility(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <p className="bw-studio-hint">
            {visibility === 'private'
              ? 'Only you can open it. The address returns the same "not found" a nonexistent one does.'
              : visibility === 'unlisted'
                ? 'Reachable only through a link carrying a 256-bit token. Not indexed, not listed in the gallery, and revocable.'
                : 'Anyone can open it, and it appears in the public gallery.'}
          </p>

          <fieldset className="bw-studio-caps">
            <legend>Capabilities</legend>
            {CAPABILITY_KEYS.map((key) => (
              <label key={key} className="bw-studio-check">
                <input
                  type="checkbox"
                  checked={capabilities[key]}
                  data-testid={`capability-${key}`}
                  onChange={(event) => setCapabilities((current) => ({ ...current, [key]: event.target.checked }))}
                />
                {key}
              </label>
            ))}
          </fieldset>
        </fieldset>

        <div className="bw-studio-publish">
          <p className="bw-studio-commit">
            Publishing captures <strong>revision {document.revision}</strong> exactly as it is now. Later edits will not
            change what this link shows — publish again to share a newer revision.
          </p>
          <button
            type="button"
            className="bw-studio-publish-button"
            onClick={() => void publish()}
            disabled={busy || !geometryReady}
            data-testid="publish-button"
          >
            {busy ? 'Working…' : `Publish revision ${document.revision}`}
          </button>

          <p className="bw-studio-status" role="status" aria-live="polite" data-testid="publish-status">
            {phase.kind === 'rendering'
              ? `Rendering ${phase.preset} (${phase.done + 1} of ${phase.total})…`
              : phase.kind === 'publishing'
                ? 'Uploading the snapshot and its cards…'
                : phase.kind === 'published'
                  ? publishedStatus(origin, phase)
                  : ''}
          </p>
          {phase.kind === 'error' ? (
            <p className="bw-studio-error" role="alert" data-testid="publish-error">
              Publishing failed: {phase.message}
            </p>
          ) : null}
          {phase.kind === 'published' ? <PublishedLink origin={origin} phase={phase} /> : null}
        </div>
      </div>
    </section>
  )
}

function publishedHref(origin: string, phase: Extract<PublishPhase, { kind: 'published' }>): string | null {
  if (phase.shareUrl) return phase.shareUrl
  if (phase.visibility === 'public') return `${origin}/share/${phase.slug}`
  if (phase.visibility === 'unlisted' && phase.token) {
    return `${origin}/share/${phase.slug}?t=${encodeURIComponent(phase.token)}`
  }
  return null
}

function publishedStatus(origin: string, phase: Extract<PublishPhase, { kind: 'published' }>): string {
  const href = publishedHref(origin, phase)
  const hash = `revision ${phase.revision}, content hash ${phase.contentHash.slice(0, 12)}…`
  if (href) return `Published at ${href} — ${hash}`
  if (phase.visibility === 'private') {
    return `Published privately — ${hash} The address /share/${phase.slug} returns the same "not found" a stranger sees.`
  }
  return `Published as unlisted — ${hash} /share/${phase.slug} is not a working link without the access token, which this session did not receive.`
}

function PublishedLink({ origin, phase }: { origin: string; phase: Extract<PublishPhase, { kind: 'published' }> }) {
  const href = publishedHref(origin, phase)
  if (!href) {
    return (
      <p className="bw-studio-published" data-testid="published-link-unavailable">
        No working share URL was returned. Mint a token for this publication before sending the address to anyone.
      </p>
    )
  }
  return (
    <p className="bw-studio-published">
      <a href={href} data-testid="published-link">
        Open the share page
      </a>
    </p>
  )
}

function Slider({
  id,
  label,
  min,
  max,
  step,
  value,
  suffix = '',
  onChange,
}: {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <label className="bw-studio-slider" htmlFor={`bw-studio-${id}`}>
      <span>
        {label}
        <em>
          {Number.isInteger(value) ? value : value.toFixed(2)}
          {suffix}
        </em>
      </span>
      <input
        id={`bw-studio-${id}`}
        data-testid={`slider-${id}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}
