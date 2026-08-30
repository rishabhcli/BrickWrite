import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { DEMOS, DEMO_MANIFEST, heroDemo, type DemoEntry } from '../../demos'
import { setKnownDemoIds, trackLanding } from './analytics'
import { Hero, type HeroStage } from './Hero'
import { hrefFor, navigate } from './navigation'
import { CountUp, PlateAtmosphere } from './plate'
import { FILM_STAGES, useFilmStage, usePointerField, usePointerTilt, useReveal } from './reveal'
import './landing.css'

/**
 * The product front door.
 *
 * The first screen keeps the model, the measured result and the route into the
 * editor visible together. A shorter assembly reel below it earns its extra
 * scroll by showing one continuous material transformation rather than
 * repeating product copy. Every figure still comes from the published demo
 * manifest and every call to action still resolves to an operable surface.
 */

setKnownDemoIds(DEMOS.map((demo) => demo.id))

export function LandingPage() {
  const hero = heroDemo()
  const showcase = hero.showcase
  const pointer = usePointerField<HTMLDivElement>()

  useEffect(() => {
    trackLanding({ name: 'landing.viewed' })
    trackLanding({ name: 'demo.viewed', demoId: hero.id, surface: 'landing' })
  }, [hero.id])

  return (
    <div
      ref={pointer.ref}
      className="bw-surface bw-landing bw-landing-simple"
      data-pointer={pointer.live ? 'live' : 'off'}
    >
      <PlateAtmosphere />
      <div className="bw-studs" aria-hidden="true" />
      <div className="bw-cursor" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <span />
      </div>
      <div className="bw-cursor bw-cursor-ghost" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>

      <div id="bw-main">
        <section className="bw-simple-hero" aria-labelledby="bw-hero-title">
          <HeroScatter />
          <div className="bw-simple-hero-copy">
            <span className="bw-eyebrow accent bw-flagship-kicker">
              Flagship set / {hero.validation.partCount.toLocaleString()} verified pieces
            </span>
            <h1 className="bw-display x1" id="bw-hero-title">
              Rebuild the
              <br />
              <em>whole campus.</em>
            </h1>
            <p className="bw-lede">
              The Illinois Main Quad is a complete, editable campus set: {hero.validation.partCount.toLocaleString()}{' '}
              catalog-backed pieces, {showcase?.landmarkCount ?? 7} landmarks, {showcase?.characterCount ?? 21} brick
              characters and {hero.validation.steps} verified build steps across a {hero.validation.footprintStuds[0]} ×{' '}
              {hero.validation.footprintStuds[1]}-stud site.
            </p>
            <div className="bw-hero-actions">
              <a
                className="bw-button primary bw-magnet"
                href={hrefFor({ kind: 'explore', demoId: hero.id })}
                onClick={link({ kind: 'explore', demoId: hero.id }, () =>
                  trackLanding({ name: 'demo.viewed', demoId: hero.id, surface: 'landing' }),
                )}
              >
                Explore the campus{' '}
                <span className="bw-key" aria-hidden="true">
                  &rarr;
                </span>
              </a>
              <a
                className="bw-button"
                href={hrefFor({ kind: 'editor', blank: true })}
                onClick={link({ kind: 'editor', blank: true }, () => {
                  trackLanding({ name: 'landing.cta_selected', cta: 'start-blank' })
                  trackLanding({ name: 'editor.opened', from: 'landing', withProject: false })
                })}
              >
                Start building{' '}
                <span className="bw-key" aria-hidden="true">
                  &rarr;
                </span>
              </a>
              <a
                className="bw-button ghost"
                href={hrefFor({ kind: 'describe' })}
                onClick={link({ kind: 'describe' }, () =>
                  trackLanding({ name: 'landing.cta_selected', cta: 'describe-build' }),
                )}
              >
                Describe an idea
              </a>
            </div>
            <p className="bw-simple-trust">
              One connected ModelDocument · zero collisions · 100% measured mass · no prerecorded animation.
            </p>
          </div>

          <div className="bw-simple-hero-model">
            {/* The four stages — brief, candidate, refinement, validated — are the
                product in one moment: an idea typed in, a candidate proposed,
                refined, and signed off by the kernel. `autoPlay` was off, which
                left a still render beside a wall of text explaining what the
                still render was.

                It opens on the validated set so the first thing painted is the
                finished, measured model, then replays how it got there. Motion
                is gated on `prefers-reduced-motion`, stops the moment a visitor
                takes the stage track over, and only runs while on screen. */}
            <Hero demo={hero} initialStage="validated" hideBrief />
          </div>
        </section>

        <ProofStrip demo={hero} />
        <AssemblyFilm demo={hero} />
        <FeaturedBuilds />
        <ClosingSection />
      </div>

      <Colophon />
    </div>
  )
}

