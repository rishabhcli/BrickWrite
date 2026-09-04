import { useCallback, useMemo } from 'react'
import type { AnalyticsOptions } from '@hexclave/react'
import type { RouteId } from './contracts'

/**
 * Product analytics, with the model kept out of it.
 *
 * Brickwright's documents are the operator's own design work. Project names,
 * build notes, generation prompts and the agent transcript are content, not
 * telemetry, and none of it may leave the browser through the analytics
 * channel. Two mechanisms enforce that, because the SDK offers two channels:
 *
 *  1. Session replay (rrweb) is configured from {@link CAD_CONTENT_SELECTORS}:
 *     every marked region is blocked and every input is masked.
 *  2. Named product events are a closed vocabulary. `track()` refuses any
 *     payload whose string values are not drawn from the enums declared below,
 *     so there is no field a project name could travel in even by mistake.
 *
 * Verified against `@hexclave/react@1.0.106`: `blockClass`, `blockSelector` and
 * `maskAllInputs` are consumed only by the session-replay recorder
 * (`dist/esm/lib/hexclave-app/apps/implementations/session-replay.js`). The
 * automatic `$click` tracker in the sibling `event-tracker.js` reads
 * `target.textContent` and an `elements_chain` that includes each ancestor's
 * text, and honours no masking option at all — see the DOM contract note on
 * {@link maskedContentProps}.
 */

/** Class applied to every element that may contain CAD content. */
export const CAD_CONTENT_MASK_CLASS = 'pf-private'

/**
 * Attribute that names *what* the masked region holds.
 *
 * An attribute rather than a class so a workstream can mark a region without
 * having to know Brickwright's CSS, and so the mark is greppable.
 */
export const CAD_CONTENT_ATTRIBUTE = 'data-brickwright-content'

export type CadContentKind =
  | 'project-name'
  | 'project-notes'
  | 'project-pane'
  | 'design-prompt'
  | 'agent-chat-input'
  | 'agent-chat-transcript'
  | 'part-search-query'
  | 'share-caption'

export interface CadContentSelector {
  kind: CadContentKind
  selector: string
  /** Why this region is content and not chrome. */
  why: string
}

/**
 * The single registry of regions that hold operator content.
 *
 * Adding a row here is the only thing a workstream has to do to have its
 * content masked; `platform.css` styles nothing based on it, and
 * `analytics.test.ts` fails if a row is not covered by the shipped config.
 */
