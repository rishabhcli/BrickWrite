import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAD_CONTENT_ATTRIBUTE,
  CAD_CONTENT_MASK_CLASS,
  CAD_CONTENT_MASK_CLASS_PATTERN,
  CAD_CONTENT_SELECTORS,
  PLATFORM_EVENT_VOCABULARY,
  PlatformAnalyticsVocabularyError,
  analyticsMaskingCoverage,
  assertEventVocabulary,
  buildAnalyticsOptions,
  cadContentBlockSelector,
  drainPlatformAnalytics,
  maskedContentProps,
  peekPlatformAnalytics,
  platformAnalyticsStatus,
  resetPlatformAnalytics,
  setPlatformAnalyticsSink,
  trackPlatformEvent,
  type PlatformAnalyticsEvent,
} from './analytics'

afterEach(() => {
  resetPlatformAnalytics()
})

describe('CAD content masking', () => {
  it('covers every registered content selector', () => {
    const coverage = analyticsMaskingCoverage()
    expect(coverage).toHaveLength(CAD_CONTENT_SELECTORS.length)
    for (const entry of coverage) {
      expect(
        entry.coveredByBlockSelector,
        `${entry.kind} (${entry.selector}) is not in the session-replay blockSelector`,
      ).toBe(true)
    }
  })

  it('names every region the brief requires masked', () => {
    const kinds = CAD_CONTENT_SELECTORS.map((entry) => entry.kind)
    for (const required of [
      'project-name',
      'project-notes',
      'project-pane',
      'design-prompt',
      'agent-chat-input',
      'agent-chat-transcript',
    ]) {
      expect(kinds).toContain(required)
    }
  })

  it('fails loudly if a selector is added to the registry but not to the config', () => {
    const stale = buildAnalyticsOptions(CAD_CONTENT_SELECTORS.slice(0, 2))
    const coverage = analyticsMaskingCoverage(stale, CAD_CONTENT_SELECTORS)
    expect(coverage.some((entry) => !entry.coveredByBlockSelector)).toBe(true)
  })

  it('blocks the mask class as well as the named selectors', () => {
    const coverage = analyticsMaskingCoverage()
    expect(coverage.every((entry) => entry.coveredByBlockClass)).toBe(true)
    expect(CAD_CONTENT_MASK_CLASS_PATTERN.test(CAD_CONTENT_MASK_CLASS)).toBe(true)
    expect(CAD_CONTENT_MASK_CLASS_PATTERN.test('pf-private-notes')).toBe(true)
    expect(CAD_CONTENT_MASK_CLASS_PATTERN.test('pf-brand pf-private')).toBe(true)
    expect(CAD_CONTENT_MASK_CLASS_PATTERN.test('pf-privateer')).toBe(false)
    expect(cadContentBlockSelector()).toContain(`.${CAD_CONTENT_MASK_CLASS}`)
  })

  it('masks every input by default, not only the ones somebody remembered', () => {
    expect(buildAnalyticsOptions().replays?.maskAllInputs).toBe(true)
    expect(buildAnalyticsOptions().replays?.enabled).toBe(true)
    expect(buildAnalyticsOptions().enabled).toBe(true)
  })

  it('gives workstreams one way to mark content, and it is the covered way', () => {
    const props = maskedContentProps('project-name')
    expect(props.className).toBe(CAD_CONTENT_MASK_CLASS)
    expect(props[CAD_CONTENT_ATTRIBUTE as 'data-brickwright-content']).toBe('project-name')
    const selector = `[${CAD_CONTENT_ATTRIBUTE}="project-name"]`
    expect(cadContentBlockSelector()).toContain(selector)
  })

  it('actually matches the DOM it claims to cover', () => {
    document.body.innerHTML = `<div ${CAD_CONTENT_ATTRIBUTE}="project-pane"><span>Secret Castle</span></div>`
    const blocked = document.querySelectorAll(cadContentBlockSelector())
    expect(blocked.length).toBe(1)
    document.body.innerHTML = ''
  })

  /*
   * Pins a verified limitation of the installed SDK.
   *
   * `blockClass`/`blockSelector` reach rrweb only. Hexclave's automatic `$click`
   * tracker reads the clicked element's `textContent` and an `elements_chain`
   * built from its ancestors, and consults no masking option — which is why the
   * DOM contract on `maskedContentProps` exists. If a future SDK teaches the
   * tracker about blocking, this test fails and the contract can be tightened.
   */
  it('still needs the DOM contract: the click tracker honours no masking option', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'node_modules/@hexclave/react/dist/esm/lib/hexclave-app/apps/implementations/event-tracker.js',
      ),
      'utf8',
    )
    expect(source, 'event-tracker.js reads the clicked element text').toContain('target.textContent')
    expect(source, 'if this now mentions blockSelector, tighten the masking contract').not.toContain('blockSelector')
    expect(source).not.toContain('maskAllInputs')
  })
})

