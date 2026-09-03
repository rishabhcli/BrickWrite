import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../../ui/liquid/contrast.test'

/**
 * Every text colour on the front door, against the surface it actually lands on.
 *
 * The landing page runs four backgrounds — the dark plate, two weights of
 * paper, and a full-bleed orange close — and a colour that reads on one of them
 * is routinely illegible on another. Both ways this has regressed were silent:
 *
 *   1. `.bw-display` sets `color: var(--bw-ink)`, and `--bw-ink` is a near-white
 *      for the plate. On the collection's #e5e5d9 paper that painted the
 *      section heading at 1.03:1 — a headline nobody could see, with nothing in
 *      CI to say so.
 *   2. Muted greens picked against the plate were carried onto paper, where
 *      they measured 2.8-4.3:1.
 *
 * So this reads the stylesheet, maps each rule to the surface its selector puts
 * it on, and measures. It is deliberately a text-level check rather than a
 * rendered one: the bugs it exists to catch are authored in CSS, and a jsdom
 * render cannot resolve `var()` well enough to see them.
 *
 * WCAG 2.1 AA for body text is 4.5:1. The landing page sets nearly all of its
 * small type at 11-12px, so the body floor is the right one — not the 3:1
 * large-text allowance.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..')
const STUDIO = readFileSync(path.join(ROOT, 'src/features/landing/studio.css'), 'utf8')

const AA_BODY = 4.5

/** The four surfaces the front door paints on, as declared in studio.css. */
const PLATE = '#171d19'
const PAPER = '#ede9df'
const COLLECTION = '#e5e5d9'
const CLOSE = '#f47b52'

/**
 * Which background a rule's text lands on, from its selector.
 *
 * Order matters: the dark stage panels sit *inside* the paper sections, so they
 * have to be matched before the sections that contain them.
 */
function surfaceFor(selector: string): string | null {
  if (/\.bw-stage\b|\.bw-stage-hud|\.bw-stage-readout|\.bw-assembly|\.bw-film/.test(selector)) return null
  if (/\.bw-close\b|\.bw-close-mark|\.bw-simple-close/.test(selector)) return CLOSE
  if (/\.bw-featured\b|\.bw-demo-body|\.bw-demo-stats|\.bw-compact-gates/.test(selector)) return COLLECTION
  if (/\.bw-campus|\.bw-spotlight-picker|\.bw-proof-strip/.test(selector)) return PAPER
  if (/\.bw-studio|\.bw-plate|\.bw-build-constellation|\.bw-constellation-card/.test(selector)) return PLATE
  return null
}

/** Every `color: #rrggbb` in the sheet, with the selector that declares it. */
function declaredColors(source: string): { selector: string; color: string }[] {
  const out: { selector: string; color: string }[] = []
  // Skip @media/@keyframes preludes; those blocks' inner rules are matched on
  // their own selectors when the regex reaches them.
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim()
    const body = match[2]
    if (selector.startsWith('@') || /^\d|^from$|^to$/.test(selector)) continue
    // A rule that paints its own background carries its text on that paint, and
    // a selector alone cannot tell us what it is. Pseudo-elements are shapes,
    // not copy. Both are out of scope rather than silently mis-measured.
    if (/(?:^|[;\s])background(?:-color)?:\s*(?!transparent|none)\S/.test(body)) continue
    if (/::(?:before|after)/.test(selector)) continue
    // Buttons, badges and keycaps paint themselves; their descendants inherit
    // that paint, not the section's.
    if (/\.bw-button|\.bw-key\b|-badge\b/.test(selector)) continue
    const color = /(?:^|[;\s])color:\s*(#[0-9a-fA-F]{6})\b/.exec(body)
    if (color) out.push({ selector, color: color[1] })
  }
  return out
}

describe('landing text against the surface its selector puts it on', () => {
  const cases = declaredColors(STUDIO)
    .map((entry) => ({ ...entry, surface: surfaceFor(entry.selector) }))
    .filter((entry): entry is { selector: string; color: string; surface: string } => entry.surface !== null)

  it('checks a meaningful number of rules, so a broken matcher cannot pass silently', () => {
    expect(cases.length).toBeGreaterThan(25)
  })

  it.each(cases.map((entry) => [entry.selector, entry.color, entry.surface] as const))(
    '%s (%s) clears AA on %s',
    (_selector, color, surface) => {
      expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(AA_BODY)
    },
  )
})

describe('the ink tokens the paper sections re-point', () => {
  /** The last declaration of a custom property inside a given rule block. */
  function tokenIn(selector: string, name: string): string {
    const block = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's').exec(STUDIO)
    if (!block) throw new Error(`no rule for ${selector}`)
    const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block[1])
    if (!value) throw new Error(`--${name} is not declared in ${selector}`)
    return value[1]
  }

  // This is the mechanism, not a symptom: shared components read --bw-ink
  // directly, so the paper sections must re-point the token rather than only
  // setting `color`. If this override is removed the heading goes invisible
  // again, and no per-rule check above would notice.
  it.each([
    ['--bw-ink', PAPER],
    ['--bw-ink', COLLECTION],
    ['--bw-muted', PAPER],
    ['--bw-muted', COLLECTION],
    ['--bw-faint', PAPER],
    ['--bw-faint', COLLECTION],
  ])('%s clears AA on %s', (name, surface) => {
    const value = tokenIn('.bw-studio :is(.bw-featured, .bw-campus-section)', name.replace('--', ''))
    expect(contrastRatio(value, surface)).toBeGreaterThanOrEqual(AA_BODY)
  })

  it('keeps the plate ink on the dark stages nested inside those sections', () => {
    const value = tokenIn('.bw-studio :is(.bw-featured, .bw-campus-section) .bw-stage', 'bw-ink')
    expect(contrastRatio(value, '#1d2623')).toBeGreaterThanOrEqual(AA_BODY)
  })
})
