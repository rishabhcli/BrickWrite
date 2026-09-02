import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(__dirname, 'workbench.css'), 'utf8')
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('workbench chrome polish', () => {
  it('does not pin the timeline row to 0 with !important', () => {
    expect(withoutComments).not.toMatch(/\.app-shell[^{]*{[^{}]*grid-template-rows:[^;}]*!important/)
  })

  it('declares .app-shell row tracks once; live values come from workspaceRows()', () => {
    const matches = [...withoutComments.matchAll(/\.app-shell\s*\{[^{}]*grid-template-rows:/g)]
    expect(matches).toHaveLength(1)
  })

  it('gives NumberField and catalog search a workbench focus-visible ring', () => {
    expect(withoutComments).toMatch(/\.number-field:has\(:focus-visible\)\s*>\s*div\s*\{[^}]*outline:\s*2px solid var\(--cyan\)/)
    expect(withoutComments).toMatch(/\.search-field:has\(:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--cyan\)/)
  })

  it('sizes palette layout and search-clear to the 32px chip hit target', () => {
    expect(withoutComments).toMatch(/\.palette-views button\s*\{[^}]*width:\s*32px/)
    expect(withoutComments).toMatch(/\.palette-views button\s*\{[^}]*height:\s*32px/)
    expect(withoutComments).toMatch(/\.search-clear\s*\{[^}]*width:\s*32px/)
    expect(withoutComments).toMatch(/\.search-clear\s*\{[^}]*height:\s*32px/)
    expect(withoutComments).not.toMatch(/\.palette-views button\s*\{[^}]*height:\s*22px/)
  })

  it('does not clip the palette-view focus ring with overflow: hidden', () => {
    expect(withoutComments).not.toMatch(/\.palette-views\s*\{[^}]*overflow:\s*hidden/)
  })

  it('collapses tool-mode on a narrow island instead of overflowing', () => {
    expect(withoutComments).toMatch(/container-name:\s*toolbar-island/)
    expect(withoutComments).toMatch(/@container toolbar-island \(max-width: 760px\)/)
    expect(withoutComments).toMatch(/@container toolbar-island \(max-width: 560px\)/)
    expect(withoutComments).not.toMatch(/@media \(max-width:\s*1080px\)\s*\{\s*\.tool-mode em/)
    expect(withoutComments).toMatch(/\.toolbar-island \.toolrail\s*\{[^}]*flex-wrap:\s*wrap/)
  })
})