/**
 * A short, scroll-scrubbed assembly reel.
 *
 * Datacurve's homepage earns its drama with a single visual system that mutates
 * as the visitor scrolls. Brickwright should not borrow its particle language,
 * so this page uses its own material: clutch-sized CSS solids travel from a
 * loose field into a campus-scale assembly while the real validation story
 * advances alongside it. The DOM scene is deliberately lightweight; the live
 * LDraw envelope above remains the source of actual model geometry.
 */
function AssemblyFilm({ demo }: { demo: DemoEntry }) {
  const film = useFilmStage()
  const good = demo.validation
  const rough = demo.roughValidation
  const tippingMargin = good.statics.tippingMarginLdu

  const chapters: Array<{
    stage: HeroStage
    index: string
    eyebrow: string
    title: string
    body: string
    metric: string
  }> = [
    {
      stage: 'brief',
      index: '01',
      eyebrow: 'Loose matter',
      title: 'An idea arrives in pieces.',
      body: `${rough.partCount.toLocaleString()} parts define the first silhouette. Nothing is called complete just because it rendered.`,
      metric: `${rough.componentCount.toLocaleString()} loose bodies`,
    },
    {
      stage: 'candidate',
      index: '02',
      eyebrow: 'Clutch field',
      title: 'Every brick finds a legal mate.',
      body: `The refinement pass adds ${demo.delta.partsAdded.toLocaleString()} catalog-backed parts and ${demo.delta.connectionsAdded.toLocaleString()} measured connections.`,
      metric: `${good.connectionCount.toLocaleString()} mates`,
    },
    {
      stage: 'refinement',
      index: '03',
      eyebrow: 'Load path',
      title: 'The whole site takes the weight.',
      body:
        tippingMargin === null
          ? 'Every placed part reaches the support plane. The centre of mass stays inside the measured support polygon.'
          : `Every placed part reaches the support plane. The centre of mass stays inside it with ${tippingMargin.toLocaleString()} LDU of tipping margin.`,
      metric: `${good.statics.massLabel} measured`,
    },
    {
      stage: 'validated',
      index: '04',
      eyebrow: 'Signed document',
      title: 'Not a render. A build you can edit.',
      body: `${good.partCount.toLocaleString()} parts, ${good.collisionCount} collisions, ${good.componentCount} connected body and ${good.steps.toLocaleString()} verified build steps.`,
      metric: 'Kernel accepted',
    },
  ]

  const active = chapters.find((chapter) => chapter.stage === film.stage) ?? chapters[0]

  return (
    <section className="bw-assembly-section" aria-labelledby="bw-assembly-title">
      <div className="bw-assembly-film bw-film" data-assembly-stage={film.stage}>
        <div className="bw-assembly-visual bw-film-stage" data-stage={film.stage}>
          <div
            className="bw-assembly-window bw-stage bw-corners"
            role="img"
            aria-label={`A stylised brick field assembling through the ${active.eyebrow.toLowerCase()} phase.`}
          >
            <i />
            <i />
            <i />
            <i />
            <div className="bw-assembly-grid" aria-hidden="true" />
            <div className="bw-assembly-sweep" aria-hidden="true" />
            <div className="bw-assembly-brickfield" aria-hidden="true">
              {ASSEMBLY_BRICKS.map((brick) => (
                <span
                  className={`bw-assembly-brick ${brick.kind}`}
                  key={brick.id}
                  style={
                    {
                      '--bw-scatter-left': `${brick.scatterLeft}%`,
                      '--bw-scatter-top': `${brick.scatterTop}%`,
                      '--bw-target-left': `${brick.targetLeft}%`,
                      '--bw-target-top': `${brick.targetTop}%`,
                      '--bw-brick-width': `${brick.width}px`,
                      '--bw-brick-height': `${brick.height}px`,
                      '--bw-brick-rotation': `${brick.rotation}deg`,
                      '--bw-brick-delay': `${brick.delay}ms`,
                      '--bw-brick-lift': `${brick.lift}px`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div className="bw-assembly-origin" aria-hidden="true">
              <span />
              <b>0,0</b>
            </div>
            <div className="bw-assembly-hud" aria-hidden="true">
              <span>Assembly reel / live scroll</span>
              <strong>{active.metric}</strong>
            </div>
            <div className="bw-assembly-figure" aria-hidden="true">
              <span>{active.index} / 04</span>
              <b>{active.eyebrow}</b>
            </div>
          </div>

          <div className="bw-assembly-stagebar">
            <span className="bw-assembly-stagebar-label">Scroll to assemble</span>
            <div className="bw-assembly-stagebar-buttons" aria-label="Assembly phases">
              {FILM_STAGES.map((stage, index) => (
                <button
                  type="button"
                  key={stage}
                  aria-pressed={film.stage === stage}
                  onClick={() => film.setStage(stage)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {stage}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bw-film-chapters bw-assembly-chapters">
          {chapters.map((chapter, index) => (
            <article
              className="bw-film-chapter bw-assembly-chapter"
              data-film-stage={chapter.stage}
              data-active={film.stage === chapter.stage ? 'true' : 'false'}
              key={chapter.stage}
            >
              <span className="bw-section-index">
                {chapter.index} / {chapter.eyebrow}
              </span>
              {index === 0 ? (
                <h2 className="bw-display x2" id="bw-assembly-title">
                  {chapter.title}
                </h2>
              ) : (
                <h3 className="bw-display x2">{chapter.title}</h3>
              )}
              <p className="bw-lede bw-lede-short">{chapter.body}</p>
              <p className="bw-assembly-metric">
                <span aria-hidden="true" />
                {chapter.metric}
              </p>
              {chapter.stage === 'validated' ? (
                <a
                  className="bw-button primary bw-magnet"
                  href={hrefFor({ kind: 'explore', demoId: demo.id })}
                  onClick={link({ kind: 'explore', demoId: demo.id }, () =>
                    trackLanding({ name: 'demo.viewed', demoId: demo.id, surface: 'landing' }),
                  )}
                >
                  Inspect the accepted model <span className="bw-key">&rarr;</span>
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function HeroScatter() {
  return (
    <div className="bw-hero-scatter" aria-hidden="true">
      {HERO_FRAGMENTS.map((fragment) => (
        <span
          key={fragment.id}
          style={
            {
              '--bw-fragment-x': `${fragment.x}%`,
              '--bw-fragment-y': `${fragment.y}%`,
              '--bw-fragment-size': `${fragment.size}px`,
              '--bw-fragment-width': `${Math.round(fragment.size * 1.72)}px`,
              '--bw-fragment-delay': `${fragment.delay}ms`,
              '--bw-fragment-travel': `${fragment.travel}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}

interface AssemblyBrick {
  id: string
  kind: 'building' | 'path' | 'site'
  scatterLeft: number
  scatterTop: number
  targetLeft: number
  targetTop: number
  width: number
  height: number
  rotation: number
  delay: number
  lift: number
}

/** Deterministic, campus-shaped envelope masses — never random between paints. */
const ASSEMBLY_BRICKS: AssemblyBrick[] = Array.from({ length: 8 * 12 }, (_, index) => {
  const row = Math.floor(index / 12)
  const column = index % 12
  const edge = row < 2 || row > 5 || column < 2 || column > 9
  const cross = (column === 5 || column === 6 || row === 3 || row === 4) && (row + column) % 2 === 0
  const kind: AssemblyBrick['kind'] = edge ? 'building' : cross ? 'path' : 'site'
  return {
    id: `${row}-${column}`,
    kind,
    scatterLeft: ((index * 37) % 126) - 13,
    scatterTop: ((index * 53) % 132) - 16,
    targetLeft: 8 + column * 6.85 + row * 0.75,
    targetTop: 13 + row * 9.15 - column * 0.12,
    width: kind === 'building' ? 46 + ((index * 11) % 3) * 10 : kind === 'path' ? 38 : 32,
    height: kind === 'building' ? 17 + ((index * 7) % 3) * 4 : 12,
    rotation: ((index * 29) % 130) - 65,
    delay: (index % 12) * 18 + row * 12,
    lift: kind === 'building' ? 5 + ((index * 17) % 4) * 6 : 0,
  }
})

const HERO_FRAGMENTS = Array.from({ length: 18 }, (_, index) => ({
  id: index,
  x: ((index * 47) % 112) - 6,
  y: ((index * 31) % 94) + 3,
  size: 10 + ((index * 7) % 4) * 5,
  delay: index * -420,
  travel: 18 + ((index * 13) % 46),
}))

function ProofStrip({ demo }: { demo: DemoEntry }) {
  const validation = demo.validation
  return (
    <section className="bw-proof-strip" aria-label="Verified build measurements" data-testid="hero-facts">
      <Proof label="Parts" value={<CountUp value={validation.partCount} fromZero />} />
      <Proof label="Mated connections" value={<CountUp value={validation.connectionCount} fromZero />} />
      <Proof
        label="Stability"
        value={validation.statics.stable ? 'Standing' : 'Review'}
        good={validation.statics.stable}
      />
      <Proof label="Measured mass" value={validation.statics.massLabel} />
    </section>
  )
}

function Proof({ label, value, good = false }: { label: string; value: ReactNode; good?: boolean }) {
  return (
    <div className={good ? 'good' : undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function FeaturedBuilds() {
  return (
    <section className="bw-section bw-featured" aria-labelledby="bw-demos-title">
      <div className="bw-shell">
        <div className="bw-section-head bw-section-head-split">
          <div>
            <span className="bw-section-index">Built and checked</span>
            <h2 className="bw-display x2" id="bw-demos-title">
              {DEMOS.length === 1 ? 'One flagship set.' : `One flagship. ${DEMOS.length - 1} more, built the same way.`}
            </h2>
          </div>
          <a className="bw-button ghost" href={hrefFor({ kind: 'explore' })} onClick={link({ kind: 'explore' })}>
            Explore all {DEMOS.length}
          </a>
        </div>
        <div className="bw-demo-grid bw-demo-grid-featured">
          {DEMOS.slice(0, 3).map((demo, index) => (
            <DemoCard key={demo.id} demo={demo} index={index} />
          ))}
        </div>
        <ul className="bw-compact-gates" aria-label="Publication gates">
          {DEMO_MANIFEST.gates.map((gate) => (
            <li key={gate}>{gate}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function DemoCard({ demo, index }: { demo: DemoEntry; index: number }) {
  const reveal = useReveal<HTMLAnchorElement>(index * 70)
  usePointerTilt(reveal.ref)
  const target = { kind: 'explore' as const, demoId: demo.id }
  return (
    <a
      ref={reveal.ref}
      {...reveal.props}
      className={`bw-demo-card bw-lit ${reveal.props.className}`}
      data-flagship={demo.hero ? 'true' : 'false'}
      href={hrefFor(target)}
      onClick={link(target, () => trackLanding({ name: 'demo.viewed', demoId: demo.id, surface: 'landing' }))}
    >
      <figure>
        <img
          src={demo.assets.thumbnail.url}
          alt={`${demo.title}: ${demo.validation.partCount} parts, rendered offline from its compiled LDraw geometry.`}
          width={720}
          height={450}
          loading={index === 0 ? 'eager' : 'lazy'}
          decoding="async"
        />
        {demo.hero ? <span className="bw-demo-scale-badge">Five-digit-piece flagship</span> : null}
        <figcaption>{demo.discipline}</figcaption>
      </figure>
      <div className="bw-demo-body">
        <h3>{demo.title}</h3>
        <p>{demo.tagline}</p>
        <p className="bw-demo-stats">
          <span>
            <b>{demo.validation.partCount}</b> parts
          </span>
          <span>
            <b>{demo.validation.connectionCount}</b> mates
          </span>
          <span className="ok">verified</span>
        </p>
      </div>
    </a>
  )
}

function ClosingSection() {
  return (
    <section className="bw-section bw-section-close bw-simple-close" aria-labelledby="bw-close-title">
      <div className="bw-shell bw-close">
        <span className="bw-eyebrow accent">Your turn</span>
        <h2 className="bw-display x1 bw-close-mark" id="bw-close-title">
          Build at city scale.
        </h2>
        <div className="bw-hero-actions">
          <a
            className="bw-button primary bw-magnet"
            href={hrefFor({ kind: 'editor' })}
            onClick={link({ kind: 'editor' }, () => {
              trackLanding({ name: 'landing.cta_selected', cta: 'open-editor' })
              trackLanding({ name: 'editor.opened', from: 'landing', withProject: false })
            })}
          >
            Open the editor{' '}
            <span className="bw-key" aria-hidden="true">
              &rarr;
            </span>
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
        Demo assets were generated against catalog {DEMO_MANIFEST.catalogVersion} and rendered offline from compiled
        LDraw geometry.
      </p>
      <p>
        LEGO&reg; is a trademark of the LEGO Group, which does not sponsor, endorse or authorise LDraw or Brickwright.
      </p>
    </footer>
  )
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
