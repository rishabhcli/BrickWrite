import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(__dirname, 'platform.css'), 'utf8')
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('platform chrome polish', () => {
  it('gives platform nav links a cyan focus-visible ring', () => {
    expect(withoutComments).toMatch(
      /\.pf-nav__link:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--cyan/,
    )
    expect(withoutComments).toMatch(/\.pf-nav__link:focus-visible\s*\{[^}]*outline-offset:\s*2px/)
  })
})
