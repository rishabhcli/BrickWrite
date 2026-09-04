import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEMOS, getDemo } from '../../demos'
import {
  assertLandingVocabulary,
  LandingAnalyticsVocabularyError,
  resetLandingAnalytics,
  peekLandingAnalytics,
  setKnownDemoIds,
  setLandingAnalyticsSink,
  trackLanding,
  type RecordedLandingEvent,
} from './analytics'
import { LandingPage } from './LandingPage'
import { hrefFor, parseRoute } from './navigation'
import { filmAccent } from './reveal'
import { installBrowserDoubles } from './testing'

let restore: () => void

afterEach(() => {
  cleanup()
  resetLandingAnalytics()
  restore?.()
  window.history.replaceState(null, '', '/')
})

describe('the landing page', () => {
  beforeEach(() => {
    restore = installBrowserDoubles()
    setKnownDemoIds(DEMOS.map((demo) => demo.id))
  })

  it('has one first-level heading, and every section is labelled', () => {
    const { container } = render(<LandingPage />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    for (const section of container.querySelectorAll('section')) {
      expect(
        section.getAttribute('aria-labelledby') ?? section.getAttribute('aria-label'),
        `${section.className} needs an accessible name`,
      ).toBeTruthy()
    }
    // The heading order steps down without skipping a level.
    const levels = [...container.querySelectorAll('h1,h2,h3')].map((heading) => Number(heading.tagName[1]))
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index] - levels[index - 1]).toBeLessThanOrEqual(1)
    }
  })

  it('leaves the banner, the main landmark and the primary nav to the shell', () => {
    // AppFrame already emits <header> and <main>; a second pair would give a
    // screen reader two of each on the same page.
    const { container } = render(<LandingPage />)
    expect(container.querySelector('header')).toBeNull()
    expect(container.querySelector('main')).toBeNull()
    expect(container.querySelector('nav')).toBeNull()
  })

  it('offers the megabuild library, the featured build and every creator handoff', () => {
    render(<LandingPage />)
    const lead = getDemo('blue-whale-monument') ?? DEMOS[0]
    expect(screen.getByRole('link', { name: /Open this build/ })).toHaveAttribute(
      'href',
      hrefFor({ kind: 'explore', demoId: lead.id }),
    )
    expect(screen.getByRole('link', { name: /Open the showcase/ })).toHaveAttribute('href', '/editor?doc=showcase')
    expect(screen.getByRole('link', { name: /Start from scratch/ })).toHaveAttribute('href', '/editor?doc=blank')
    expect(screen.getByRole('link', { name: /Describe another idea/ })).toHaveAttribute(
      'href',
      '/editor?doc=blank&intent=describe',
    )
    expect(screen.getByRole('link', { name: `Explore all ${DEMOS.length}` })).toHaveAttribute('href', '/explore')
    expect(screen.getByRole('link', { name: /Open the editor/ })).toHaveAttribute('href', '/editor')
  })

  // The landing features up to six builds, however many the collection holds.
  // Pinning the number here meant retiring a demo failed the landing tests
  // rather than the thing they exist to check: that every card it does show
  // links somewhere real and reserves its space before the image loads.
  it('links each featured demo, with described images sized to avoid layout shift', () => {
    render(<LandingPage />)
    const featured = DEMOS.slice(0, 6)
    const featuredSection = screen.getByRole('region', { name: /A few worlds/i })
    for (const demo of featured) {
      const card = within(featuredSection).getByRole('link', {
        name: new RegExp(demo.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      })
      expect(card).toHaveAttribute('href', hrefFor({ kind: 'explore', demoId: demo.id }))
      const image = within(card).getByRole('img')
      expect(image).toHaveAttribute('width', '720')
      expect(image).toHaveAttribute('height', '450')
      expect(image.getAttribute('alt')?.length ?? 0).toBeGreaterThan(20)
      expect(image).toHaveAttribute('src', demo.assets.thumbnail.url)
    }
    expect(
      within(featuredSection)
        .getAllByRole('link')
        .filter((link) => link.querySelector('img')),
    ).toHaveLength(featured.length)
  })

  it('quotes only numbers that came out of a validation run', () => {
    render(<LandingPage />)
    const hero = getDemo('blue-whale-monument') ?? DEMOS[0]
    const facts = screen.getByTestId('hero-facts').textContent ?? ''
    // Grouped as a reader sees them; what this pins is the provenance of the
    // figure, not its digit separators.
    expect(facts).toContain(hero.validation.partCount.toLocaleString())
    expect(facts).toContain(hero.validation.connectionCount.toLocaleString())
    expect(facts).toContain(hero.validation.statics.massLabel)
    // The page must not carry social proof it cannot substantiate.
    const body = document.body.textContent ?? ''
    expect(body).not.toMatch(/\b(?:testimonial|trusted by|customers|join \d|\d+[,\d]*\+? (?:builders|users|makers))\b/i)
  })

  it('publishes the gates the demos had to clear', () => {
    render(<LandingPage />)
    const gates = within(screen.getByRole('list', { name: 'Publication gates' })).getAllByRole('listitem')
    expect(gates.length).toBeGreaterThanOrEqual(5)
    expect(gates.map((item) => item.textContent).join(' ')).toMatch(/triangle-confirmed collision/)
  })

  it('shows the hero stage track as tabs, all four reachable by keyboard', () => {
    render(<LandingPage />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    for (const tab of tabs) expect(tab.tagName).toBe('BUTTON')
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  })

  it('keeps the atmosphere decorative, restores the visible cursor, and mounts the assembly reel', () => {
    const { container } = render(<LandingPage />)
    expect(container.querySelector('.bw-landing')?.getAttribute('data-pointer')).toBe('off')
    expect(container.querySelector('.bw-atmosphere')).toBeTruthy()
    expect(container.querySelector('.bw-studs')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('.bw-cursor')).toHaveLength(0)
    expect(container.querySelector('.bw-stage-hud')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.bw-stage-readout')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.bw-reticle')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).querySelector('em')?.textContent).toBe('enormous.')
    const hero = getDemo('blue-whale-monument') ?? DEMOS[0]
    expect(container.querySelector('.bw-stage-readout')?.textContent).toContain(
      hero.validation.partCount.toLocaleString(),
    )
    expect(container.querySelectorAll('.bw-stage-step')).toHaveLength(4)
    expect(container.querySelector('.bw-assembly-film')).toBeTruthy()
    expect(container.querySelectorAll('.bw-assembly-brick')).toHaveLength(96)
    expect(container.querySelector('.bw-assembly-window')?.getAttribute('role')).toBe('img')
    expect(container.querySelector('.bw-bill-rail')).toBeNull()
  })

  it('switches the compact model stage directly', () => {
    render(<LandingPage />)
    const validated = screen.getByRole('tab', { name: /Validated/ })
    fireEvent.click(validated)
    expect(validated).toHaveAttribute('aria-selected', 'true')
  })

  it('never hides the native pointer, even while pointer effects are active', () => {
    const css = readFileSync(`${__dirname}/landing.css`, 'utf8') + readFileSync(`${__dirname}/studio.css`, 'utf8')
    expect(css).not.toMatch(/cursor\s*:\s*none/)
  })

  it('opens on a diverse stack of real generated builds rather than a decorative mini model', () => {
    const { container } = render(<LandingPage />)
    const constellation = screen.getByLabelText('A sample of editable large-scale builds')
    expect(within(constellation).getAllByRole('link')).toHaveLength(4)
    expect(container.querySelector('.bw-sculpture')).toBeNull()
    expect(within(constellation).getByText('Blue Whale Monument')).toBeInTheDocument()
    expect(within(constellation).getByText('Sunline Suspension Bridge')).toBeInTheDocument()
    expect(within(constellation).getByText('Colossal Duck Float')).toBeInTheDocument()
  })

  it('opens moving, and offers stillness without hiding any content either way', () => {
    const { container } = render(<LandingPage />)
    // The front door for a toy arrives animating; the toggle is the escape hatch.
    expect(container.querySelector('.bw-studio')).toHaveAttribute('data-motion', 'running')
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Pause animations' }))
    expect(container.querySelector('.bw-studio')).toHaveAttribute('data-motion', 'paused')
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Resume animations' }))
    expect(container.querySelector('.bw-studio')).toHaveAttribute('data-motion', 'running')
  })

  it('lets a visitor scrub the assembly reel without scrolling', () => {
    const { container } = render(<LandingPage />)
    const validated = screen.getByRole('button', { name: /04\s*validated/i })
    fireEvent.click(validated)
    expect(validated).toHaveAttribute('aria-pressed', 'true')
    expect(container.querySelector('.bw-assembly-film')).toHaveAttribute('data-assembly-stage', 'validated')
  })
})

