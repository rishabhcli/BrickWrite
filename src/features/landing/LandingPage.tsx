import { useEffect } from 'react'
import { DEMOS, DEMO_MANIFEST, heroDemo, type DemoEntry } from '../../demos'
import { setKnownDemoIds, trackLanding } from './analytics'
import { Hero, type HeroStage } from './Hero'
import { hrefFor, navigate } from './navigation'
import { CountUp, PlateAtmosphere } from './plate'
import { useFilmStage, usePointerField, usePointerTilt, useReveal } from './reveal'
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
  const pointer = usePointerField<HTMLDivElement>()

  useEffect(() => {
    trackLanding({ name: 'landing.viewed' })
    trackLanding({ name: 'demo.viewed', demoId: hero.id, surface: 'landing' })
  }, [hero.id])

  return (
    <div
      ref={pointer.ref}
      className="bw-surface bw-landing"
      data-pointer={pointer.live ? 'live' : 'off'}
    >
      <PlateAtmosphere />
      <div className="bw-studs" aria-hidden="true" />
      <div className="bw-cursor" aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <div className="bw-cursor bw-cursor-ghost" aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <div id="bw-main">
        <Film hero={hero} />
        <BillRail demo={hero} />
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
      <div className="bw-film-stage" data-stage={film.stage}>
        <div className="bw-film-progress" aria-hidden="true">
          <span />
        </div>
        <ol className="bw-film-ruler" aria-hidden="true">
          {FILM_MARKS.map((mark) => (
            <li key={mark.id} data-current={film.stage === mark.id ? 'true' : 'false'}>{mark.n}</li>
          ))}
        </ol>
        <Hero
          demo={hero}
          stage={film.stage}
          onStageChange={(stage: HeroStage) => film.setStage(stage)}
          autoPlay={false}
          hideBrief
          scrub={film.progress}
        />
      </div>

      <div className="bw-film-chapters">
        <section
          className="bw-film-chapter bw-film-hero"
          data-film-stage="brief"
          data-active={film.stage === 'brief' ? 'true' : 'false'}
          aria-labelledby="bw-hero-title"
        >
          <span className="bw-eyebrow accent">Physically buildable brick CAD</span>
          <h1 className="bw-display x1" id="bw-hero-title">
            A model that <em>stands up</em> is a different thing from a model that renders.
          </h1>
          <p className="bw-lede bw-lede-short">
            Real LDraw parts. Real clutch. Edits that collide, float or tip are refused.
          </p>
          {hero.techniques.length ? (
            <p className="bw-hero-techniques">
              {hero.techniques.map((technique) => (
                <span key={technique}>{technique}</span>
              ))}
            </p>
          ) : null}
          <div className="bw-hero-actions">
            <a
              className="bw-button primary bw-magnet"
              href={hrefFor({ kind: 'editor', blank: true })}
              onClick={link({ kind: 'editor', blank: true }, () => {
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
            <span>This build: <b><CountUp value={good.partCount} fromZero /></b> parts</span>
            <span><b><CountUp value={good.connectionCount} fromZero /></b> mated connectors</span>
            <span><b><CountUp value={good.steps} fromZero /></b> verified build steps</span>
            <span><b>{good.statics.massLabel}</b>, stable by <b>{good.statics.tippingMarginLdu}</b> LDU</span>
          </p>
        </section>

        <section
          className="bw-film-chapter"
          data-film-stage="candidate"
          data-active={film.stage === 'candidate' ? 'true' : 'false'}
          aria-labelledby="bw-refine-title"
        >
          <span className="bw-section-index">01 / The pass</span>
          <h2 className="bw-display x2" id="bw-refine-title">Both models were built. Only one of them passed.</h2>
          <p className="bw-lede bw-lede-short">{hero.refinement}</p>
          {hero.brief ? (
            <blockquote className="bw-film-quote">{hero.brief.prompt}</blockquote>
          ) : null}
        </section>

        <section
          className="bw-film-chapter"
          data-film-stage="refinement"
          data-active={film.stage === 'refinement' ? 'true' : 'false'}
          aria-labelledby="bw-ledger-title"
        >
          <span className="bw-section-index">02 / Measured</span>
          <h2 className="bw-display x2" id="bw-ledger-title">The kernel keeps score.</h2>
          <Ledger demo={hero} />
        </section>

        <section
          className="bw-film-chapter"
          data-film-stage="validated"
          data-active={film.stage === 'validated' ? 'true' : 'false'}
          aria-labelledby="bw-validated-title"
        >
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
  const shown = reveal.props['data-shown'] === 'true'
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
              <td className={`value ${row.improved ? 'before' : 'flat'}`}>
                <CountUp value={Number(row.before)} play={shown} fromZero />
              </td>
              <td className={`value ${row.improved ? 'after' : 'flat'}`}>
                <CountUp value={Number(row.after)} play={shown} fromZero />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const FILM_MARKS = [
  { id: 'brief', n: '01' },
  { id: 'candidate', n: '02' },
  { id: 'refinement', n: '03' },
  { id: 'validated', n: '04' },
] as const

function BillRail({ demo }: { demo: DemoEntry }) {
  const items = demo.bill.slice(0, 18)
  if (!items.length) return null
  return (
    <div className="bw-bill-rail" aria-hidden="true">
      <div className="bw-bill-track">
        <span className="bw-bill-group">
          {items.map((line) => (
            <span className="bw-bill-pill" key={line.definitionId}>
              <b>{line.count}×</b> {line.name}
            </span>
          ))}
        </span>
        <span className="bw-bill-group" data-clone="true">
          {items.map((line) => (
            <span className="bw-bill-pill" key={`clone-${line.definitionId}`}>
              <b>{line.count}×</b> {line.name}
            </span>
          ))}
        </span>
      </div>
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
  usePointerTilt(reveal.ref)
  const target = { kind: 'explore' as const, demoId: demo.id }
  return (
    <a
      ref={reveal.ref}
      {...reveal.props}
      className={`bw-demo-card bw-lit ${reveal.props.className}`}
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
          {columns.map((column, index) => (
            <CapabilityCard key={column.title} column={column} index={index} />
          ))}
        </div>
      </div>
    </section>
  )
}

function CapabilityCard({
  column,
  index,
}: {
  column: { eyebrow: string; title: string; body: string; code: string }
  index: number
}) {
  const reveal = useReveal<HTMLElement>(Math.min(index, 3) * 80)
  return (
    <article ref={reveal.ref} {...reveal.props} className={`bw-column bw-lit ${reveal.props.className}`}>
      <span className="bw-eyebrow">{column.eyebrow}</span>
      <h3>{column.title}</h3>
      <p>{column.body}</p>
      <p><code>{column.code}</code></p>
    </article>
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
        <div className="bw-gate-rail" aria-hidden="true">
          <div className="bw-gate-track">
            <span className="bw-gate-group">
              {DEMO_MANIFEST.gates.map((gate) => (
                <span className="bw-gate-pill" key={gate}>{gate}</span>
              ))}
            </span>
            <span className="bw-gate-group" data-clone="true">
              {DEMO_MANIFEST.gates.map((gate) => (
                <span className="bw-gate-pill" key={`clone-${gate}`}>{gate}</span>
              ))}
            </span>
          </div>
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
        <h2 className="bw-display x1 bw-close-mark" id="bw-close-title">Open the console.</h2>
        <div className="bw-hero-actions">
          <a
            className="bw-button primary bw-magnet"
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
