import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(__dirname, 'workbench.css'), 'utf8')
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

function atRuleBlocks(source: string, needle: string): string[] {
  const blocks: string[] = []
  let from = 0
  while (true) {
    const start = source.indexOf(needle, from)
    if (start === -1) break
    const brace = source.indexOf('{', start)
    let depth = 0
    for (let i = brace; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) {
          blocks.push(source.slice(start, i + 1))
          from = i + 1
          break
        }
      }
    }
  }
  return blocks
}

function mediaBlocks(source: string, width: string): string[] {
  return atRuleBlocks(source, `@media (max-width: ${width})`)
}

describe('workbench chrome polish', () => {
  it('does not pin the timeline row to 0 with !important', () => {
    expect(withoutComments).not.toMatch(/\.app-shell[^{]*{[^{}]*grid-template-rows:[^;}]*!important/)
  })

  it('declares .app-shell row tracks once; live values come from workspaceRows()', () => {
    const matches = [...withoutComments.matchAll(/\.app-shell\s*\{[^{}]*grid-template-rows:/g)]
    expect(matches).toHaveLength(1)
  })

  it('gives NumberField and catalog search a workbench focus-visible ring', () => {
    expect(withoutComments).toMatch(
      /\.number-field:has\(:focus-visible\)\s*>\s*div\s*\{[^}]*outline:\s*2px solid var\(--cyan\)/,
    )
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
    expect(withoutComments).toMatch(/@container toolbar-island \(max-width: 640px\)/)
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

  it('sizes island tools, history and selection popovers from the island, not the window', () => {
    const at1300 = mediaBlocks(withoutComments, '1300px')
    expect(at1300.length).toBeGreaterThan(0)
    for (const block of at1300) {
      expect(block).not.toContain('.toolbar-island')
    }
    const at1380 = mediaBlocks(withoutComments, '1380px')
    expect(at1380.length).toBeGreaterThan(0)
    for (const block of at1380) {
      expect(block).not.toContain('.toolbar-island')
      expect(block).not.toContain('.history-tools')
      expect(block).not.toContain('.topbar-nav-link span')
      expect(block).not.toContain('.save-state span')
    }
    expect(withoutComments).toMatch(/@container topbar \(max-width: 1380px\)/)
    const topbar1380 = withoutComments.indexOf('@container topbar (max-width: 1380px)')
    const sliceTopbar1380 = withoutComments.slice(topbar1380, topbar1380 + 420)
    expect(sliceTopbar1380).toContain('.topbar-nav-link span')
    expect(sliceTopbar1380).toContain('.save-state span')

    const [island760] = atRuleBlocks(withoutComments, '@container toolbar-island (max-width: 760px)')
    expect(island760).toContain('.tool-mode em')
    expect(island760).not.toContain('.history-tools')

    const [island640] = atRuleBlocks(withoutComments, '@container toolbar-island (max-width: 640px)')
    expect(island640).toContain('.history-tools')

    const island720 = withoutComments.indexOf('@container toolbar-island (max-width: 720px)')
    expect(withoutComments.slice(island720, island720 + 700)).toContain('.tool-button')
  })

  it('keeps no styling for chrome that no longer renders', () => {
    for (const dead of ['.selection-tools', '.selection-tool-count', '.selection-hud-action', '.render-direct']) {
      expect(withoutComments).not.toContain(dead)
    }
  })

  it('lets a custom open timeline read bottom.size already on the shell', () => {
    expect(withoutComments).toMatch(
      /\.app-shell\[data-timeline='open'\]\[data-bottom-size\]\s*\{[^}]*--timeline-track:\s*attr\(data-bottom-size px\)/,
    )
  })

  it('does not hide save-state at a 1220px window', () => {
    for (const block of mediaBlocks(withoutComments, '1220px')) {
      expect(block).not.toMatch(/\.save-state\s*\{[^}]*display:\s*none/)
    }
  })

  it('sizes selection-modes from the inspector, not the window', () => {
    for (const block of mediaBlocks(withoutComments, '1300px')) {
      expect(block).not.toContain('.selection-modes')
      expect(block).not.toContain('.tool-button')
    }
    expect(withoutComments).toMatch(/container-name:\s*selection-panel/)
    expect(withoutComments).toMatch(/@container selection-panel \(max-width: 280px\)/)
  })

  it('does not restyle island tools from an 1180px window', () => {
    expect(withoutComments).not.toMatch(/@media \(max-width:\s*1180px\)/)
  })

  it('lets proposal and instruction overlays shrink with the bottom stack', () => {
    expect(withoutComments).not.toMatch(/\.proposal-overlay\s*\{[^}]*min-width:\s*420px/)
    expect(withoutComments).not.toMatch(/\.instruction-overlay\s*\{[^}]*min-width:\s*390px/)
    expect(withoutComments).toMatch(/\.viewport-bottom-stack > \*\s*\{[^}]*min-width:\s*0/)
    expect(withoutComments).toMatch(/\.proposal-overlay\s*\{[^}]*min-width:\s*0/)
  })

  it('compacts placement/proposal/timeline crowding on a short viewport', () => {
    expect(withoutComments).toMatch(/container-name:\s*viewport-stage/)
    expect(withoutComments).toMatch(/@container viewport-stage \(max-height: 520px\)/)
    expect(withoutComments).toMatch(/\.app-shell\[data-timeline='open'\] \.viewport-bottom-stack/)
  })

  // The density ladder is gone with the five-sheet Object dock: one block grows,
  // the rest take their content height, and a closed one keeps its header so it
  // stays findable.
  it('lets one Object block grow and leaves closed blocks their header', () => {
    expect(withoutComments).not.toMatch(/data-object-density/)
    expect(withoutComments).toMatch(/\.right-dock-object \.dock-section\.open\.grow\s*\{[^}]*flex:\s*1 1 auto/)
    expect(withoutComments).toMatch(/\.right-dock-object \.dock-section\.closed\s*\{[^}]*flex:\s*none/)
  })

  // A plain open block let flexbox shrink it below its own content height
  // (min-height: 0), and its body had no overflow clipping — so a full-height
  // body kept painting past its own squeezed box, on top of the next block's
  // header. A grow block still needs to give up its body entirely under
  // pressure, but never below the header that names it.
  it('never lets an open Object block shrink below its own content or header', () => {
    const [openRule] = [...withoutComments.matchAll(/\.right-dock-object \.dock-section\.open\s*\{([^}]*)\}/g)].map(
      (match) => match[1],
    )
    expect(openRule).toMatch(/min-height:\s*auto;/)
    const [growRule] = [
      ...withoutComments.matchAll(/\.right-dock-object \.dock-section\.open\.grow\s*\{([^}]*)\}/g),
    ].map((match) => match[1])
    expect(growRule).toMatch(/min-height:\s*34px;/)
  })

  it('keeps four timeline tabs on one row at the laptop 124px strip', () => {
    expect(withoutComments).toMatch(/container-name:\s*timeline/)
    expect(withoutComments).toMatch(/@container timeline \(max-height: 140px\)/)
    expect(withoutComments).toMatch(/\.timeline-tab-copy/)
    const hasProposals = withoutComments.indexOf('.timeline.has-proposals .timeline-switch')
    expect(hasProposals).toBeGreaterThan(-1)
    const slice = withoutComments.slice(hasProposals, hasProposals + 420)
    expect(slice).not.toMatch(/grid-template-columns:\s*repeat\(2/)
  })

  it('keeps HUD world units on a laptop instead of hiding the fields', () => {
    const [laptop] = mediaBlocks(withoutComments, '1160px')
    expect(laptop).toContain('.selection-hud-name')
    expect(laptop).not.toMatch(/\.selection-hud-position\s*\{[^}]*display:\s*none/)
    expect(withoutComments).not.toMatch(/\.selection-hud-position \.number-field em \{ display: none/)
    expect(withoutComments).toMatch(/\.viewport-top-stack/)
    expect(withoutComments).toMatch(/\.viewport-bottom-stack/)
  })
})
