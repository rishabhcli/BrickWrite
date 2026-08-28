import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEMOS, getDemo, loadPreview, type DemoEntry, type DemoPreview } from '../../demos'
import { setKnownDemoIds, trackLanding } from '../landing/analytics'
import { hrefFor, navigate, useLandingRoute } from '../landing/navigation'
import { forkDemo, type ForkOutcome } from './fork'
import { PART_FIELDS } from './projection'
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
  const demo = (route.demoId ? getDemo(route.demoId) : undefined) ?? DEMOS[0]
  const unknownId = route.demoId !== null && !getDemo(route.demoId)

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
      .then((loaded) => { if (!cancelled) setPreview(loaded) })
      .catch((cause: unknown) => { if (!cancelled && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true; controller.abort() }
  }, [demo])

  // The earlier candidate is a second fetch, taken only when somebody asks to
  // compare — most visits never do.
  useEffect(() => {
    if (view !== 'before-after' || roughPreview) return
    const controller = new AbortController()
    loadPreview(demo, 'rough', controller.signal).then(setRoughPreview).catch(() => undefined)
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
    } else {
      trackLanding({ name: 'demo.fork_failed', demoId: demo.id, destination: outcome.destination })
    }
  }, [demo, fork.pending])

  const activePreview = view === 'before-after' ? roughPreview ?? preview : preview
  const selectedPart = activePreview && selected !== null ? activePreview.parts[selected] : null
  const stepIndexLimit = view === 'before-after' ? undefined : step

  const stepName = useMemo(() => {
    const entry = preview?.steps.find((candidate) => candidate.index === step)
    return entry ? entry.name : `Step ${step}`
  }, [preview, step])

  return (
    <div className="bw-surface bw-explore">
      <a className="bw-button small bw-skip" href="#bw-explore-main">Skip to the model</a>
      <header className="bw-explore-bar">
        <a className="bw-button ghost small" href={hrefFor({ kind: 'landing' })} onClick={anchor({ kind: 'landing' })}>← Brickwright</a>
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
              style={entry.id === demo.id ? { color: '#0c1214', background: 'var(--bw-cyan)', borderColor: 'var(--bw-cyan)' } : undefined}
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
            <i /><i /><i /><i />
            {activePreview ? (
              <Suspense fallback={null}>
                <EnvelopeView
                  preview={activePreview}
                  camera={camera}
                  onCameraChange={setCamera}
                  stepLimit={stepIndexLimit}
                  highlightStep={view === 'solid' && step < totalSteps ? step - 1 : undefined}
                  explode={explode}
                  selectedIndex={selected}
                  onSelectIndex={(index) => {
                    setSelected(index)
                    if (index !== null) trackLanding({ name: 'demo.part_inspected', demoId: demo.id })
                  }}
                  label={
                    `${demo.title}: ${activePreview.parts.length} parts drawn as measured LDraw envelopes. `
                    + `Showing ${view === 'before-after' ? 'the first candidate' : `build step ${step} of ${totalSteps}`}.`
                  }
                />
              </Suspense>
            ) : null}
            {error ? <p className="bw-fork-note error" role="alert" style={{ position: 'absolute', inset: 'auto 16px 16px' }}>{error}</p> : null}
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
              <button type="button" className="bw-chip" onClick={() => setCamera(demo.camera)}>Reset view</button>
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
                <span className="bw-control-value">{step} / {totalSteps}</span>
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
                <>Showing the first candidate: <b>{demo.roughValidation.partCount}</b> parts in{' '}
                <b>{demo.roughValidation.componentCount}</b> connected component{demo.roughValidation.componentCount === 1 ? '' : 's'}.</>
              ) : (
                <><b>{stepName}</b> — the sequence is derived from the connection graph, and every step after the
                first attaches to structure placed earlier.</>
              )}
            </p>
          </div>
        </section>

        <aside className="bw-explore-inspector" aria-label="Model report">
          <div className="bw-inspector-section">
            <span className="bw-eyebrow accent">{demo.discipline}</span>
            <h2>{demo.title}</h2>
            <p>{demo.summary}</p>
            <div className="bw-chips">{demo.techniques.map((entry) => <span className="bw-chip" key={entry}>{entry}</span>)}</div>
          </div>

          <div className="bw-inspector-section bw-fork">
            <span className="bw-eyebrow">Fork it</span>
            <button type="button" className="bw-button primary" onClick={startFork} disabled={fork.pending}>
              {fork.pending ? 'Copying…' : 'Edit this build'} <span className="bw-key" aria-hidden="true">→</span>
            </button>
            <p className="bw-note">
              The published demo is immutable. This copies the snapshot into a project of your own; the demo
              itself is never modified.
            </p>
            {fork.outcome ? <ForkResult demo={demo} outcome={fork.outcome} /> : null}
          </div>

          <div className="bw-inspector-section">
            <span className="bw-eyebrow">Validation · revision {demo.validation.revision}</span>
            <ul className="bw-facts">
              <Fact k="Parts" v={demo.validation.partCount} />
              <Fact k="Distinct elements" v={demo.distinctParts} />
              <Fact k="Mated connectors" v={demo.validation.connectionCount} />
              <Fact k="Confirmed collisions" v={demo.validation.collisionCount} tone={demo.validation.collisionCount ? 'warn' : 'ok'} />
              <Fact k="Unverified verdicts" v={demo.validation.unverifiedCollisions} tone={demo.validation.unverifiedCollisions ? 'warn' : 'ok'} />
              <Fact k="Connected components" v={demo.validation.componentCount} tone={demo.validation.componentCount === 1 ? 'ok' : 'warn'} />
              <Fact k="Build steps" v={`${demo.validation.steps} · ${demo.validation.buildOrderVerified ? 'verified' : 'unverified'}`} tone={demo.validation.buildOrderVerified ? 'ok' : 'warn'} />
              <Fact k="Footprint" v={`${demo.validation.footprintStuds[0]} × ${demo.validation.footprintStuds[1]} studs`} />
              <Fact k="Colours without set evidence" v={demo.validation.virtualColorCount} />
            </ul>
          </div>

          <div className="bw-inspector-section">
            <span className="bw-eyebrow">Statics</span>
            <ul className="bw-facts">
              <Fact k="Mass" v={demo.validation.statics.massLabel} />
              <Fact k="Support footprint" v={demo.validation.statics.supportLabel} />
              <Fact k="Tipping margin" v={`${demo.validation.statics.tippingMarginLdu} LDU`} tone={demo.validation.statics.stable ? 'ok' : 'warn'} />
              <Fact k="Mass coverage" v={`${Math.round(demo.validation.statics.coverage * 100)}%`} />
              <Fact k="Carried in tension" v={demo.validation.statics.unsupportedParts} />
              <Fact k="Groups over clutch capacity" v={demo.validation.statics.overloadedGroups} tone={demo.validation.statics.overloadedGroups ? 'warn' : 'ok'} />
            </ul>
            <p className="bw-note" style={{ marginTop: 10 }}>{demo.validation.statics.massBasis}</p>
            <p className="bw-note">
              Clutch capacity is an assumption, not a measurement: {demo.validation.statics.clutchGramsPerStud} gf per stud,
              the conservative end of independent measurements.
            </p>
            {demo.tensionReason ? <p className="bw-note">{demo.tensionReason}</p> : null}
          </div>

          <div className="bw-inspector-section">
            <span className="bw-eyebrow">Refinement</span>
            <p>{demo.refinement}</p>
            <div className="bw-compare">
              <span className="head">Measurement</span>
              <span className="head">Candidate</span>
              <span className="head">Published</span>
              <CompareRow label="Components" before={demo.delta.componentsBefore} after={demo.delta.componentsAfter} lowerIsBetter />
              <CompareRow label="Loose parts" before={demo.delta.loosePartsBefore} after={demo.delta.loosePartsAfter} lowerIsBetter />
              <CompareRow label="Parts" before={demo.roughValidation.partCount} after={demo.validation.partCount} />
              <CompareRow label="Mates" before={demo.roughValidation.connectionCount} after={demo.validation.connectionCount} />
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
                      const definition = activePreview.definitions.findIndex((entry) => entry.id === line.definitionId)
                      const index = activePreview.parts.findIndex((part) => part[PART_FIELDS.definition] === definition)
                      if (index >= 0) {
                        setSelected(index)
                        trackLanding({ name: 'demo.part_inspected', demoId: demo.id })
                      }
                    }}
                  >
                    <span className="bw-swatch" style={{ background: '#2b3538' }} aria-hidden="true" />
                    <strong>{line.name}</strong>
                    <code>{line.definitionId} × {line.count}</code>
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
              Generated by <code>{demo.provenance.generator}</code>; stills rendered by <code>{demo.provenance.renderer}</code>.
              The interactive view above draws each part’s measured LDraw envelope, not its compiled mesh — open
              the editor for that.
            </p>
          </div>
        </aside>
      </div>

      <section className="bw-visually-hidden" aria-label="Build sequence, as text">
        <h2>Build sequence for {demo.title}</h2>
        <ol>
          {(preview?.steps ?? []).map((entry) => (
            <li key={entry.index}>{entry.name}: {entry.partCount} part{entry.partCount === 1 ? '' : 's'}</li>
          ))}
        </ol>
      </section>
    </div>
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

