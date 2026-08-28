import { useEffect } from 'react'
import { DEMOS, DEMO_MANIFEST, heroDemo, type DemoEntry } from '../../demos'
import { setKnownDemoIds, trackLanding } from './analytics'
import { Hero } from './Hero'
import { hrefFor, navigate } from './navigation'
import { useReveal } from './reveal'
import './landing.css'

/**
 * The landing page.
 *
 * Every claim on this page is either a link to something you can operate or a
 * number that came out of a run recorded in `public/demos/manifest.json`. There
 * are no logos, no testimonials and no usage figures, because Brickwright has
 * no users to count and inventing some would be the first lie a visitor could
 * check.
 *
 * The route paints from this module, the shipped demo manifest and a stylesheet.
 * It does not import the catalog loader, the CAD kernel, the WebMCP adapter or
 * Three.js — `landing.imports.test.ts` asserts that against the source, and the
 * acceptance run asserts it against the network log.
 */

setKnownDemoIds(DEMOS.map((demo) => demo.id))

export function LandingPage() {
  const hero = heroDemo()

  useEffect(() => {
    trackLanding({ name: 'landing.viewed' })
    trackLanding({ name: 'demo.viewed', demoId: hero.id, surface: 'landing' })
  }, [hero.id])

  return (
    <div className="bw-surface bw-landing">
      <div id="bw-main">
        <HeroSection hero={hero} />
        <RefinementSection hero={hero} />
        <DemoSection />
        <CapabilitySection />
        <GateSection />
        <ClosingSection />
      </div>
      <Colophon />
    </div>
  )
}

function HeroSection({ hero }: { hero: DemoEntry }) {
  const good = hero.validation
  return (
    <section className="bw-hero" aria-labelledby="bw-hero-title">
      <div className="bw-shell bw-hero-grid">
        <div className="bw-hero-copy">
          <span className="bw-eyebrow accent">Agent-native 3D CAD for physically buildable brick models</span>
          <h1 className="bw-display x1" id="bw-hero-title">
            A model that <em>stands up</em> is a different thing from a model that renders.
          </h1>
          <p className="bw-lede">
            Brickwright compiles the real LDraw library into a CAD kernel with authoritative connection
            metadata, then refuses to accept an edit that collides, floats or falls over. Humans and agents
            drive the same revisioned document through the same command bus.
          </p>
          <div className="bw-hero-actions">
            <a
              className="bw-button primary"
              href={hrefFor({ kind: 'editor' })}
              onClick={link({ kind: 'editor' }, () => {
                trackLanding({ name: 'landing.cta_selected', cta: 'start-blank' })
                trackLanding({ name: 'editor.opened', from: 'landing', withProject: false })
              })}
            >
              Start a blank build <span className="bw-key" aria-hidden="true">→</span>
            </a>
            <a
              className="bw-button"
              href={hrefFor({ kind: 'describe' })}
              onClick={link({ kind: 'describe' }, () => trackLanding({ name: 'landing.cta_selected', cta: 'describe-build' }))}
            >
              Describe a build
            </a>
            <a
              className="bw-button ghost"
              href={hrefFor({ kind: 'explore' })}
              onClick={link({ kind: 'explore' }, () => trackLanding({ name: 'landing.cta_selected', cta: 'explore-demos' }))}
            >
              Explore {DEMOS.length} demos
            </a>
          </div>
          <p className="bw-hero-facts">
            <span>Catalog <b>{DEMO_MANIFEST.catalogVersion}</b></span>
            <span>This build: <b>{good.partCount}</b> parts</span>
            <span><b>{good.connectionCount}</b> mated connectors</span>
            <span><b>{good.steps}</b> verified build steps</span>
            <span><b>{good.statics.massLabel}</b>, stable by <b>{good.statics.tippingMarginLdu}</b> LDU</span>
          </p>
        </div>
        <Hero demo={hero} />
      </div>
    </section>
  )
}

