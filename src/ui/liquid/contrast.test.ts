import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The contrast floor, measured rather than asserted in a comment.
 *
 * `--faint` is the dimmest text colour in the product and it is used for
 * secondary labels on every surface — panel, elevated panel, and the void
 * behind the docks. A token that reads fine against one of those and fails
 * against another is the normal way this regresses, so every pairing is
 * checked rather than the one somebody had in mind.
 *
 * WCAG 2.1 AA for body text is 4.5:1.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')

/** The last declaration of a custom property in a sheet, as the cascade sees it. */
function token(source: string, name: string): string {
  const matches = [...source.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))]
  const last = matches.at(-1)
  if (!last) throw new Error(`--${name} is not declared as a hex literal`)
  return last[1]
}

const channel = (value: number) => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

const AA_BODY = 4.5

describe('--faint against every surface it lands on', () => {
  const styles = read('src/styles.css')
  const surfaces = {
    panel: token(styles, 'panel'),
    'panel-2': token(styles, 'panel-2'),
    void: token(styles, 'void'),
  }

  it.each(Object.entries(surfaces))('clears AA on %s', (_name, background) => {
    expect(contrastRatio(token(styles, 'faint'), background)).toBeGreaterThanOrEqual(AA_BODY)
  })

  it('is the same value the liquid tokens override to, so the two cannot drift', () => {
    // `html[data-theme='dark']` is only set once LiquidStage mounts. If the base
    // token and the override disagree, the difference is visible for exactly as
    // long as that takes — and everywhere LiquidStage is not mounted.
    expect(token(styles, 'faint')).toBe(token(read('src/ui/liquid/tokens.css'), 'faint'))
  })

  it('keeps the primary ink well clear of AAA on the darkest surface', () => {
    expect(contrastRatio(token(styles, 'ink'), surfaces.void)).toBeGreaterThanOrEqual(7)
  })
})

describe('--bw-faint, the landing page\u2019s own dimmest text', () => {
  const surface = read('src/features/landing/surface.css')
  const surfaces = {
    'bw-panel': token(surface, 'bw-panel'),
    'bw-panel-2': token(surface, 'bw-panel-2'),
    'bw-void': token(surface, 'bw-void'),
  }

  it.each(Object.entries(surfaces))('clears AA on %s', (_name, background) => {
    // The landing page declares its own token set. It shipped the same failing
    // value the editor did, on identical surfaces, and it uses it for 8px
    // labels — where the AA floor matters more, not less.
    expect(contrastRatio(token(surface, 'bw-faint'), background)).toBeGreaterThanOrEqual(AA_BODY)
  })

  it('matches the editor\u2019s faint, so the two token sets cannot drift apart', () => {
    expect(token(surface, 'bw-faint')).toBe(token(read('src/styles.css'), 'faint'))
  })
})

describe('the focus ring', () => {
  const styles = read('src/styles.css')

  it('does not force a radius on the controls it rings', () => {
    // A hard `border-radius: 2px` here squares off the ring on every focused
    // control in the app, rounded ones included. An outline follows the
    // element's own radius when nothing overrides it, which is what "inherited
    // radius" means in practice.
    const rule = styles.slice(styles.indexOf('button:focus-visible'))
    const block = rule.slice(0, rule.indexOf('}'))
    expect(block).toContain('outline: 2px solid var(--cyan)')
    expect(block).toContain('outline-offset: 2px')
    expect(block).not.toContain('border-radius')
  })

  it('rings every interactive element kind, not just buttons', () => {
    for (const selector of ['button:focus-visible', 'input:focus-visible', 'select:focus-visible', 'textarea:focus-visible', '[tabindex]:focus-visible']) {
      expect(styles).toContain(selector)
    }
  })
})

describe('reflow below the workbench floor', () => {
  const styles = read('src/styles.css')

  it('keeps content reachable when the viewport is narrower than the grid', () => {
    // The editor grid has a hard 1024px floor, and `overflow: hidden` on the
    // document elements meant anything past that was clipped rather than
    // scrollable — unreachable, not merely awkward. Reflow is the larger fix;
    // reachability is the part that does not require redesigning the grid.
    expect(styles).toMatch(/@media \(max-width: 1023px\) \{[^}]*html,\s*body,\s*#root \{\s*overflow: auto;/)
  })

  it('still lets the marketing surfaces opt out entirely', () => {
    // `body:has(.bw-surface)` is more specific than the media rule, so landing
    // keeps `overflow: visible` and its own zero floor.
    expect(read('src/features/landing/surface.css')).toMatch(/body:has\(\.bw-surface\)/)
  })
})