function CompareRow({ label, before, after, lowerIsBetter = false }: { label: string; before: number; after: number; lowerIsBetter?: boolean }) {
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
      <button type="button" className="bw-button ghost small" style={{ marginTop: 10 }} onClick={onClear}>Clear selection</button>
    </div>
  )
}

function ForkResult({ demo, outcome }: { demo: DemoEntry; outcome: ForkOutcome }) {
  if (!outcome.ok) {
    return <p className="bw-fork-note error" role="alert">{outcome.message}</p>
  }
  return (
    <div className="bw-fork-note good" role="status">
      <p style={{ margin: 0 }}>
        {outcome.destination === 'cloud'
          ? `Copied to a cloud project through the ${outcome.adapter} adapter`
          : 'Copied to a local project in this browser'}
        {' '}as <b>{outcome.name}</b> — {outcome.parts} parts. {demo.title} itself is unchanged.
      </p>
      {outcome.destination === 'local' && outcome.note ? <p style={{ margin: '6px 0 0' }}>{outcome.note}</p> : null}
      <a
        className="bw-button small"
        style={{ marginTop: 10 }}
        href={hrefFor({ kind: 'editor-project', projectId: outcome.projectId })}
        onClick={anchor({ kind: 'editor-project', projectId: outcome.projectId }, () =>
          trackLanding({ name: 'editor.opened', from: 'explore', withProject: true }))}
      >
        Open it in the editor <span className="bw-key" aria-hidden="true">→</span>
      </a>
    </div>
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