describe('named product events', () => {
  it('buffers events and says honestly that nothing is delivering them', () => {
    expect(platformAnalyticsStatus()).toBe('buffered-no-sink')
    trackPlatformEvent({ name: 'route.viewed', route: 'landing', boot: 'none' }, 1)
    expect(peekPlatformAnalytics()).toEqual([
      { event: { name: 'route.viewed', route: 'landing', boot: 'none' }, at: 1 },
    ])
    expect(drainPlatformAnalytics()).toHaveLength(1)
    expect(peekPlatformAnalytics()).toHaveLength(0)
  })

  it('flushes the buffer into a sink the moment one is registered', () => {
    trackPlatformEvent({ name: 'auth.signed_out' }, 2)
    const sink = vi.fn()
    setPlatformAnalyticsSink(sink)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(platformAnalyticsStatus()).toBe('delivering')
    trackPlatformEvent({ name: 'auth.signed_in' }, 3)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(peekPlatformAnalytics()).toHaveLength(0)
  })

  it('bounds the buffer so an unattended session cannot grow the heap', () => {
    for (let index = 0; index < 260; index += 1) {
      trackPlatformEvent({ name: 'route.viewed', route: 'gallery', boot: 'none' }, index)
    }
    const buffered = peekPlatformAnalytics()
    expect(buffered).toHaveLength(200)
    expect(buffered[buffered.length - 1]?.at).toBe(259)
  })

  it('refuses any value outside the closed vocabulary', () => {
    const leak = { name: 'route.viewed', route: 'Secret Castle v3', boot: 'none' } as unknown as PlatformAnalyticsEvent
    expect(() => assertEventVocabulary(leak)).toThrow(PlatformAnalyticsVocabularyError)
    expect(() => trackPlatformEvent(leak)).toThrow(/outside the platform vocabulary/)
    expect(peekPlatformAnalytics()).toHaveLength(0)
  })

  it('refuses free text in any field, including ones that look innocent', () => {
    for (const leak of [
      { name: 'boot.failed', boot: 'editor', failure: 'Could not load "Millennium Falcon"' },
      { name: 'auth.restricted', restriction: 'user@example.com' },
      { name: 'route.not_installed', route: 'my-project' },
    ]) {
      expect(() => trackPlatformEvent(leak as unknown as PlatformAnalyticsEvent)).toThrow(
        PlatformAnalyticsVocabularyError,
      )
    }
  })

  it('rejects objects and arrays outright, so nothing can be nested past the check', () => {
    const nested = { name: 'auth.signed_in', extra: { projectName: 'Secret' } } as unknown as PlatformAnalyticsEvent
    expect(() => trackPlatformEvent(nested)).toThrow(PlatformAnalyticsVocabularyError)
    const listed = { name: 'auth.signed_in', ids: ['a'] } as unknown as PlatformAnalyticsEvent
    expect(() => trackPlatformEvent(listed)).toThrow(PlatformAnalyticsVocabularyError)
  })

  it('accepts numbers and booleans, which cannot carry a name', () => {
    expect(() => trackPlatformEvent({ name: 'boot.completed', boot: 'catalog', elapsedMs: 12 })).not.toThrow()
    expect(() => trackPlatformEvent({ name: 'shell.connectivity_changed', online: false })).not.toThrow()
    expect(() =>
      trackPlatformEvent({ name: 'boot.completed', boot: 'catalog', elapsedMs: Number.NaN }),
    ).toThrow(PlatformAnalyticsVocabularyError)
  })

  it('keeps the vocabulary and the event union in step', () => {
    const declared = new Set(PLATFORM_EVENT_VOCABULARY.name)
    const emitted: PlatformAnalyticsEvent[] = [
      { name: 'route.viewed', route: 'landing', boot: 'none' },
      { name: 'route.not_installed', route: 'gallery' },
      { name: 'boot.completed', boot: 'editor', elapsedMs: 1 },
      { name: 'boot.failed', boot: 'catalog', failure: 'catalog' },
      { name: 'auth.sign_in_opened', route: 'account' },
      { name: 'auth.sign_up_opened', route: 'account' },
      { name: 'auth.signed_in' },
      { name: 'auth.signed_out' },
      { name: 'auth.session_expired', route: 'projects' },
      { name: 'auth.restricted', restriction: 'email_not_verified' },
      { name: 'auth.required', route: 'projects' },
      { name: 'account.settings_opened' },
      { name: 'shell.connectivity_changed', online: true },
      { name: 'shell.recovered_from_error', route: 'landing' },
    ]
    expect(emitted.map((event) => event.name).sort()).toEqual([...declared].sort())
    for (const event of emitted) expect(() => assertEventVocabulary(event)).not.toThrow()
  })
})
