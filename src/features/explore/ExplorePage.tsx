import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEMOS, getDemo, loadPreview, type DemoCategory, type DemoEntry, type DemoPreview } from '../../demos'
import { setKnownDemoIds, trackLanding } from '../landing/analytics'
import { hrefFor, navigate, useLandingRoute } from '../landing/navigation'
import { PlateAtmosphere, StageHud } from '../landing/plate'
import { usePointerField } from '../landing/reveal'
import { forkDemo, type ForkOutcome } from '../../demos/fork'
import { PART_FIELDS, layerCount } from './projection'
import './explore.css'

const EnvelopeView = lazy(() => import('./EnvelopeView'))

/**
 * The demo explorer.
 *
 * One published `ModelDocument` at a time, drawn from its envelope preview, with
 * everything the kernel recorded about it beside it: the validation report, the
 * statics report, the derived build sequence, the bill of materials, and the
 * earlier candidate it replaced. The canonical demo is never mutated — every
 * control here changes what is *drawn*, and "Edit this build" copies the
 * snapshot into a project the visitor owns.
 */

setKnownDemoIds(DEMOS.map((demo) => demo.id))

type ViewMode = 'solid' | 'exploded' | 'before-after'

export function ExplorePage() {
  const route = useLandingRoute()
  return route.demoId ? <DemoExplorer route={route} /> : <ExploreCatalog />
}