describe('with reduced motion requested', () => {
  beforeEach(() => {
    restore = installBrowserDoubles({ reducedMotion: true })
    setKnownDemoIds(DEMOS.map((demo) => demo.id))
  })

  it('reveals content immediately instead of waiting for a scroll', () => {
    const { container } = render(<LandingPage />)
    const reveals = container.querySelectorAll('.bw-reveal')
    expect(reveals.length).toBeGreaterThan(0)
    for (const element of reveals) expect(element.getAttribute('data-shown')).toBe('true')
    expect(container.querySelector('.bw-studio')).toHaveAttribute('data-motion', 'paused')
    expect(screen.getByRole('button', { name: 'Reduced motion enabled' })).toBeDisabled()
  })

  it('leaves the hero on its evidence-first stage rather than animating through them', async () => {
    render(<LandingPage />)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const selected = screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(selected?.textContent).toMatch(/Validated/)
  })
})

describe('landing analytics', () => {
  beforeEach(() => {
    resetLandingAnalytics()
    setKnownDemoIds(DEMOS.map((demo) => demo.id))
  })

  it('records the named events a mounted page produces', () => {
    restore = installBrowserDoubles()
    const seen: RecordedLandingEvent[] = []
    setLandingAnalyticsSink((recorded) => seen.push(recorded))
    render(<LandingPage />)
    expect(seen.map((entry) => entry.event.name)).toContain('landing.viewed')
    expect(seen.map((entry) => entry.event.name)).toContain('demo.viewed')
  })

  it('refuses a demo id that is not published', () => {
    expect(() => assertLandingVocabulary({ name: 'demo.viewed', demoId: 'not-a-demo', surface: 'explore' })).toThrow(
      LandingAnalyticsVocabularyError,
    )
    expect(() =>
      assertLandingVocabulary({ name: 'demo.viewed', demoId: DEMOS[0].id, surface: 'explore' }),
    ).not.toThrow()
  })

  it('buffers, and says so, until a sink is registered', () => {
    trackLanding({ name: 'landing.viewed' })
    expect(peekLandingAnalytics().map((entry) => entry.event.name)).toEqual(['landing.viewed'])
  })
})