function RefinementSection({ hero }: { hero: DemoEntry }) {
  const reveal = useReveal<HTMLDivElement>()
  const rows = ledgerRows(hero)
  return (
    <section className="bw-section" aria-labelledby="bw-refine-title">
      <div className="bw-shell">
        <div className="bw-section-head">
          <span className="bw-section-index">01 / Refinement, measured</span>
          <h2 className="bw-display x2" id="bw-refine-title">Both models were built. Only one of them passed.</h2>
          <p className="bw-lede">{hero.refinement}</p>
        </div>
        <div ref={reveal.ref} {...reveal.props}>
          <table className="bw-ledger">
            <caption>
              Every figure below is one field of a validation report the kernel produced for a real document.
              The earlier candidate is published alongside the model, so the comparison can be checked rather
              than taken on trust.
            </caption>
            <thead>
              <tr>
                <th scope="col">Measurement</th>
                <th scope="col">First candidate</th>
                <th scope="col">Published model</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row" style={{ fontFamily: 'inherit', fontSize: '13.5px', letterSpacing: 0, textTransform: 'none', color: 'var(--bw-ink)', fontWeight: 500 }}>
                    {row.label}
                  </th>
                  <td className={`value ${row.improved ? 'before' : 'flat'}`}>{row.before}</td>
                  <td className={`value ${row.improved ? 'after' : 'flat'}`}>{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function DemoSection() {
  return (
    <section className="bw-section" aria-labelledby="bw-demos-title">
      <div className="bw-shell">
        <div className="bw-section-head">
          <span className="bw-section-index">02 / The demos</span>
          <h2 className="bw-display x2" id="bw-demos-title">Six builds, authored by the same generators you get.</h2>
          <p className="bw-lede">
            Each one is a versioned <code>ModelDocument</code> snapshot compiled against catalog{' '}
            {DEMO_MANIFEST.catalogVersion} and gated before publication. Open one to orbit it, take it apart,
            scrub its build sequence and fork it into a project of your own.
          </p>
        </div>
        <div className="bw-demo-grid">
          {DEMOS.map((demo, index) => <DemoCard key={demo.id} demo={demo} index={index} />)}
        </div>
      </div>
    </section>
  )
}

function DemoCard({ demo, index }: { demo: DemoEntry; index: number }) {
  const reveal = useReveal<HTMLAnchorElement>(Math.min(index, 5) * 60)
  const target = { kind: 'explore' as const, demoId: demo.id }
  return (
    <a
      ref={reveal.ref}
      {...reveal.props}
      className={`bw-demo-card ${reveal.props.className}`}
      href={hrefFor(target)}
      onClick={link(target, () => trackLanding({ name: 'demo.viewed', demoId: demo.id, surface: 'landing' }))}
    >
      <figure>
        <img
          src={demo.assets.thumbnail.url}
          alt={`${demo.title}: ${demo.validation.partCount} parts, rendered offline from its compiled LDraw geometry.`}
          width={720}
          height={450}
          loading={index < 2 ? 'eager' : 'lazy'}
          decoding="async"
        />
        <figcaption>{demo.discipline}</figcaption>
      </figure>
      <div className="bw-demo-body">
        <h3>{demo.title}</h3>
        <p>{demo.tagline}</p>
        <p className="bw-demo-stats">
          <span><b>{demo.validation.partCount}</b> parts</span>
          <span><b>{demo.validation.connectionCount}</b> mates</span>
          <span><b>{demo.validation.steps}</b> steps</span>
          <span className="ok">{demo.validation.collisionCount} collisions</span>
          <span className="ok">{demo.validation.componentCount} component</span>
        </p>
      </div>
    </a>
  )
}

function CapabilitySection() {
  const columns = [
    {
      eyebrow: 'Catalog',
      title: 'It says what it does not know',
      body: 'Search answers for the whole catalogue and every hit carries its tier. A part that exists but has no compiled mesh in this build is reported as exactly that, not as absent.',
      code: 'catalog_search · tier: placeable | modelled | catalogued',
    },
    {
      eyebrow: 'Kernel',
      title: 'Every edit is a transaction',
      body: 'Human and agent edits create the same atomic records against the same revision guard. Protected regions, hard constraints and triangle-confirmed collision apply to both, and one undo reverses either.',
      code: 'action_mutate · expectedRevision',
    },
    {
      eyebrow: 'Assembly',
      title: 'One instruction, a whole storey',
      body: 'The parametric solver lays bonded courses, ties corners, seats real window and door frames in openings and reports every course it could not fully bond.',
      code: 'build_enclosure · build_structure · stamp_module',
    },
    {
      eyebrow: 'Physics',
      title: 'Mass measured from the mesh',
      body: 'Volume comes from each part’s compiled surface, so centre of mass, support polygon and tipping margin are measurements. The two figures that are assumptions say so in every report.',
      code: 'analyse_statics · clutch 100 gf/stud, stated',
    },
  ]
  return (
    <section className="bw-section" aria-labelledby="bw-capability-title">
      <div className="bw-shell">
        <div className="bw-section-head">
          <span className="bw-section-index">03 / What is underneath</span>
          <h2 className="bw-display x2" id="bw-capability-title">A working vertical slice, not a chat interface.</h2>
        </div>
        <div className="bw-columns">
          {columns.map((column) => (
            <article className="bw-column" key={column.title}>
              <span className="bw-eyebrow">{column.eyebrow}</span>
              <h3>{column.title}</h3>
              <p>{column.body}</p>
              <p><code>{column.code}</code></p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function GateSection() {
  return (
    <section className="bw-section" aria-labelledby="bw-gates-title">
      <div className="bw-shell">
        <div className="bw-section-head">
          <span className="bw-section-index">04 / Why these six</span>
          <h2 className="bw-display x2" id="bw-gates-title">A demo that fails the kernel is not a demo.</h2>
          <p className="bw-lede">
            <code>tools/build-demos.mjs</code> authors each build against the real catalog and the real
            assembly planners, then puts it through the checks below. A build that fails one is not written
            to the manifest — the build exits non-zero instead.
          </p>
        </div>
        <ul className="bw-gates">
          {DEMO_MANIFEST.gates.map((gate) => <li key={gate}>{gate}</li>)}
        </ul>
      </div>
    </section>
  )
}

function ClosingSection() {
  return (
    <section className="bw-section" aria-labelledby="bw-close-title">
      <div className="bw-shell bw-close">
        <span className="bw-eyebrow accent">Start</span>
        <h2 className="bw-display x2" id="bw-close-title">Open the console.</h2>
        <p className="bw-lede">
          The professional editor is the whole application: catalog, viewport, gizmo, command deck, build
          sequence, exports and the agent surface. Nothing on this page is a separate product.
        </p>
        <div className="bw-hero-actions">
          <a
            className="bw-button primary"
            href={hrefFor({ kind: 'editor' })}
            onClick={link({ kind: 'editor' }, () => {
              trackLanding({ name: 'landing.cta_selected', cta: 'open-editor' })
              trackLanding({ name: 'editor.opened', from: 'landing', withProject: false })
            })}
          >
            Open the professional editor <span className="bw-key" aria-hidden="true">→</span>
          </a>
          <a className="bw-button" href={hrefFor({ kind: 'explore' })} onClick={link({ kind: 'explore' })}>
            Explore the demos
          </a>
        </div>
      </div>
    </section>
  )
}

function Colophon() {
  return (
    <footer className="bw-footer bw-shell">
      <p>
        Demo assets were generated by <code>tools/build-demos.mjs</code> against catalog{' '}
        {DEMO_MANIFEST.catalogVersion} and rendered offline by <code>src/cad/raster.ts</code>. Thumbnails are
        software renders of the compiled LDraw geometry; the interactive views draw each part’s measured
        envelope.
      </p>
      <p>
        LEGO® is a trademark of the LEGO Group, which does not sponsor, endorse or authorise LDraw or
        Brickwright. Catalog assets derive from the LDraw Parts Library (CC BY 4.0), the LDCad Shadow
        Library (CC BY-SA 4.0) and the Rebrickable bulk catalog; their terms travel with them.
      </p>
    </footer>
  )
}

/** Rows for the refinement ledger, showing only what actually changed. */
function ledgerRows(demo: DemoEntry) {
  const delta = demo.delta
  const rows = [
    { label: 'Connected components', before: delta.componentsBefore, after: delta.componentsAfter, lowerIsBetter: true },
    { label: 'Parts off the main body', before: delta.loosePartsBefore, after: delta.loosePartsAfter, lowerIsBetter: true },
    { label: 'Parts the load path never reaches', before: delta.unsupportedBefore, after: delta.unsupportedAfter, lowerIsBetter: true },
    { label: 'Confirmed collisions', before: delta.collisionsBefore, after: delta.collisionsAfter, lowerIsBetter: true },
    { label: 'Parts placed', before: demo.roughValidation.partCount, after: demo.validation.partCount, lowerIsBetter: false },
    { label: 'Mated connectors', before: demo.roughValidation.connectionCount, after: demo.validation.connectionCount, lowerIsBetter: false },
    { label: 'Verified build steps', before: delta.stepsBefore, after: delta.stepsAfter, lowerIsBetter: false },
  ]
  return rows.map((row) => ({
    label: row.label,
    before: String(row.before),
    after: String(row.after),
    improved: row.lowerIsBetter ? row.after < row.before : row.after > row.before,
  }))
}

/** Intercepts a real anchor so navigation is one history entry, not a reload. */
function link(target: Parameters<typeof navigate>[0], side?: () => void) {
  return (event: React.MouseEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    side?.()
    navigate(target)
    window.scrollTo({ top: 0 })
  }
}

export default LandingPage
