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

  it('sizes island icons on the island container, not the window', () => {
    expect(withoutComments).toMatch(/container-name:\s*topbar/)
    expect(withoutComments).toMatch(/@container toolbar-island \(max-width: 720px\)/)
    const media1080 = withoutComments.indexOf('@media (max-width: 1080px)')
    expect(media1080).toBeGreaterThan(-1)
    const mediaSlice = withoutComments.slice(media1080, media1080 + 220)
    expect(mediaSlice).not.toContain('.icon-button')
    expect(mediaSlice).not.toContain('.render-direct')
    const islandQuery = withoutComments.indexOf('@container toolbar-island (max-width: 720px)')
    expect(islandQuery).toBeGreaterThan(-1)
    expect(withoutComments.slice(islandQuery, islandQuery + 320)).toContain('.icon-button')
  })

  it('opens the CSS timeline fallback when the shell is marked open', () => {
    expect(withoutComments).toMatch(/\.app-shell\[data-timeline='open'\]/)
    expect(withoutComments).toMatch(/--timeline-track:\s*152px/)
  })
})
