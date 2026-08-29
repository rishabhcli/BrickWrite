import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { buildBom } from '../../../cad/bom'
import { documentFromPublished, forkPublication } from '../fork'
import type { ForkProvenance, Publication, ShareCapabilities } from '../types'
import type { GeometryResolver } from '../render/scene'
import { ModelCanvas } from './ModelCanvas'
import { ShareBar } from './ShareBar'
import { describeStep, INITIAL_VIEWER_STATE, viewerReducer } from './state'

/**
 * The read-only viewer.
 *
 * Everything it can do is a way of *looking*: orbit, zoom, explode, scrub the
 * build sequence, read the parts list, check the validation badge. There is no
 * path from here to the canonical project, and that is structural rather than
 * enforced by a flag:
 *
 *   - it holds a frozen `Publication`, produced by the allowlist serialiser;
 *   - it never imports `cadEngine`, `session` or `ProjectRepository`, so there
 *     is no command bus and no repository handle in scope;
 *   - `documentFromPublished` builds a *new* document object on every call, so
 *     even the fork path cannot alias the snapshot.
 *
 * "Edit a copy" therefore does not unlock anything. It constructs a new project
 * from the published bytes, hands it and its provenance to the host, and leaves
 * the publication exactly as it found it.
 */

export interface SharedViewerProps {
  publication: Publication
  capabilities: ShareCapabilities
  geometry: GeometryResolver
  /**
   * Receives the new document and its provenance. The host owns persistence —
   * this component deliberately cannot write anywhere itself.
   */
  onFork?: (result: { document: ReturnType<typeof documentFromPublished>; provenance: ForkProvenance }) => void
  /** Absolute URL of this publication, for the share and embed affordances. */
  shareUrl: string
  embedUrl?: string
  /** Definition ids this build could not draw, reported by the loader. */
  unavailableDefinitionIds?: readonly string[]
  canvasWidth?: number
  canvasHeight?: number
}

