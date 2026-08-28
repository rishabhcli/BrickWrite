/**
 * Named product events for the landing and explore surfaces.
 *
 * Two rules, both enforced below rather than asserted in a comment:
 *
 *  1. **A closed vocabulary.** Every event is one of the shapes in
 *     {@link LandingAnalyticsEvent}, and every string field it carries is an
 *     enumerated value or a demo id from the shipped manifest. There is no
 *     free-text field, so nothing a visitor typed can travel out this way.
 *  2. **No invented delivery.** Until something registers a sink, events go
 *     nowhere and {@link landingAnalyticsStatus} says `buffered-no-sink`. The
 *     surfaces never display a count, a testimonial or a usage figure, because
 *     there is no measurement behind one.
 *
 * `src/platform/analytics.ts` owns the shell's own closed vocabulary and does
 * not include these, so this is a sibling channel rather than a fork of it. The
 * bridge is one function call; `docs/integration/landing.md` has it.
 */

export type LandingSurface = 'landing' | 'explore'

export type LandingAnalyticsEvent =
  | { name: 'landing.viewed' }
  | { name: 'landing.hero_stage_advanced'; stage: 'brief' | 'candidate' | 'refinement' | 'validated' }
  | { name: 'landing.cta_selected'; cta: 'start-blank' | 'describe-build' | 'explore-demos' | 'open-editor' }
  | { name: 'demo.viewed'; demoId: string; surface: LandingSurface }
  | { name: 'demo.step_scrubbed'; demoId: string; step: number }
  | { name: 'demo.view_changed'; demoId: string; view: 'solid' | 'exploded' | 'before-after' }
  | { name: 'demo.part_inspected'; demoId: string }
  | { name: 'demo.fork_started'; demoId: string; destination: 'local' | 'cloud' }
  | { name: 'demo.fork_completed'; demoId: string; destination: 'local' | 'cloud'; elapsedMs: number }
  | { name: 'demo.fork_failed'; demoId: string; destination: 'local' | 'cloud' }
  | { name: 'editor.opened'; from: LandingSurface; withProject: boolean }

export interface RecordedLandingEvent {
  event: LandingAnalyticsEvent
  at: number
}

export type LandingAnalyticsSink = (recorded: RecordedLandingEvent) => void

/** The names this module will emit. Anything else is a programming error. */
export const LANDING_EVENT_NAMES: readonly LandingAnalyticsEvent['name'][] = [
  'landing.viewed',
  'landing.hero_stage_advanced',
  'landing.cta_selected',
  'demo.viewed',
  'demo.step_scrubbed',
  'demo.view_changed',
  'demo.part_inspected',
  'demo.fork_started',
  'demo.fork_completed',
  'demo.fork_failed',
  'editor.opened',
]

const ENUMS: Record<string, readonly string[]> = {
  name: LANDING_EVENT_NAMES,
  stage: ['brief', 'candidate', 'refinement', 'validated'],
  cta: ['start-blank', 'describe-build', 'explore-demos', 'open-editor'],
  surface: ['landing', 'explore'],
  view: ['solid', 'exploded', 'before-after'],
  destination: ['local', 'cloud'],
  from: ['landing', 'explore'],
}

let knownDemoIds: ReadonlySet<string> = new Set()
let sink: LandingAnalyticsSink | null = null
let buffer: RecordedLandingEvent[] = []
const BUFFER_LIMIT = 100

/** Declares which demo ids are legal in an event. The manifest calls this. */
export function setKnownDemoIds(ids: Iterable<string>): void {
  knownDemoIds = new Set(ids)
}

export class LandingAnalyticsVocabularyError extends Error {
  constructor(field: string, value: unknown) {
    super(
      `Landing analytics field "${field}" carries ${JSON.stringify(value)}, which is outside the closed `
      + 'vocabulary. Named events may only hold enumerated strings, published demo ids, finite numbers and '
      + 'booleans, so that nothing a visitor typed can leave through telemetry.',
    )
    this.name = 'LandingAnalyticsVocabularyError'
  }
}

export function assertLandingVocabulary(event: LandingAnalyticsEvent): void {
  for (const [field, value] of Object.entries(event as Record<string, unknown>)) {
    if (typeof value === 'boolean') continue
    if (typeof value === 'number' && Number.isFinite(value)) continue
    if (typeof value !== 'string') throw new LandingAnalyticsVocabularyError(field, value)
    if (field === 'demoId') {
      if (!knownDemoIds.has(value)) throw new LandingAnalyticsVocabularyError(field, value)
      continue
    }
    const allowed = ENUMS[field]
    if (!allowed || !allowed.includes(value)) throw new LandingAnalyticsVocabularyError(field, value)
  }
}

export function setLandingAnalyticsSink(next: LandingAnalyticsSink | null): () => void {
  sink = next
  if (next) {
    const pending = buffer
    buffer = []
    for (const recorded of pending) next(recorded)
  }
  return () => {
    if (sink === next) sink = null
  }
}

export type LandingAnalyticsStatus = 'delivering' | 'buffered-no-sink'

export const landingAnalyticsStatus = (): LandingAnalyticsStatus => (sink ? 'delivering' : 'buffered-no-sink')

export const peekLandingAnalytics = (): readonly RecordedLandingEvent[] => buffer

export function resetLandingAnalytics(): void {
  sink = null
  buffer = []
}

/**
 * Emits one named event.
 *
 * Also dispatched on `window` as `brickwright:analytics`, so a deployment can
 * bridge these into whatever it already runs without importing this module.
 */
export function trackLanding(event: LandingAnalyticsEvent, now: number = Date.now()): void {
  assertLandingVocabulary(event)
  const recorded: RecordedLandingEvent = { event, at: now }
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('brickwright:analytics', { detail: recorded }))
  }
  if (sink) {
    sink(recorded)
    return
  }
  buffer.push(recorded)
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT)
}
