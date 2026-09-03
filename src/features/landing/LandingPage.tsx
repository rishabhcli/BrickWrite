import {
  forwardRef,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { Link as RouterLink, useInRouterContext } from 'react-router-dom'
import {
  DEMO_SUMMARIES as DEMOS,
  DEMO_SUMMARY_MANIFEST as DEMO_MANIFEST,
  getDemoSummary as getDemo,
  heroDemoSummary as heroDemo,
  type DemoSummary,
} from '../../demos/summary'
import { setKnownDemoIds, trackLanding } from './analytics'
import { Hero, type HeroStage } from './Hero'
import { hrefFor, navigate } from './navigation'
import { CountUp, PlateAtmosphere } from './plate'
import { FILM_STAGES, useFilmStage, usePointerField, useReveal } from './reveal'
import { useScrollDriver, type ScrollTrack } from './scroll'
import { StudField } from './stud-field'
import { StudPlate } from './StudPlate'
import { useReducedMotion } from '../explore/motion'
import './landing.css'
import './studio.css'

/**
 * The product front door.
 *
 * Real generated assets open the page, followed by their measured results.
 * Every product figure comes from the demo manifest and every call to action
 * resolves to an operable surface.
 */

setKnownDemoIds(DEMOS.map((demo) => demo.id))

export function LandingPage() {
  const hero = getDemo('blue-whale-monument') ?? heroDemo()
  const spotlightDemos = diverseSpotlights()
  const [spotlightId, setSpotlightId] = useState(hero.id)
  const spotlight = getDemo(spotlightId) ?? hero
  const collectionParts = DEMOS.reduce((sum, demo) => sum + demo.validation.partCount, 0)
  const reduced = useReducedMotion()
  /**
   * The page opens moving.
   *
   * This is a front door for a toy, and a still plate sells none of it. What
   * moves is choreographed rather than merely looping: one spring-settled
   * entrance, a pointer lamp over the studs, scroll-scrubbed chapters, and a
   * plate a visitor can actually build on. The toggle stays, and
   * `data-motion='paused'` still reveals every word and figure, so nothing on
   * this page is gated behind an animation — a visitor who wants it quiet
   * loses decoration, never content.
   */
  const [paused, setPaused] = useState(false)
  const motionPaused = reduced || paused
  const pointer = usePointerField<HTMLDivElement>(motionPaused)
  // One scroll listener for the page; sections opt in by property. See scroll.ts.
  const track = useScrollDriver(motionPaused)

  useEffect(() => {
    trackLanding({ name: 'landing.viewed' })
    trackLanding({ name: 'demo.viewed', demoId: hero.id, surface: 'landing' })
  }, [hero.id])

  return (
    <div
      ref={pointer.ref}
      className="bw-surface bw-landing bw-landing-simple bw-studio"
      data-motion={motionPaused ? 'paused' : 'running'}
      data-pointer={pointer.live ? 'live' : 'off'}
    >
      <PlateAtmosphere />
      <div className="bw-studs" aria-hidden="true" />
      <div id="bw-main">
        <section className="bw-studio-hero" ref={track('--bw-hero-t')} aria-labelledby="bw-hero-title">
          <div className="bw-studio-topline">
            <span>
              <i aria-hidden="true" /> {hero.validation.partCount.toLocaleString()} pieces · {hero.validation.steps}{' '}
              steps in the featured build · {DEMOS.length} megabuilds total
            </span>
            <button
              type="button"
              className="bw-motion-toggle"
              disabled={reduced}
              aria-pressed={motionPaused}
              aria-label={reduced ? 'Reduced motion enabled' : paused ? 'Resume animations' : 'Pause animations'}
              onClick={() => setPaused((value) => !value)}
            >
              <span aria-hidden="true">{motionPaused ? '▷' : 'Ⅱ'}</span>
              {reduced ? 'Reduced motion' : motionPaused ? 'Motion off' : 'Motion on'}
            </button>
          </div>
          <div className="bw-studio-intro">
            <div className="bw-studio-copy">
              <h1 id="bw-hero-title">
                Build something
                <br />
                <em>enormous.</em>
              </h1>
              <p className="bw-studio-description">
                Start with a whale, a skyline, a giant duck or an entire city block. Every piece is real, connected, and
                ready for you to change.
              </p>
              <div className="bw-hero-actions">
                <LandingLink
                  className="bw-button primary"
                  target={{ kind: 'explore' }}
                  onFollow={() => trackLanding({ name: 'landing.cta_selected', cta: 'explore-demos' })}
                >
                  Explore the megabuilds <span aria-hidden="true">↗</span>
                </LandingLink>
                <LandingLink
                  className="bw-studio-text-link"
                  target={{ kind: 'editor', blank: true }}
                  onFollow={() => {
                    trackLanding({ name: 'landing.cta_selected', cta: 'start-blank' })
                    trackLanding({ name: 'editor.opened', from: 'landing', withProject: false })
                  }}
                >
                  Start from scratch <span aria-hidden="true">↗</span>
                </LandingLink>
              </div>
              <p className="bw-studio-footnote">{collectionParts.toLocaleString()} EDITABLE PARTS. ZERO TINY DEMOS.</p>
            </div>
            <BuildConstellation demos={spotlightDemos} />
          </div>
          <div className="bw-studio-baseline">
            <a href="#bw-collection-title" className="bw-scroll-cue">
              <span aria-hidden="true">↓</span> Pick a world and make it stranger
            </a>
            <span>LANDMARKS. BUILDINGS. ANIMALS. WEIRD IDEAS.</span>
          </div>
        </section>

        <section className="bw-plate-section" aria-labelledby="bw-plate-title">
          <div className="bw-plate-head">
            <h2 id="bw-plate-title">
              Go on.
              <br />
              <em>Place a brick.</em>
            </h2>
            <p>
              The plate is building a small version of the whale on its own, one course at a time. Move onto it and it
              hands over — click any column to drop a brick of your own.
            </p>
          </div>
          <StudPlate paused={motionPaused} />
        </section>

        <section className="bw-campus-section" aria-labelledby="bw-collection-title">
          <div className="bw-campus-heading">
            <span className="bw-studio-label">01 / THE LARGE-SCALE STARTING LIBRARY</span>
            <h2 id="bw-collection-title">
              Big worlds.
              <br />
              <em>Already built.</em>
            </h2>
            <p>
              Every example clears a four-digit part-count floor, physical validation, and a verified build order.
              Choose one below, orbit it, then copy the complete model into your editor.
            </p>
          </div>
          <div className="bw-campus-layout">
            <div className="bw-simple-hero-model">
              <Hero
                key={spotlight.id}
                demo={spotlight}
                initialStage="validated"
                buildOrder
                autoPlay={!motionPaused}
                motionPaused={motionPaused}
                hideBrief
              />
            </div>
            <div className="bw-campus-notes">
              <span className="bw-studio-label">{spotlight.discipline.toUpperCase()}</span>
              <p className="bw-campus-big-number">
                {spotlight.validation.partCount.toLocaleString()}
                <span>
                  editable parts.
                  <br />
                  One enormous head start.
                </span>
              </p>
              <p>{spotlight.tagline}</p>
              <div className="bw-spotlight-picker" role="group" aria-label="Featured large builds">
                {spotlightDemos.map((demo) => (
                  <button
                    type="button"
                    key={demo.id}
                    aria-pressed={spotlight.id === demo.id}
                    onClick={() => setSpotlightId(demo.id)}
                  >
                    <span>{demo.category}</span>
                    {demo.title}
                  </button>
                ))}
              </div>
              <LandingLink
                className="bw-button primary"
                target={{ kind: 'explore', demoId: spotlight.id }}
                onFollow={() => trackLanding({ name: 'demo.viewed', demoId: spotlight.id, surface: 'landing' })}
              >
                Open this build <span aria-hidden="true">↗</span>
              </LandingLink>
              <span className="bw-campus-caption">Not a video. Drag the model, then edit a copy.</span>
            </div>
          </div>
        </section>

        <ProofStrip demo={spotlight} />
        <AssemblyFilm demo={spotlight} paused={motionPaused} track={track} />
        <FeaturedBuilds />
        <ClosingSection track={track} />
      </div>

      <Colophon />
    </div>
  )
}

function diverseSpotlights(): DemoSummary[] {
  const preferred = ['blue-whale-monument', 'sunline-suspension-bridge', 'colossal-duck', 'meridian-tower']
    .map((id) => getDemo(id))
    .filter((demo): demo is DemoSummary => Boolean(demo))
  if (preferred.length >= 4) return preferred
  const seen = new Set(preferred.map((demo) => demo.category))
  for (const demo of DEMOS) {
    if (preferred.some((entry) => entry.id === demo.id) || seen.has(demo.category)) continue
    preferred.push(demo)
    seen.add(demo.category)
    if (preferred.length === 4) break
  }
  return preferred.length ? preferred : [...DEMOS].slice(0, 4)
}

/** Four real generated assets, laid out plainly—not a mascot pretending to be the product. */
function BuildConstellation({ demos }: { demos: DemoSummary[] }) {
  return (
    <div className="bw-build-constellation" aria-label="A sample of editable large-scale builds">
      {demos.map((demo, index) => {
        const target = { kind: 'explore' as const, demoId: demo.id }
        return (
          <LandingLink
            className="bw-constellation-card"
            data-index={index}
            target={target}
            onFollow={() => trackLanding({ name: 'demo.viewed', demoId: demo.id, surface: 'landing' })}
            key={demo.id}
          >
            {/*
              The first tile is above the fold on every viewport and is the
              largest thing the page paints, so it is the LCP element. It was
              being fetched `lazy` at `low` priority, which is the deferral the
              browser applies to images it has been told are off screen. The
              other three keep it — they are the same size and only one of them
              can be the measurement.
            */}
            <img
              src={demo.assets.thumbnail.url}
              alt={`${demo.title}, ${demo.validation.partCount.toLocaleString()} editable parts.`}
              width={720}
              height={450}
              decoding={index === 0 ? 'sync' : 'async'}
              loading={index === 0 ? 'eager' : 'lazy'}
              fetchPriority={index === 0 ? 'high' : 'low'}
            />
            <span>{demo.category}</span>
            <strong>{demo.title}</strong>
            <small>{demo.validation.partCount.toLocaleString()} parts</small>
          </LandingLink>
        )
      })}
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
function AssemblyFilm({ demo, paused, track }: { demo: DemoSummary; paused: boolean; track: ScrollTrack }) {
  const film = useFilmStage(paused)
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
    <section className="bw-assembly-section" ref={track('--bw-film-t')} aria-labelledby="bw-assembly-title">
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
            <div className="bw-assembly-sweep" style={PICK_RECT} aria-hidden="true" />
            <div className="bw-assembly-brickfield" aria-hidden="true">
              <svg className="bw-assembly-mates" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {ASSEMBLY_MATES.map((mate) => (
                  <line
                    key={mate.id}
                    x1={mate.x1}
                    y1={mate.y1}
                    x2={mate.x2}
                    y2={mate.y2}
                    pathLength={1}
                    style={{ '--bw-phase': mate.phase } as CSSProperties}
                  />
                ))}
              </svg>
              {ASSEMBLY_BRICKS.map((brick) => (
                <span
                  className={`bw-assembly-brick ${brick.kind}`}
                  key={brick.id}
                  style={
                    {
                      '--bw-target-left': `${brick.targetLeft}%`,
                      '--bw-target-top': `${brick.targetTop}%`,
                      '--bw-dx': brick.scatterX,
                      '--bw-dy': brick.scatterY,
                      '--bw-spin': `${brick.spin}deg`,
                      '--bw-phase': brick.phase,
                      '--bw-brick-width': `${brick.width}px`,
                      '--bw-brick-height': `${brick.height}px`,
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
                <LandingLink
                  className="bw-button primary bw-magnet"
                  target={{ kind: 'explore', demoId: demo.id }}
                  onFollow={() => trackLanding({ name: 'demo.viewed', demoId: demo.id, surface: 'landing' })}
                >
                  Inspect the accepted model <span className="bw-key">&rarr;</span>
                </LandingLink>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

const ROWS = 8
const COLUMNS = 12

interface AssemblyBrick {
  id: string
  kind: 'building' | 'path' | 'site'
  row: number
  column: number
  /** Where the brick ends up, as a percentage of the field. */
  targetLeft: number
  targetTop: number
  /** How far from there it starts, in the same percentage points. */
  scatterX: number
  scatterY: number
  spin: number
  /** Where in the scroll this brick begins its own approach, 0 to 0.5. */
  phase: number
  width: number
  height: number
  lift: number
}

/** Deterministic, campus-shaped envelope masses — never random between paints. */
const ASSEMBLY_BRICKS: AssemblyBrick[] = Array.from({ length: ROWS * COLUMNS }, (_, index) => {
  const row = Math.floor(index / COLUMNS)
  const column = index % COLUMNS
  const edge = row < 2 || row > 5 || column < 2 || column > 9
  const cross = (column === 5 || column === 6 || row === 3 || row === 4) && (row + column) % 2 === 0
  const kind: AssemblyBrick['kind'] = edge ? 'building' : cross ? 'path' : 'site'
  const targetLeft = 8 + column * 6.85 + row * 0.75
  const targetTop = 9 + row * 11.4 - column * 0.12
  return {
    id: `${row}-${column}`,
    kind,
    row,
    column,
    targetLeft,
    targetTop,
    scatterX: ((index * 37) % 126) - 13 - targetLeft,
    scatterY: ((index * 53) % 132) - 16 - targetTop,
    spin: ((index * 29) % 130) - 65,
    // A wave across the site rather than 96 bricks landing at once.
    phase: ((row + column) / (ROWS + COLUMNS - 2)) * 0.5,
    width: kind === 'building' ? 46 + ((index * 11) % 3) * 10 : kind === 'path' ? 38 : 32,
    height: kind === 'building' ? 17 + ((index * 7) % 3) * 4 : 12,
    lift: kind === 'building' ? 5 + ((index * 17) % 4) * 6 : 0,
  }
})

/** The brick the last chapter selects, and the rect that closes onto it. */
const PICKED = ASSEMBLY_BRICKS[3 * COLUMNS + 8]
const PICK_RECT = {
  '--bw-sel-l': PICKED.targetLeft - 8,
  '--bw-sel-t': PICKED.targetTop - 7,
  '--bw-sel-r': 100 - (PICKED.targetLeft + 8),
  '--bw-sel-b': 100 - (PICKED.targetTop + 7),
} as CSSProperties

/**
 * The connectors chapter two claims exist. One line per adjacent pair along the
 * cross axes of the site, drawn between the two bricks' seated centres, struck in
 * as the scrub passes the mating band.
 */
const ASSEMBLY_MATES = ASSEMBLY_BRICKS.flatMap((brick) => {
  const at = (row: number, column: number) =>
    row < ROWS && column < COLUMNS ? ASSEMBLY_BRICKS[row * COLUMNS + column] : undefined
  const right = at(brick.row, brick.column + 1)
  const down = at(brick.row + 1, brick.column)
  const pairs = []
  // Every other pair, so the mesh reads as structure rather than as graph paper.
  if (right && (brick.row + brick.column) % 2 === 0) pairs.push(right)
  if (down && (brick.row + brick.column) % 3 === 0) pairs.push(down)
  return pairs.map((mate) => ({
    id: `${brick.id}:${mate.id}`,
    x1: brick.targetLeft,
    y1: brick.targetTop,
    x2: mate.targetLeft,
    y2: mate.targetTop,
    phase: Math.min(brick.phase, mate.phase) * 0.8,
  }))
})

function ProofStrip({ demo }: { demo: DemoSummary }) {
  const validation = demo.validation
  return (
    <section className="bw-proof-strip" aria-label="Verified build measurements" data-testid="hero-facts">
      <div className="bw-proof-figures">
        <Proof label="Parts" value={<CountUp value={validation.partCount} fromZero />} />
        <Proof label="Mated connections" value={<CountUp value={validation.connectionCount} fromZero />} />
        <Proof
          label="Stability"
          value={validation.statics.stable ? 'Standing' : 'Review'}
          good={validation.statics.stable}
        />
        <Proof label="Measured mass" value={validation.statics.massLabel} />
      </div>
      <StudField
        count={validation.partCount}
        label={`A field of ${validation.partCount.toLocaleString()} studs, one for every part in ${demo.title}.`}
      />
      <p className="bw-proof-caption">One stud for every part in {demo.title}. Not a sample — all of them.</p>
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
            <span className="bw-studio-label">03 / THE BUILD COLLECTION</span>
            <h2 className="bw-display x2" id="bw-demos-title">
              A few worlds.
              <br />
              <em>Endless starting points.</em>
            </h2>
          </div>
          <LandingLink className="bw-button ghost" target={{ kind: 'explore' }}>
            Explore all {DEMOS.length}
          </LandingLink>
        </div>
        <div className="bw-demo-grid bw-demo-grid-featured">
          {DEMOS.slice(0, 6).map((demo, index) => (
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

function DemoCard({ demo, index }: { demo: DemoSummary; index: number }) {
  const reveal = useReveal<HTMLAnchorElement>(index * 70)
  const target = { kind: 'explore' as const, demoId: demo.id }
  return (
    <LandingLink
      ref={reveal.ref}
      {...reveal.props}
      className={`bw-demo-card ${reveal.props.className}`}
      data-flagship={demo.hero ? 'true' : 'false'}
      target={target}
      onFollow={() => trackLanding({ name: 'demo.viewed', demoId: demo.id, surface: 'landing' })}
    >
      <figure>
        <img
          src={demo.assets.thumbnail.url}
          alt={`${demo.title}: ${demo.validation.partCount.toLocaleString()} parts, rendered offline from its compiled LDraw geometry.`}
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
            <b>{demo.validation.partCount.toLocaleString()}</b> parts
          </span>
          <span>
            <b>{demo.validation.connectionCount.toLocaleString()}</b> mates
          </span>
          <span className="ok">verified</span>
        </p>
      </div>
    </LandingLink>
  )
}

function ClosingSection({ track }: { track: ScrollTrack }) {
  return (
    <section
      className="bw-section bw-section-close bw-simple-close"
      ref={track('--bw-close-t')}
      aria-labelledby="bw-close-title"
    >
      <div className="bw-shell bw-close">
        <span className="bw-studio-label">START FROM SOMETHING ALREADY WORTH ORBITING.</span>
        <h2 className="bw-display x1 bw-close-mark" id="bw-close-title">
          <span className="bw-close-line">Take a giant.</span>
          <br />
          <em>Make it yours.</em>
        </h2>
        <div className="bw-hero-actions">
          <LandingLink
            className="bw-button primary bw-magnet"
            target={{ kind: 'editor' }}
            onFollow={() => {
              trackLanding({ name: 'landing.cta_selected', cta: 'open-editor' })
              trackLanding({ name: 'editor.opened', from: 'landing', withProject: false })
            }}
          >
            Open the editor{' '}
            <span className="bw-key" aria-hidden="true">
              &rarr;
            </span>
          </LandingLink>
          <LandingLink
            className="bw-studio-text-link"
            target={{ kind: 'describe' }}
            onFollow={() => trackLanding({ name: 'landing.cta_selected', cta: 'describe-build' })}
          >
            Describe another idea <span aria-hidden="true">↗</span>
          </LandingLink>
        </div>
      </div>
    </section>
  )
}

function Colophon() {
  return (
    <footer className="bw-footer bw-shell">
      <span className="bw-footer-wordmark" aria-hidden="true">
        brickwright<span>+</span>
      </span>
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

interface LandingLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'target'> {
  target: Parameters<typeof navigate>[0]
  onFollow?: () => void
}

/** Uses the router in-app and keeps a real-anchor fallback for isolated rendering. */
const LandingLink = forwardRef<HTMLAnchorElement, LandingLinkProps>(({ target, onFollow, children, ...props }, ref) => {
  const inRouter = useInRouterContext()
  const href = hrefFor(target)
  const follow = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    onFollow?.()
  }

  if (inRouter) {
    return (
      <RouterLink ref={ref} to={href} {...props} onClick={follow}>
        {children}
      </RouterLink>
    )
  }

  return (
    <a ref={ref} href={href} {...props} onClick={link(target, onFollow)}>
      {children}
    </a>
  )
})

LandingLink.displayName = 'LandingLink'

/** Intercepts a real anchor so navigation is one history entry, not a reload. */
function link(target: Parameters<typeof navigate>[0], side?: () => void) {
  return (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    side?.()
    navigate(target)
  }
}

export default LandingPage