export const CAD_CONTENT_SELECTORS: readonly CadContentSelector[] = [
  {
    kind: 'project-name',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="project-name"]`,
    why: 'Operators name builds after clients, gifts and unreleased work.',
  },
  {
    kind: 'project-notes',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="project-notes"]`,
    why: 'Free prose attached to a document.',
  },
  {
    kind: 'project-pane',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="project-pane"]`,
    why: 'Lists every project the operator has, by name, in one region.',
  },
  {
    kind: 'design-prompt',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="design-prompt"]`,
    why: 'The natural-language brief a generator was given.',
  },
  {
    kind: 'agent-chat-input',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="agent-chat-input"]`,
    why: 'What the operator is typing to the agent, keystroke by keystroke.',
  },
  {
    kind: 'agent-chat-transcript',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="agent-chat-transcript"]`,
    why: 'The whole conversation, including quoted document content.',
  },
  {
    kind: 'part-search-query',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="part-search-query"]`,
    why: 'Search terms describe what is being built before it exists.',
  },
  {
    kind: 'share-caption',
    selector: `[${CAD_CONTENT_ATTRIBUTE}="share-caption"]`,
    why: 'Draft captions are written before the operator decides to publish.',
  },
]

/**
 * Matches `pf-private` and any namespaced sibling, anywhere in a class list.
 *
 * rrweb tests `blockClass` against the element's whole `class` attribute when it
 * is a RegExp, so the boundaries are explicit rather than substring luck.
 */
export const CAD_CONTENT_MASK_CLASS_PATTERN = /(?:^|\s)pf-private(?:-[a-z0-9-]+)?(?:\s|$)/

/** The `blockSelector` string handed to the session-replay recorder. */
export function cadContentBlockSelector(
  selectors: readonly CadContentSelector[] = CAD_CONTENT_SELECTORS,
): string {
  return [`.${CAD_CONTENT_MASK_CLASS}`, ...selectors.map((entry) => entry.selector)].join(', ')
}

/**
 * The `analytics` option for `HexclaveClientApp`.
 *
 * `maskAllInputs` is on even though every CAD input is also covered by the
 * registry: an unmarked input added by a future workstream should be masked by
 * default and surfaced by review, not recorded because someone forgot a row.
 */
export function buildAnalyticsOptions(
  selectors: readonly CadContentSelector[] = CAD_CONTENT_SELECTORS,
): AnalyticsOptions {
  return {
    enabled: true,
    replays: {
      enabled: true,
      maskAllInputs: true,
      blockClass: CAD_CONTENT_MASK_CLASS_PATTERN,
      blockSelector: cadContentBlockSelector(selectors),
    },
  }
}

export interface MaskingCoverage {
  kind: CadContentKind
  selector: string
  coveredByBlockSelector: boolean
  coveredByBlockClass: boolean
}

/**
 * Report, per registry row, whether the shipped config actually blocks it.
 *
 * Exists so the guarantee is checked mechanically rather than asserted in a
 * comment; `analytics.test.ts` fails the build when a row is uncovered.
 */
export function analyticsMaskingCoverage(
  options: AnalyticsOptions = buildAnalyticsOptions(),
  selectors: readonly CadContentSelector[] = CAD_CONTENT_SELECTORS,
): MaskingCoverage[] {
  const blockSelector = options.replays?.blockSelector ?? ''
  const parts = blockSelector.split(',').map((part) => part.trim()).filter(Boolean)
  const blockClass = options.replays?.blockClass
  const classCovered =
    blockClass instanceof RegExp
      ? blockClass.test(CAD_CONTENT_MASK_CLASS)
      : typeof blockClass === 'string'
        ? blockClass === CAD_CONTENT_MASK_CLASS
        : false
  return selectors.map((entry) => ({
    kind: entry.kind,
    selector: entry.selector,
    coveredByBlockSelector: parts.includes(entry.selector),
    coveredByBlockClass: classCovered,
  }))
}

/**
 * Props that mark a region as operator content.
 *
 * Spread these onto the element that *contains* the content, not onto a button
 * that wraps it. The distinction matters: session replay honours the block, but
 * Hexclave's automatic `$click` tracker reads the clicked element's text and its
 * ancestors' text and cannot be configured. So the DOM contract is: CAD content
 * is never the accessible name of an interactive element. A row in a project
 * list is a button labelled "Open project" containing a masked `<span>` with the
 * name, not a button whose text is the name.
 */
export function maskedContentProps(kind: CadContentKind): {
  className: string
  'data-brickwright-content': CadContentKind
} {
  return { className: CAD_CONTENT_MASK_CLASS, 'data-brickwright-content': kind }
}

/* --- Named product events ------------------------------------------------ */

export type BootLevelName = 'none' | 'parts' | 'catalog' | 'editor'

export type PlatformAnalyticsEvent =
  | { name: 'route.viewed'; route: RouteId; boot: BootLevelName }
  | { name: 'route.not_installed'; route: RouteId }
  /**
   * `elapsedMs` is the gate the operator actually waited on; the rest is the
   * breakdown, so a slow boot names its own cause instead of needing a repro.
   * All optional: a `boot: 'none'` route has none of these phases.
   */
  | {
      name: 'boot.completed'
      boot: BootLevelName
      elapsedMs: number
      /** Fetch, verify, parse and install of the compiled parts tier. */
      catalogMs?: number
      /** Downloading and evaluating the kernel and session chunks. */
      kernelMs?: number
      /** Restoring the operator's project, including `?project=`/`?doc=blank`. */
      sessionMs?: number
      /** Warming the meshes the restored document references. */
      geometryMs?: number
    }
  | { name: 'boot.failed'; boot: BootLevelName; failure: 'catalog' | 'kernel' | 'cancelled' | 'unknown' }
  | { name: 'auth.sign_in_opened'; route: RouteId }
  | { name: 'auth.sign_up_opened'; route: RouteId }
  | { name: 'auth.signed_in' }
  | { name: 'auth.signed_out' }
  | { name: 'auth.session_expired'; route: RouteId }
  | { name: 'auth.restricted'; restriction: 'anonymous' | 'email_not_verified' | 'restricted_by_administrator' | 'unknown' }
  | { name: 'auth.required'; route: RouteId }
  | { name: 'account.settings_opened' }
  | { name: 'shell.connectivity_changed'; online: boolean }
  | { name: 'shell.recovered_from_error'; route: RouteId }

export type PlatformAnalyticsEventName = PlatformAnalyticsEvent['name']

const ROUTE_IDS: readonly string[] = [
  'landing',
  'explore',
  'editor',
  'projects',
  'account',
  'share',
  'gallery',
  'terms',
  'privacy',
]

/**
 * Every string-valued field, with the complete set of values it may hold.
 *
 * This is what makes "no CAD content in telemetry" checkable rather than
 * aspirational: a value outside these sets is rejected before it is buffered,
 * so there is no field a project name could be smuggled through.
 */
export const PLATFORM_EVENT_VOCABULARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  name: [
    'route.viewed',
    'route.not_installed',
    'boot.completed',
    'boot.failed',
    'auth.sign_in_opened',
    'auth.sign_up_opened',
    'auth.signed_in',
    'auth.signed_out',
    'auth.session_expired',
    'auth.restricted',
    'auth.required',
    'account.settings_opened',
    'shell.connectivity_changed',
    'shell.recovered_from_error',
  ],
  route: ROUTE_IDS,
  boot: ['none', 'parts', 'catalog', 'editor'],
  failure: ['catalog', 'kernel', 'cancelled', 'unknown'],
  restriction: ['anonymous', 'email_not_verified', 'restricted_by_administrator', 'unknown'],
})

/** Raised when an event carries a value outside the closed vocabulary. */
export class PlatformAnalyticsVocabularyError extends Error {
  constructor(readonly field: string, readonly value: unknown) {
    super(
      `Analytics event field "${field}" carries a value outside the platform vocabulary. ` +
        'Named events may only hold enumerated strings, numbers and booleans, so that CAD ' +
        'content cannot travel through telemetry. Add the value to PLATFORM_EVENT_VOCABULARY ' +
        'if it is genuinely an enum, or drop the field.',
    )
    this.name = 'PlatformAnalyticsVocabularyError'
  }
}

/** Validate an event against the closed vocabulary. Throws on violation. */
export function assertEventVocabulary(event: PlatformAnalyticsEvent): void {
  for (const [field, value] of Object.entries(event as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) continue
    if (typeof value === 'boolean') continue
    if (typeof value !== 'string') throw new PlatformAnalyticsVocabularyError(field, value)
    const allowed = PLATFORM_EVENT_VOCABULARY[field]
    if (!allowed || !allowed.includes(value)) throw new PlatformAnalyticsVocabularyError(field, value)
  }
}

export interface RecordedPlatformEvent {
  event: PlatformAnalyticsEvent
  /** `Date.now()` at emission. */
  at: number
}

export type PlatformAnalyticsSink = (recorded: RecordedPlatformEvent) => void

/**
 * Delivery status, stated honestly.
 *
 * `@hexclave/react@1.0.106` produces exactly two client events — `$page-view`
 * and `$click` — and exposes no public API for custom ones; the only send path,
 * `sendAnalyticsEventBatch`, sits behind `hexclaveAppInternalsSymbol` and is
 * marked `@internal`. Named events are therefore buffered here and handed to
 * whatever sink the deployment registers. Until one is registered they go
 * nowhere, and `platformAnalyticsStatus()` says so rather than implying a
 * dashboard that does not exist.
 */
export type PlatformAnalyticsStatus = 'delivering' | 'buffered-no-sink'

const BUFFER_LIMIT = 200

let sink: PlatformAnalyticsSink | null = null
let buffer: RecordedPlatformEvent[] = []

export function setPlatformAnalyticsSink(next: PlatformAnalyticsSink | null): void {
  sink = next
  if (!next) return
  const pending = buffer
  buffer = []
  for (const recorded of pending) next(recorded)
}

export function platformAnalyticsStatus(): PlatformAnalyticsStatus {
  return sink ? 'delivering' : 'buffered-no-sink'
}

/** Read the buffer without consuming it. */
export function peekPlatformAnalytics(): readonly RecordedPlatformEvent[] {
  return buffer
}

/** Take everything buffered so far, leaving the buffer empty. */
export function drainPlatformAnalytics(): RecordedPlatformEvent[] {
  const drained = buffer
  buffer = []
  return drained
}

/** Drop the sink and the buffer. Tests use this; runtime code does not. */
export function resetPlatformAnalytics(): void {
  sink = null
  buffer = []
}

/** Emit one named event. Rejects anything outside the closed vocabulary. */
export function trackPlatformEvent(event: PlatformAnalyticsEvent, now: number = Date.now()): void {
  assertEventVocabulary(event)
  const recorded: RecordedPlatformEvent = { event, at: now }
  if (sink) {
    sink(recorded)
    return
  }
  // Bounded: an unattended session must not grow the heap forever. Oldest
  // events are dropped because the recent ones explain the current screen.
  buffer.push(recorded)
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
}

export interface PlatformAnalytics {
  track: (event: PlatformAnalyticsEvent) => void
  status: PlatformAnalyticsStatus
}

/** The hook surfaces use. There is no untyped escape hatch, deliberately. */
export function usePlatformAnalytics(): PlatformAnalytics {
  const track = useCallback((event: PlatformAnalyticsEvent) => {
    trackPlatformEvent(event)
  }, [])
  const status = platformAnalyticsStatus()
  return useMemo(() => ({ track, status }), [track, status])
}