function DemoExplorer({ route }: { route: ReturnType<typeof useLandingRoute> }) {
  const demo = (route.demoId ? getDemo(route.demoId) : undefined) ?? DEMOS[0]
  const unknownId = route.demoId !== null && !getDemo(route.demoId)
  const pointer = usePointerField<HTMLDivElement>()

  const [preview, setPreview] = useState<DemoPreview | null>(null)
  const [roughPreview, setRoughPreview] = useState<DemoPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [camera, setCamera] = useState(demo.camera)
  const [view, setView] = useState<ViewMode>('solid')
  const [explode, setExplode] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [fork, setFork] = useState<{ pending: boolean; outcome: ForkOutcome | null }>({ pending: false, outcome: null })
  const forkStarted = useRef(0)

  const totalSteps = demo.validation.steps
  const step = route.step === null ? totalSteps : Math.max(1, Math.min(totalSteps, route.step))

  useEffect(() => {
    setCamera(demo.camera)
    setSelected(null)
    setExplode(0)
    setView('solid')
    setFork({ pending: false, outcome: null })
    trackLanding({ name: 'demo.viewed', demoId: demo.id, surface: 'explore' })
  }, [demo])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setPreview(null)
    setRoughPreview(null)
    setError(null)
    loadPreview(demo, 'published', controller.signal)
      .then((loaded) => {
        if (!cancelled) setPreview(loaded)
      })
      .catch((cause: unknown) => {
        if (!cancelled && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [demo])

  // The earlier candidate is a second fetch, taken only when somebody asks to
  // compare — most visits never do.
  useEffect(() => {
    if (view !== 'before-after' || roughPreview) return
    const controller = new AbortController()
    loadPreview(demo, 'rough', controller.signal)
      .then(setRoughPreview)
      .catch(() => undefined)
    return () => controller.abort()
  }, [view, roughPreview, demo])

  const setStep = useCallback(
    (next: number) => {
      navigate({ kind: 'explore', demoId: demo.id, step: next }, { replace: true })
      trackLanding({ name: 'demo.step_scrubbed', demoId: demo.id, step: next })
    },
    [demo.id],
  )

  const changeView = useCallback(
    (next: ViewMode) => {
      setView(next)
      setExplode(next === 'exploded' ? 1 : 0)
      trackLanding({ name: 'demo.view_changed', demoId: demo.id, view: next })
    },
    [demo.id],
  )

  const startFork = useCallback(async () => {
    const destinationBefore = fork.pending
    if (destinationBefore) return
    forkStarted.current = Date.now()
    const destination = typeof window !== 'undefined' && window.brickwrightCloudProjects ? 'cloud' : 'local'
    trackLanding({ name: 'demo.fork_started', demoId: demo.id, destination })
    setFork({ pending: true, outcome: null })
    const outcome = await forkDemo(demo)
    setFork({ pending: false, outcome })
    if (outcome.ok) {
      trackLanding({
        name: 'demo.fork_completed',
        demoId: demo.id,
        destination: outcome.destination,
        elapsedMs: Date.now() - forkStarted.current,
      })
      // Straight into the editor. The copy is the point of the click, and
      // stopping to render a second button that only says "now open it" made
      // editing a demo a four-click errand from the landing page.
      trackLanding({ name: 'editor.opened', from: 'explore', withProject: true })
      navigate({ kind: 'editor-project', projectId: outcome.projectId })
    } else {
      trackLanding({ name: 'demo.fork_failed', demoId: demo.id, destination: outcome.destination })
    }
  }, [demo, fork.pending])

  const activePreview = view === 'before-after' ? (roughPreview ?? preview) : preview
  const selectedPart = activePreview && selected !== null ? activePreview.parts[selected] : null
  const stepIndexLimit = view === 'before-after' ? undefined : step

  // Layer scrubbing, the way a slicer previews a print: everything at or below
  // the layer is drawn and everything above it is left out. It reads the model
  // on the grain it was built on, which for these sets means the seam between
  // one storey and the next is a real place to stop.
  const totalLayers = useMemo(() => (activePreview ? layerCount(activePreview) : 1), [activePreview])
  const [layer, setLayer] = useState<number | null>(null)
  const layerLimit = layer === null ? undefined : layer
  useEffect(() => {
    setLayer(null)
  }, [demo.id])

  // Walking the layers upward is the clearest thing this viewer can do with a
  // model built in separable storeys: it puts the set together in front of you
  // instead of asking you to drag a slider to understand it. Reduced-motion
  // callers get the finished model rather than a shortened animation.
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      setLayer(null)
      setPlaying(false)
      return
    }
    let frame = 0
    const started = performance.now()
    const durationMs = 5200
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / durationMs)
      // Ease out, so the last storeys settle rather than snapping into place.
      const eased = 1 - (1 - progress) * (1 - progress)
      const next = Math.max(1, Math.round(eased * totalLayers))
      setLayer(next >= totalLayers ? null : next)
      if (progress < 1) frame = requestAnimationFrame(tick)
      else setPlaying(false)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, totalLayers])

  const stepName = useMemo(() => {
    const entry = preview?.steps.find((candidate) => candidate.index === step)
    return entry ? entry.name : `Step ${step}`
  }, [preview, step])

  const report = view === 'before-after' ? demo.roughValidation : demo.validation

  return (
    <div ref={pointer.ref} className="bw-surface bw-explore" data-pointer={pointer.live ? 'live' : 'off'}>
      <PlateAtmosphere />
      <div className="bw-studs" aria-hidden="true" />
      <a className="bw-button small bw-skip" href="#bw-explore-main">
        Skip to the model
      </a>
      <header className="bw-explore-bar">
        <a className="bw-button ghost small" href={hrefFor({ kind: 'explore' })} onClick={anchor({ kind: 'explore' })}>
          ← All builds
        </a>
        <div className="bw-explore-title">
          <h1>{demo.title}</h1>
          <span>{demo.discipline}</span>
        </div>
        <span className="spacer" />
        <div className="bw-demo-switch">
          {DEMOS.map((entry) => (
            <a
              key={entry.id}
              className="bw-chip"
              aria-current={entry.id === demo.id ? 'true' : undefined}
              data-active={entry.id === demo.id ? 'true' : 'false'}
              href={hrefFor({ kind: 'explore', demoId: entry.id })}
              onClick={anchor({ kind: 'explore', demoId: entry.id })}
            >
              {entry.title}
            </a>
          ))}
        </div>
      </header>

      {unknownId ? (
        <p className="bw-fork-note error" role="status" style={{ margin: '12px var(--bw-gutter)' }}>
          There is no published demo called “{route.demoId}”. Showing {demo.title} instead.
        </p>
      ) : null}

      <div className="bw-explore-body" id="bw-explore-main">
        <section className="bw-explore-view" aria-label={`${demo.title} model view`}>
          <div className="bw-stage bw-corners">
            <i />
            <i />
            <i />
            <i />
            <StageHud
              yaw={camera.yaw}
              pitch={camera.pitch}
              zoom={camera.zoom}
              explode={view === 'exploded' ? explode : 0}
              parts={report.partCount}
              mates={report.connectionCount}
              bodies={report.componentCount}
            />
            {activePreview ? (
              <Suspense fallback={null}>
                <EnvelopeView
                  preview={activePreview}
                  camera={camera}
                  onCameraChange={setCamera}
                  stepLimit={stepIndexLimit}
                  layerLimit={layerLimit}
                  highlightStep={view === 'solid' && step < totalSteps ? step - 1 : undefined}
                  explode={explode}
                  selectedIndex={selected}
                  onSelectIndex={(index) => {
                    setSelected(index)
                    if (index !== null) trackLanding({ name: 'demo.part_inspected', demoId: demo.id })
                  }}
                  label={
                    `${demo.title}: ${activePreview.parts.length} parts drawn as measured LDraw envelopes. ` +
                    `Showing ${view === 'before-after' ? 'the first candidate' : `build step ${step} of ${totalSteps}`}.`
                  }
                />
              </Suspense>
            ) : null}
            {error ? (
              <p className="bw-fork-note error" role="alert" style={{ position: 'absolute', inset: 'auto 16px 16px' }}>
                {error}
              </p>
            ) : null}
          </div>

          <div className="bw-explore-controls">
            <div className="bw-control-row">
              <div className="bw-chips" role="group" aria-label="View">
                {(['solid', 'exploded', 'before-after'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className="bw-chip"
                    aria-pressed={view === mode}
                    onClick={() => changeView(mode)}
                  >
                    {mode === 'solid' ? 'Model' : mode === 'exploded' ? 'Exploded' : 'First candidate'}
                  </button>
                ))}
              </div>
              <span className="spacer" style={{ flex: 1 }} />
              <button
                type="button"
                className="bw-chip"
                aria-pressed={playing}
                onClick={() => {
                  setLayer(playing ? null : 1)
                  setPlaying((value) => !value)
                }}
              >
                {playing ? 'Stop' : 'Build it'}
              </button>
              <button type="button" className="bw-chip" onClick={() => setCamera(demo.camera)}>
                Reset view
              </button>
            </div>

            <div className="bw-control-row">
              <label htmlFor="bw-step">
                Build step
                <input
                  id="bw-step"
                  type="range"
                  min={1}
                  max={totalSteps}
                  value={step}
                  disabled={view === 'before-after'}
                  onChange={(event) => setStep(Number(event.target.value))}
                />
                <span className="bw-control-value">
                  {step} / {totalSteps}
                </span>
              </label>
              <label htmlFor="bw-layer">
                Layer
                <input
                  id="bw-layer"
                  type="range"
                  min={1}
                  max={totalLayers}
                  value={layer ?? totalLayers}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setPlaying(false)
                    setLayer(next >= totalLayers ? null : next)
                  }}
                />
                <span className="bw-control-value">
                  {layer === null ? `all ${totalLayers}` : `${layer} / ${totalLayers}`}
                </span>
              </label>
              <label htmlFor="bw-explode">
                Exploded
                <input
                  id="bw-explode"
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(explode * 100)}
                  onChange={(event) => setExplode(Number(event.target.value) / 100)}
                />
                <span className="bw-control-value">{Math.round(explode * 100)}%</span>
              </label>
            </div>

            <p className="bw-step-caption">
              {view === 'before-after' ? (
                <>
                  Showing the first candidate: <b>{demo.roughValidation.partCount}</b> parts in{' '}
                  <b>{demo.roughValidation.componentCount}</b> connected component
                  {demo.roughValidation.componentCount === 1 ? '' : 's'}.
                </>
              ) : (
                // The provenance of the sequence does not change per step, so
                // repeating it under every one of 185 steps is a sentence the
                // reader learns to skip. The step's own name is the caption.
                <b>{stepName}</b>
              )}
            </p>
          </div>
        </section>

        <aside className="bw-explore-inspector" aria-label="Model report">
          <div className="bw-inspector-section">
            <span className="bw-eyebrow accent">{demo.discipline}</span>
            <h2>{demo.title}</h2>
            <p>{demo.summary}</p>
            <div className="bw-chips">
              {demo.techniques.map((entry) => (
                <span className="bw-chip" key={entry}>
                  {entry}
                </span>
              ))}
            </div>
          </div>

          <div className="bw-inspector-section bw-fork">
            <span className="bw-eyebrow">Fork it</span>
            <button type="button" className="bw-button primary bw-magnet" onClick={startFork} disabled={fork.pending}>
              {fork.pending ? 'Opening…' : 'Edit this build'}{' '}
              <span className="bw-key" aria-hidden="true">
                →
              </span>
            </button>
            <p className="bw-note">Copies the snapshot into a project of your own and opens it. The demo is never modified.</p>
            {fork.outcome && !fork.outcome.ok ? <ForkResult outcome={fork.outcome} /> : null}
          </div>

          <details className="bw-explore-report">
            <summary>
              <span>Model report</span>
              <strong>
                {demo.validation.partCount} parts · {demo.validation.connectionCount} mates
              </strong>
            </summary>
            <div className="bw-explore-report-body">
              <div className="bw-inspector-section">
                <span className="bw-eyebrow">Validation · revision {demo.validation.revision}</span>
                <ul className="bw-facts">
                  <Fact k="Parts" v={demo.validation.partCount} />
                  <Fact k="Distinct elements" v={demo.distinctParts} />
                  <Fact k="Mated connectors" v={demo.validation.connectionCount} />
                  <Fact
                    k="Confirmed collisions"
                    v={demo.validation.collisionCount}
                    tone={demo.validation.collisionCount ? 'warn' : 'ok'}
                  />
                  <Fact
                    k="Unverified verdicts"
                    v={demo.validation.unverifiedCollisions}
                    tone={demo.validation.unverifiedCollisions ? 'warn' : 'ok'}
                  />
                  <Fact
                    k="Connected components"
                    v={demo.validation.componentCount}
                    tone={demo.validation.componentCount === 1 ? 'ok' : 'warn'}
                  />
                  <Fact
                    k="Build steps"
                    v={`${demo.validation.steps} · ${demo.validation.buildOrderVerified ? 'verified' : 'unverified'}`}
                    tone={demo.validation.buildOrderVerified ? 'ok' : 'warn'}
                  />
                  <Fact
                    k="Footprint"
                    v={`${demo.validation.footprintStuds[0]} × ${demo.validation.footprintStuds[1]} studs`}
                  />
                  <Fact k="Colours without set evidence" v={demo.validation.virtualColorCount} />
                </ul>
              </div>

              <div className="bw-inspector-section">
                <span className="bw-eyebrow">Statics</span>
                <ul className="bw-facts">
                  <Fact k="Mass" v={demo.validation.statics.massLabel} />
                  <Fact k="Support footprint" v={demo.validation.statics.supportLabel} />
                  <Fact
                    k="Tipping margin"
                    v={`${demo.validation.statics.tippingMarginLdu} LDU`}
                    tone={demo.validation.statics.stable ? 'ok' : 'warn'}
                  />
                  <Fact k="Mass coverage" v={`${Math.round(demo.validation.statics.coverage * 100)}%`} />
                  <Fact k="Carried in tension" v={demo.validation.statics.unsupportedParts} />
                  <Fact
                    k="Groups over clutch capacity"
                    v={demo.validation.statics.overloadedGroups}
                    tone={demo.validation.statics.overloadedGroups ? 'warn' : 'ok'}
                  />
                </ul>
                <details className="bw-method">
                  <summary>How these are measured</summary>
                  <p className="bw-note">{demo.validation.statics.massBasis}</p>
                  <p className="bw-note">
                    Clutch capacity is an assumption, not a measurement: {demo.validation.statics.clutchGramsPerStud} gf
                    per stud, the conservative end of independent measurements.
                  </p>
                  {demo.tensionReason ? <p className="bw-note">{demo.tensionReason}</p> : null}
                </details>
              </div>

              <div className="bw-inspector-section">
                <span className="bw-eyebrow">Refinement</span>
                <p>{demo.refinement}</p>
                <div className="bw-compare">
                  <span className="head">Measurement</span>
                  <span className="head">Candidate</span>
                  <span className="head">Published</span>
                  <CompareRow
                    label="Components"
                    before={demo.delta.componentsBefore}
                    after={demo.delta.componentsAfter}
                    lowerIsBetter
                  />
                  <CompareRow
                    label="Loose parts"
                    before={demo.delta.loosePartsBefore}
                    after={demo.delta.loosePartsAfter}
                    lowerIsBetter
                  />
                  <CompareRow label="Parts" before={demo.roughValidation.partCount} after={demo.validation.partCount} />
                  <CompareRow
                    label="Mates"
                    before={demo.roughValidation.connectionCount}
                    after={demo.validation.connectionCount}
                  />
                </div>
              </div>

              <div className="bw-inspector-section">
                <span className="bw-eyebrow">{selectedPart ? 'Selected part' : 'Parts in this model'}</span>
                {selectedPart && activePreview ? (
                  <SelectedPart preview={activePreview} index={selected!} onClear={() => setSelected(null)} />
                ) : null}
                <ul className="bw-part-list">
                  {demo.bill.map((line) => (
                    <li key={line.definitionId}>
                      <button
                        type="button"
                        className="bw-part-button"
                        aria-pressed={false}
                        onClick={() => {
                          if (!activePreview) return
                          const definition = activePreview.definitions.findIndex(
                            (entry) => entry.id === line.definitionId,
                          )
                          const index = activePreview.parts.findIndex(
                            (part) => part[PART_FIELDS.definition] === definition,
                          )
                          if (index >= 0) {
                            setSelected(index)
                            trackLanding({ name: 'demo.part_inspected', demoId: demo.id })
                          }
                        }}
                      >
                        <span className="bw-swatch" style={{ background: '#2b3538' }} aria-hidden="true" />
                        <strong>{line.name}</strong>
                        <code>
                          {line.definitionId} × {line.count}
                        </code>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bw-inspector-section">
                <span className="bw-eyebrow">Provenance</span>
                <ul className="bw-facts">
                  <Fact k="Catalog" v={demo.provenance.catalogVersion} />
                  <Fact k="Schema" v={`ModelDocument v${demo.schemaVersion}`} />
                  <Fact k="Authored" v={demo.provenance.authoredAt.slice(0, 10)} />
                  <Fact k="Snapshot" v={`${(demo.assets.document.bytes / 1024).toFixed(0)} KB`} />
                </ul>
                <p className="bw-note" style={{ marginTop: 10 }}>
                  Envelopes here, meshes in the editor. Built by <code>{demo.provenance.generator}</code>.
                </p>
              </div>
            </div>
          </details>
        </aside>
      </div>

      {/*
        The canvas is decorative; this is the model's text alternative. It is
        rendered from the manifest first and refined once the preview arrives,
        so a screen reader never waits on a fetch to be told what is here.
      */}
      <section className="bw-visually-hidden" aria-label="Build sequence, as text">
        <h2>Build sequence for {demo.title}</h2>
        <p>
          {demo.validation.partCount} parts, {demo.validation.connectionCount} mated connectors, {demo.validation.steps}{' '}
          verified build steps. Currently showing step {step}.
        </p>
        <ol>
          {(
            preview?.steps ??
            Array.from({ length: totalSteps }, (_, index) => ({
              index: index + 1,
              name: `Step ${index + 1}`,
              partCount: 0,
            }))
          ).map((entry) => (
            <li key={entry.index}>
              {entry.name}
              {entry.partCount ? `: ${entry.partCount} part${entry.partCount === 1 ? '' : 's'}` : ''}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

const CATEGORY_LABELS: Record<'all' | DemoCategory, string> = {
  all: 'All builds',
  landmarks: 'Landmarks',
  architecture: 'Buildings',
  animals: 'Animals',
  creative: 'Funny & creative',
  vehicles: 'Vehicles',
}

function ExploreCatalog() {
  const pointer = usePointerField<HTMLDivElement>()
  const [category, setCategory] = useState<'all' | DemoCategory>('all')
  const filtered = category === 'all' ? DEMOS : DEMOS.filter((demo) => demo.category === category)
  const totalParts = DEMOS.reduce((sum, demo) => sum + demo.validation.partCount, 0)
  const largest = [...DEMOS].sort((a, b) => b.validation.partCount - a.validation.partCount)[0]

  return (
    <div
      ref={pointer.ref}
      className="bw-surface bw-explore bw-explore-catalog"
      data-pointer={pointer.live ? 'live' : 'off'}
    >
      <PlateAtmosphere />
      <div className="bw-studs" aria-hidden="true" />
      <section className="bw-catalog-hero" aria-labelledby="bw-catalog-title">
        <div className="bw-catalog-kicker">
          <span>Editable megabuild library</span>
          <span>{DEMOS.length} kernel-verified starting points</span>
        </div>
        <div className="bw-catalog-hero-grid">
          <div>
            <p className="bw-eyebrow accent">Pick something enormous</p>
            <h1 id="bw-catalog-title">Don’t start from zero.</h1>
            <p className="bw-catalog-lede">
              Start from a landmark, a city block, a giant animal or something wonderfully ridiculous. Every build is
              already assembled from real catalog parts—open one, copy it, then tear it apart or keep building.
            </p>
          </div>
          <dl className="bw-catalog-totals" aria-label="Collection scale">
            <div>
              <dt>Editable parts</dt>
              <dd>{totalParts.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Largest build</dt>
              <dd>{largest.validation.partCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Minimum size</dt>
              <dd>1,000+</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="bw-catalog-library" aria-labelledby="bw-library-title">
        <div className="bw-catalog-toolbar">
          <div>
            <p className="bw-eyebrow">The full collection</p>
            <h2 id="bw-library-title">Choose your starting world.</h2>
          </div>
          <div className="bw-catalog-filters" role="group" aria-label="Filter builds">
            {(Object.keys(CATEGORY_LABELS) as Array<'all' | DemoCategory>).map((value) => (
              <button
                type="button"
                className="bw-chip"
                aria-pressed={category === value}
                key={value}
                onClick={() => setCategory(value)}
              >
                {CATEGORY_LABELS[value]}
              </button>
            ))}
          </div>
        </div>

        <div className="bw-catalog-grid" aria-live="polite">
          {filtered.map((demo, index) => (
            <CatalogCard demo={demo} index={index} key={demo.id} />
          ))}
        </div>
      </section>
    </div>
  )
}

function CatalogCard({ demo, index }: { demo: DemoEntry; index: number }) {
  const target = { kind: 'explore' as const, demoId: demo.id }
  return (
    <article className="bw-catalog-card" data-category={demo.category}>
      <a className="bw-catalog-image" href={hrefFor(target)} onClick={anchor(target)}>
        <img
          src={demo.assets.thumbnail.url}
          alt={`${demo.title}, a ${demo.validation.partCount.toLocaleString()}-part editable ${CATEGORY_LABELS[demo.category].toLowerCase()} build.`}
          width={720}
          height={450}
          loading={index < 3 ? 'eager' : 'lazy'}
          decoding="async"
        />
        <span className="bw-catalog-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="bw-catalog-category">{CATEGORY_LABELS[demo.category]}</span>
      </a>
      <div className="bw-catalog-card-body">
        <div>
          <h3>{demo.title}</h3>
          <p>{demo.tagline}</p>
        </div>
        <dl className="bw-catalog-card-stats">
          <div>
            <dt>Parts</dt>
            <dd>{demo.validation.partCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Footprint</dt>
            <dd>{demo.validation.footprintStuds.map((value) => Math.round(value)).join(' x ')}</dd>
          </div>
          <div>
            <dt>Steps</dt>
            <dd>{demo.validation.steps}</dd>
          </div>
        </dl>
        <a className="bw-catalog-open" href={hrefFor(target)} onClick={anchor(target)}>
          Preview & edit <span aria-hidden="true">↗</span>
        </a>
      </div>
    </article>
  )
}

function Fact({ k, v, tone }: { k: string; v: string | number; tone?: 'ok' | 'warn' }) {
  return (
    <li>
      <span className="k">{k}</span>
      <span className={tone ? `v ${tone}` : 'v'}>{v}</span>
    </li>
  )
}

function CompareRow({
  label,
  before,
  after,
  lowerIsBetter = false,
}: {
  label: string
  before: number
  after: number
  lowerIsBetter?: boolean
}) {
  const improved = lowerIsBetter ? after < before : after > before
  return (
    <>
      <span>{label}</span>
      <span className={`num ${improved ? 'before' : 'flat'}`}>{before}</span>
      <span className={`num ${improved ? 'after' : 'flat'}`}>{after}</span>
    </>
  )
}

function SelectedPart({ preview, index, onClear }: { preview: DemoPreview; index: number; onClear: () => void }) {
  const part = preview.parts[index]
  const definition = preview.definitions[part[PART_FIELDS.definition]]
  const color = preview.colors[part[PART_FIELDS.color]]
  const subassembly = preview.subassemblies[part[PART_FIELDS.subassembly]]
  const stepEntry = preview.steps[part[PART_FIELDS.step]]
  return (
    <div style={{ marginBottom: 12 }}>
      <ul className="bw-facts">
        <Fact k="Element" v={definition?.name ?? 'unknown'} />
        <Fact k="LDraw id" v={definition?.id ?? '—'} />
        <Fact k="Colour" v={`${color?.name ?? 'unknown'} (${color?.code ?? '?'})`} />
        <Fact k="Sub-assembly" v={subassembly?.name ?? '—'} />
        <Fact k="Introduced in" v={stepEntry ? stepEntry.name : '—'} />
        <Fact k="Compiled connectors" v={definition?.connectors ?? 0} />
        <Fact k="Official set appearances" v={definition?.frequency ?? 0} />
      </ul>
      <button type="button" className="bw-button ghost small" style={{ marginTop: 10 }} onClick={onClear}>
        Clear selection
      </button>
    </div>
  )
}

/**
 * The only fork outcome that still needs saying.
 *
 * A successful fork opens the fork, so there is nothing left to report: the
 * editor is already on screen with the project in it. This used to render a
 * success note — "Copied to a local project as X — N parts" — with an "Open it
 * in the editor" link underneath, which was a second click to reach somewhere
 * the first click could have gone, and a paragraph describing a thing the
 * operator could see for themselves.
 *
 * Only the failure survives, because a fork that did not happen leaves nothing
 * on screen to infer it from.
 */
function ForkResult({ outcome }: { outcome: Extract<ForkOutcome, { ok: false }> }) {
  return (
    <p className="bw-fork-note error" role="alert">
      {outcome.message}
    </p>
  )
}

function anchor(target: Parameters<typeof navigate>[0], side?: () => void) {
  return (event: React.MouseEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    side?.()
    navigate(target)
  }
}

export default ExplorePage
