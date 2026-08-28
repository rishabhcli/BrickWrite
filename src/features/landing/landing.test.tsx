import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEMOS } from '../../demos'
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
import { installBrowserDoubles } from './testing'

let restore: () => void

afterEach(() => {
  cleanup()
  resetLandingAnalytics()
  restore?.()
})

describe('the landing page', () => {
  beforeEach(() => {
    restore = installBrowserDoubles()
    setKnownDemoIds(DEMOS.map((demo) => demo.id))
  })

  it('has one first-level heading and the landmarks a screen reader navigates by', () => {
    render(<LandingPage />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#bw-main')
  })

  it('offers all four calls to action', () => {
    render(<LandingPage />)
    expect(screen.getByRole('link', { name: /Start a blank build/ })).toHaveAttribute('href', '/editor')
    expect(screen.getByRole('link', { name: 'Describe a build' })).toHaveAttribute('href', '/editor?intent=describe')
    expect(screen.getByRole('link', { name: `Explore ${DEMOS.length} demos` })).toHaveAttribute('href', '/explore')
    expect(screen.getByRole('link', { name: /Open the professional editor/ })).toHaveAttribute('href', '/editor')
  })

  it('links every published demo, with a described image sized to avoid layout shift', () => {
    render(<LandingPage />)
    for (const demo of DEMOS) {
      const card = screen.getByRole('link', { name: new RegExp(demo.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      expect(card).toHaveAttribute('href', hrefFor({ kind: 'explore', demoId: demo.id }))
      const image = within(card).getByRole('img')
      expect(image).toHaveAttribute('width', '720')
      expect(image).toHaveAttribute('height', '450')
      expect(image.getAttribute('alt')?.length ?? 0).toBeGreaterThan(20)
      expect(image).toHaveAttribute('src', demo.assets.thumbnail.url)
    }
  })

  it('quotes only numbers that came out of a validation run', () => {
    render(<LandingPage />)
    const hero = DEMOS.find((demo) => demo.hero)!
    const facts = screen.getByText(/mated connectors/).textContent ?? ''
    expect(facts).toContain(String(hero.validation.partCount))
    expect(facts).toContain(String(hero.validation.connectionCount))
    expect(facts).toContain(hero.validation.statics.massLabel)
    // The page must not carry social proof it cannot substantiate.
    const body = document.body.textContent ?? ''
    expect(body).not.toMatch(/\b(?:testimonial|trusted by|customers|join \d|\d+[,\d]*\+? (?:builders|users|makers))\b/i)
  })

  it('publishes the gates the demos had to clear', () => {
    render(<LandingPage />)
    const list = screen.getByRole('heading', { name: /A demo that fails the kernel/ })
    expect(list).toBeInTheDocument()
    expect(screen.getByText(/triangle-confirmed collision/)).toBeInTheDocument()
  })

  it('shows the hero stage track as tabs, all four reachable by keyboard', () => {
    render(<LandingPage />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(4)
    for (const tab of tabs) expect(tab.tagName).toBe('BUTTON')
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1)
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
  })

  it('leaves the hero on its first stage rather than animating through them', async () => {
    render(<LandingPage />)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const selected = screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(selected?.textContent).toMatch(/Brief/)
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
    expect(() => assertLandingVocabulary({ name: 'demo.viewed', demoId: 'not-a-demo', surface: 'explore' }))
      .toThrow(LandingAnalyticsVocabularyError)
    expect(() => assertLandingVocabulary({ name: 'demo.viewed', demoId: DEMOS[0].id, surface: 'explore' })).not.toThrow()
  })

  it('buffers, and says so, until a sink is registered', () => {
    trackLanding({ name: 'landing.viewed' })
    expect(peekLandingAnalytics().map((entry) => entry.event.name)).toEqual(['landing.viewed'])
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
    expect(parseRoute('/editor', '?project=x')).toEqual({ surface: 'landing', demoId: null, step: null })
  })

  it('round-trips every target it can produce', () => {
    expect(hrefFor({ kind: 'explore', demoId: 'courtyard-terrace', step: 5 })).toBe(
      '/explore?demo=courtyard-terrace&step=5',
    )
    expect(hrefFor({ kind: 'editor-project', projectId: 'doc_x' })).toBe('/editor?project=doc_x')
  })
})
