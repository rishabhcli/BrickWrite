import { useEffect, type ReactNode } from 'react'
import { DEMOS, DEMO_MANIFEST, heroDemo, type DemoEntry } from '../../demos'
import { setKnownDemoIds, trackLanding } from './analytics'
import { Hero } from './Hero'
import { hrefFor, navigate } from './navigation'
import { CountUp, PlateAtmosphere } from './plate'
import { usePointerField, usePointerTilt, useReveal } from './reveal'
import './landing.css'

/**
 * The product front door.
 *
 * This used to be a long scroll-controlled film with several repetitions of
 * the same proof. The product is more convincing when the model, the measured
 * result and the route into the editor are all visible together. The compact
 * page below keeps every claim tied to the published demo manifest while
 * cutting the landing experience down to three decisions: understand it,
 * inspect a real build, or start one.
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

      <div id="bw-main">
        <section className="bw-simple-hero" aria-labelledby="bw-hero-title">
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
        <FeaturedBuilds />
        <ClosingSection />
      </div>

      <Colophon />
    </div>
  )
}

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
              {DEMOS.length === 1
                ? 'One flagship set.'
                : `One flagship. ${DEMOS.length - 1} more, built the same way.`}
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
