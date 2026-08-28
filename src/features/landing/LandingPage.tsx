import { useEffect } from 'react'
import { DEMOS, DEMO_MANIFEST, heroDemo, type DemoEntry } from '../../demos'
import { setKnownDemoIds, trackLanding } from './analytics'
import { Hero, type HeroStage } from './Hero'
import { hrefFor, navigate } from './navigation'
import { useFilmStage, useReveal } from './reveal'
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
      <div className="bw-studs" aria-hidden="true" />
      <div id="bw-main">
        <Film hero={hero} />
        <DemoSection />
        <CapabilitySection />
        <GateSection />
        <ClosingSection />
      </div>
      <Colophon />
    </div>
  )
}

function Film({ hero }: { hero: DemoEntry }) {
  const film = useFilmStage()
  const good = hero.validation

  return (
    <div className="bw-film">
      <div className="bw-film-stage">
        <Hero
          demo={hero}
          stage={film.stage}
          onStageChange={(stage: HeroStage) => film.setStage(stage)}
          autoPlay={false}
          hideBrief
        />
      </div>

      <div className="bw-film-chapters">
        <section className="bw-film-chapter" data-film-stage="brief" aria-labelledby="bw-hero-title">
          <span className="bw-eyebrow accent">Physically buildable brick CAD</span>
          <h1 className="bw-display x1" id="bw-hero-title">
            A model that <em>stands up</em> is a different thing from a model that renders.
          </h1>
          <p className="bw-lede bw-lede-short">
            Real LDraw parts. Real clutch. Edits that collide, float or tip are refused.
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
          <p className="bw-hero-facts" data-testid="hero-facts">
            <span>Catalog <b>{DEMO_MANIFEST.catalogVersion}</b></span>
            <span>This build: <b>{good.partCount}</b> parts</span>
            <span><b>{good.connectionCount}</b> mated connectors</span>
            <span><b>{good.steps}</b> verified build steps</span>
            <span><b>{good.statics.massLabel}</b>, stable by <b>{good.statics.tippingMarginLdu}</b> LDU</span>
          </p>
        </section>

        <section className="bw-film-chapter" data-film-stage="candidate" aria-labelledby="bw-refine-title">
          <span className="bw-section-index">01 / The pass</span>
          <h2 className="bw-display x2" id="bw-refine-title">Both models were built. Only one of them passed.</h2>
          <p className="bw-lede bw-lede-short">{hero.refinement}</p>
          {hero.brief ? (
            <blockquote className="bw-film-quote">{hero.brief.prompt}</blockquote>
          ) : null}
        </section>

        <section className="bw-film-chapter" data-film-stage="refinement" aria-labelledby="bw-ledger-title">
          <span className="bw-section-index">02 / Measured</span>
          <h2 className="bw-display x2" id="bw-ledger-title">The kernel keeps score.</h2>
          <Ledger demo={hero} />
        </section>

        <section className="bw-film-chapter" data-film-stage="validated" aria-labelledby="bw-validated-title">
          <span className="bw-section-index">03 / Published</span>
          <h2 className="bw-display x2" id="bw-validated-title">
            {good.collisionCount} collisions. {good.componentCount} body. It stands.
          </h2>
          <p className="bw-lede bw-lede-short">
            {good.partCount} parts, {good.connectionCount} mates, {good.steps} build steps — gated before it shipped.
          </p>
        </section>
      </div>
    </div>
  )
}

function Ledger({ demo }: { demo: DemoEntry }) {
  const reveal = useReveal<HTMLDivElement>()
  const rows = ledgerRows(demo)
  return (
    <div ref={reveal.ref} {...reveal.props}>
      <table className="bw-ledger">
        <caption>
          Figures from the kernel’s validation report. The earlier candidate is published beside the model.
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
              <th scope="row">{row.label}</th>
              <td className={`value ${row.improved ? 'before' : 'flat'}`}>{row.before}</td>
              <td className={`value ${row.improved ? 'after' : 'flat'}`}>{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DemoSection() {
  return (
    <section className="bw-section" aria-labelledby="bw-demos-title">
      <div className="bw-shell">
        <div className="bw-section-head">
          <span className="bw-section-index">The demos</span>
          <h2 className="bw-display x2" id="bw-demos-title">Six builds. Same generators you get.</h2>
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
      body: 'Every hit carries its tier. A part without a mesh is reported as that — not as absent.',
      code: 'catalog_search · tier: placeable | modelled | catalogued',
    },
    {
      eyebrow: 'Kernel',
      title: 'Every edit is a transaction',
      body: 'Human and agent share one revision guard. One undo reverses either.',
      code: 'action_mutate · expectedRevision',
    },
    {
      eyebrow: 'Assembly',
      title: 'One instruction, a whole storey',
      body: 'Bonded courses, tied corners, real frames in openings. Gaps are reported, not hidden.',
      code: 'build_enclosure · build_structure · stamp_module',
    },
    {
      eyebrow: 'Physics',
      title: 'Mass measured from the mesh',
      body: 'Centre of mass, support polygon, tipping margin. Assumptions are labelled as such.',
      code: 'analyse_statics · clutch 100 gf/stud, stated',
    },
  ]
  return (
    <section className="bw-section" aria-labelledby="bw-capability-title">
      <div className="bw-shell">
        <div className="bw-section-head">
          <span className="bw-section-index">Underneath</span>
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
          <span className="bw-section-index">Why these six</span>
          <h2 className="bw-display x2" id="bw-gates-title">A demo that fails the kernel is not a demo.</h2>
        </div>
        <ul className="bw-gates" aria-label="Publication gates">
          {DEMO_MANIFEST.gates.map((gate) => <li key={gate}>{gate}</li>)}
        </ul>
      </div>
    </section>
  )
}

function ClosingSection() {
  return (
    <section className="bw-section bw-section-close" aria-labelledby="bw-close-title">
      <div className="bw-shell bw-close">
        <span className="bw-eyebrow accent">Start</span>
        <h2 className="bw-display x1" id="bw-close-title">Open the console.</h2>
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
        {DEMO_MANIFEST.catalogVersion} and rendered offline by <code>src/cad/raster.ts</code>.
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
  }
}

export default LandingPage