export function SharedViewer({
  publication,
  capabilities,
  geometry,
  onFork,
  shareUrl,
  embedUrl,
  unavailableDefinitionIds = [],
  canvasWidth = 720,
  canvasHeight = 460,
}: SharedViewerProps) {
  const [state, dispatch] = useReducer(viewerReducer, INITIAL_VIEWER_STATE)
  const [forkState, setForkState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [forkError, setForkError] = useState<string | null>(null)

  const steps = publication.document.steps
  const bom = useMemo(() => publication.summary.bom, [publication.summary.bom])

  // Arrow keys scrub the sequence from anywhere on the page that is not itself
  // a text field, so the scrubber is usable without hunting for its handle.
  useEffect(() => {
    if (!steps.length) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (target?.classList.contains('bw-share-canvas')) return
      if (event.key === '[') dispatch({ type: 'step-delta', delta: -1, stepCount: steps.length })
      else if (event.key === ']') dispatch({ type: 'step-delta', delta: 1, stepCount: steps.length })
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steps.length])

  const handleFork = useCallback(() => {
    if (!onFork) return
    setForkState('working')
    setForkError(null)
    try {
      onFork(forkPublication(publication))
      setForkState('done')
    } catch (cause) {
      setForkState('error')
      setForkError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [onFork, publication])

  const validation = publication.summary.validation
  const stepLabel = describeStep(publication.document, state.step)

  return (
    <div className="bw-share-viewer" data-testid="shared-viewer" data-slug={publication.slug}>
      <div className="bw-share-stage">
        <ModelCanvas
          document={publication.document}
          geometry={geometry}
          state={state}
          dispatch={dispatch}
          width={canvasWidth}
          height={canvasHeight}
          label={`${publication.title} — ${stepLabel}`}
        />

        <div className="bw-share-controls">
          <div className="bw-share-control">
            <label htmlFor="bw-explode">
              Exploded view<span>{Math.round(state.explode * 100)}%</span>
            </label>
            <input
              id="bw-explode"
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={state.explode}
              data-testid="explode-slider"
              onChange={(event) => dispatch({ type: 'explode', value: Number(event.target.value) })}
            />
          </div>
          <button type="button" className="bw-share-reset" onClick={() => dispatch({ type: 'reset' })}>
            Reset view
          </button>
        </div>

        {steps.length > 0 ? (
          <section className="bw-share-scrubber" aria-label="Build sequence">
            <header>
              <h3>Build sequence</h3>
              <p aria-live="polite" data-testid="step-label">
                {stepLabel}
              </p>
            </header>
            <div className="bw-share-scrub-row">
              <button
                type="button"
                onClick={() => dispatch({ type: 'step-delta', delta: -1, stepCount: steps.length })}
                aria-label="Previous step"
                data-testid="step-back"
              >
                ‹
              </button>
              <input
                type="range"
                min={0}
                max={steps.length}
                step={1}
                value={state.step ?? steps.length}
                aria-label="Build step"
                data-testid="step-slider"
                onChange={(event) => {
                  const value = Number(event.target.value)
                  dispatch({ type: 'step', value: value === 0 ? null : value })
                }}
              />
              <button
                type="button"
                onClick={() => dispatch({ type: 'step-delta', delta: 1, stepCount: steps.length })}
                aria-label="Next step"
                data-testid="step-forward"
              >
                ›
              </button>
              <button
                type="button"
                className={state.step === null ? 'is-active' : ''}
                onClick={() => dispatch({ type: 'step', value: null })}
                data-testid="step-all"
              >
                Finished
              </button>
            </div>
            <details className="bw-share-step-disclosure">
              <summary>
                All build steps <span>{steps.length}</span>
              </summary>
              <ol className="bw-share-step-list">
                {steps.map((step) => (
                  <li key={step.id}>
                    <button
                      type="button"
                      aria-pressed={state.step === step.index}
                      onClick={() => dispatch({ type: 'step', value: step.index })}
                      data-testid={`step-${step.index}`}
                    >
                      <span className="bw-share-step-index">{step.index}</span>
                      <span className="bw-share-step-name">{step.name}</span>
                      <span className="bw-share-step-count">{step.partIds.length}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          </section>
        ) : (
          <p className="bw-share-empty">This model has no sequenced build steps, so there is nothing to scrub.</p>
        )}
      </div>

      <aside className="bw-share-aside">
        <h1 className="bw-share-title">{publication.title}</h1>
        <p className="bw-share-byline">
          {publication.author ? (
            <span data-testid="viewer-author">{publication.author.displayName}</span>
          ) : (
            <span className="bw-share-absent">Author not stated</span>
          )}
          {' · '}
          <span>revision {publication.revision}</span>
        </p>
        {publication.description ? <p className="bw-share-description">{publication.description}</p> : null}

        {publication.fork ? (
          <p className="bw-share-provenance" data-testid="fork-provenance">
            Forked from “{publication.fork.sourceTitle}” at revision {publication.fork.sourceRevision}.
          </p>
        ) : null}

        <p className="bw-share-validation">
          {validation.componentCount === 0 ? (
            <span className="bw-badge bw-badge-unknown">Not validated</span>
          ) : validation.healthy ? (
            <span className="bw-badge bw-badge-pass" data-testid="validation-badge">
              Validated · {validation.connectionCount} connections · no collisions
            </span>
          ) : (
            <span className="bw-badge bw-badge-warn" data-testid="validation-badge">
              {validation.collisionCount} collision{validation.collisionCount === 1 ? '' : 's'} ·{' '}
              {validation.componentCount} group{validation.componentCount === 1 ? '' : 's'}
            </span>
          )}
        </p>

        <dl className="bw-share-stats">
          <div>
            <dt>Parts</dt>
            <dd data-testid="part-count">{publication.summary.partCount}</dd>
          </div>
          <div>
            <dt>Unique</dt>
            <dd>{publication.summary.uniquePartCount}</dd>
          </div>
          <div>
            <dt>Steps</dt>
            <dd>{publication.summary.stepCount}</dd>
          </div>
          <div>
            <dt>Envelope</dt>
            <dd>
              {publication.summary.envelopeStuds[0]} × {publication.summary.envelopeStuds[2]} studs
            </dd>
          </div>
        </dl>

        {unavailableDefinitionIds.length > 0 ? (
          <p className="bw-share-warning" data-testid="missing-geometry">
            {unavailableDefinitionIds.length} part{unavailableDefinitionIds.length === 1 ? '' : 's'} could not be drawn:
            this build carries no compiled geometry for {unavailableDefinitionIds.slice(0, 4).join(', ')}
            {unavailableDefinitionIds.length > 4 ? ` and ${unavailableDefinitionIds.length - 4} more` : ''}. They are
            still listed below.
          </p>
        ) : null}

        <div className="bw-share-actions">
          {capabilities.fork ? (
            <button
              type="button"
              className="bw-share-action bw-share-action-primary"
              onClick={handleFork}
              disabled={forkState === 'working' || !onFork}
              data-testid="fork-button"
            >
              {forkState === 'done' ? 'Copy created' : forkState === 'working' ? 'Copying…' : 'Edit a copy'}
            </button>
          ) : (
            <span className="bw-share-note">The author has not enabled forking for this model.</span>
          )}
        </div>
        {forkState === 'error' ? (
          <p className="bw-share-error" role="alert">
            The copy could not be created: {forkError}
          </p>
        ) : null}

        <ShareBar url={shareUrl} title={publication.title} embedUrl={capabilities.embed ? embedUrl : undefined} />

        <details className="bw-share-bom bw-share-disclosure">
          <summary>
            Parts list <span>{bom.length} lines</span>
          </summary>
          <div>
            {bom.length === 0 ? (
              <p className="bw-share-empty">This publication contains no parts.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Qty</th>
                    <th scope="col">Part</th>
                    <th scope="col">Colour</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.map((line) => (
                    <tr key={`${line.definitionId}:${line.colorCode}`}>
                      <td className="bw-share-qty">{line.quantity}</td>
                      <td>
                        <span className="bw-share-swatch" style={{ background: line.colorHex }} />
                        {line.name}
                      </td>
                      <td>{line.colorName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>

        <p className="bw-share-license">
          Shared under {publication.license}. Brick geometry from the LDraw library, CC BY 4.0.
        </p>
      </aside>
    </div>
  )
}

/**
 * Recomputes the parts list from the snapshot.
 *
 * Exported for the host that wants to show a BOM for a *forked* document rather
 * than the published summary — the summary is fixed at publication, and a fork
 * diverges from it the moment it is edited.
 */
export function bomForPublication(publication: Publication) {
  return buildBom(
    documentFromPublished(publication.document, {
      id: 'preview',
      name: publication.title,
      timestamp: publication.publishedAt,
    }),
  )
}