describe('film accent', () => {
  it('walks cyan to orange to green along the reel', () => {
    expect(filmAccent(0)).toBe('rgb(131 231 238)')
    expect(filmAccent(1)).toBe('rgb(152 213 109)')
    expect(filmAccent(0.5)).toBe('rgb(245 163 63)')
  })
})

describe('deep-link parsing', () => {
  it('reads a demo and a step out of the query the surfaces write', () => {
    expect(parseRoute('/explore', '?demo=heron-sculpture&step=3')).toEqual({
      surface: 'explore',
      demoId: 'heron-sculpture',
      step: 3,
    })
  })

  it('still reads a pasted fragment link', () => {
    expect(parseRoute('/', '', '#/explore/snot-kiosk?step=2')).toEqual({
      surface: 'explore',
      demoId: 'snot-kiosk',
      step: 2,
    })
  })

  it('treats anything else as the landing page', () => {
    expect(parseRoute('/', '')).toEqual({ surface: 'landing', demoId: null, step: null })
    expect(parseRoute('/', '?beat=validated')).toEqual({ surface: 'landing', demoId: null, step: null })
    expect(parseRoute('/editor', '?project=x')).toEqual({ surface: 'landing', demoId: null, step: null })
  })

  it('round-trips every target it can produce', () => {
    expect(hrefFor({ kind: 'explore', demoId: 'courtyard-terrace', step: 5 })).toBe(
      '/explore?demo=courtyard-terrace&step=5',
    )
    expect(hrefFor({ kind: 'editor-project', projectId: 'doc_x' })).toBe('/editor?project=doc_x')
  })
})
