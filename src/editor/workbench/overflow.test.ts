import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A stylesheet footgun, guarded at the source.
 *
 * CSS does not let one axis clip while the other overflows visibly. If
 * `overflow-x` and `overflow-y` disagree and one of them is `visible`, the spec
 * computes the `visible` one to `auto` — so the element becomes a scroll
 * container on *both* axes and clips everything that leaves it.
 *
 * That cost the editor its entire Workspace menu. `.toolbar-island .toolrail`
 * declared `overflow-x: auto; overflow-y: visible`, intending "scroll sideways
 * if the tools do not fit, but let the popover escape upward". The rail clipped
 * the popover instead, and since the popover is absolutely positioned inside it,
 * every item — Command deck, Keyboard shortcuts, render mode, Export Center —
 * was unreachable at every window width. Measured with `elementFromPoint`: the
 * canvas answered for every pixel of the menu.
 *
 * There is no cheap runtime guard for this: jsdom implements no layout, so a
 * mounted component cannot report the clipping, and only a real browser can. The
 * declaration is the defect, so the declaration is what this checks — which also
 * catches it in any rule anyone writes next, not just the one that broke.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SHEETS = [
  'src/editor/workbench/workbench.css',
  'src/styles.css',
  'src/platform/platform.css',
  'src/cloud/cloud.css',
  'src/ui/liquid/material.css',
]

/**
 * Declaration blocks, with the selector that introduces them.
 *
 * Comments are stripped first, and that is not tidiness. The rule this exists
 * for now carries a comment *quoting* the offending pair — and with the comment
 * left in, the property matcher below read the quoted text instead of the real
 * declarations and reported the file clean while it was broken. Caught by
 * reintroducing the defect and watching the guard stay green.
 */
function blocks(css: string): Array<{ selector: string; body: string }> {
  const found: Array<{ selector: string; body: string }> = []
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(withoutComments)) !== null) {
    const selector = match[1].split('\n').pop()!.trim()
    if (selector.startsWith('@')) continue
    found.push({ selector, body: match[2] })
  }
  return found
}

/**
 * A declared value, or null.
 *
 * Anchored on a boundary that is not just `;`: the first declaration in a block
 * follows a `{`, and any of them can follow a newline. Requiring a semicolon was
 * the second half of why this check first reported a broken file as clean.
 */
const declared = (body: string, property: string): string | null => {
  const match = new RegExp(`(?:^|[;{\\n])\\s*${property}\\s*:\\s*([^;}]+)`, 'i').exec(body)
  return match ? match[1].trim().toLowerCase() : null
}

describe('overflow declarations', () => {
  it.each(SHEETS)('never sets one overflow axis visible against a clipping other, in %s', (sheet) => {
    const offenders: string[] = []
    for (const { selector, body } of blocks(readFileSync(path.join(ROOT, sheet), 'utf8'))) {
      const x = declared(body, 'overflow-x')
      const y = declared(body, 'overflow-y')
      if (!x || !y || x === y) continue
      if (x === 'visible' || y === 'visible') {
        offenders.push(`${selector} { overflow-x: ${x}; overflow-y: ${y} }`)
      }
    }
    expect(
      offenders,
      `These compute the \`visible\` axis to \`auto\`, so the element clips on both axes:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('recognises the exact declaration that broke the Workspace menu', () => {
    // Guards the guard: the check above is only worth having if it would have
    // caught the original.
    const offending = '.toolbar-island .toolrail { overflow-x: auto; overflow-y: visible; padding: 5px 7px; }'
    const [block] = blocks(offending)
    expect(declared(block.body, 'overflow-x')).toBe('auto')
    expect(declared(block.body, 'overflow-y')).toBe('visible')
  })

  it('accepts the legitimate pairings', () => {
    for (const pair of ['overflow-x: auto; overflow-y: auto', 'overflow-x: hidden; overflow-y: scroll']) {
      const [block] = blocks(`.x { ${pair}; }`)
      const x = declared(block.body, 'overflow-x')!
      const y = declared(block.body, 'overflow-y')!
      expect(x === 'visible' || y === 'visible').toBe(false)
    }
  })
})
