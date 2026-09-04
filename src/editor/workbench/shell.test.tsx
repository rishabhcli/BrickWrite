import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The shell, assembled.
 *
 * Every other test in this directory drives one panel against the real
 * controller. That leaves a gap exactly the width of `Workbench.tsx`: a panel
 * can fire the correct callback into a prop that was wired to the wrong method
 * and no unit test will notice, while the operator watches a control do
 * nothing. These mount the whole shell — real controller, real kernel, real
 * compiled catalogue — with only the WebGL viewport stubbed, and pin the
 * beginner path through it: put a brick down, select it, paint it.
 *
 * The stub records the props the viewport was handed, which is how a pointer
 * hit is replayed here: `onSelect` is the exact callback `CadViewport` invokes
 * when a click resolves to a part, so calling it exercises the real chain
 * rather than a rehearsal of it.
 */

const viewport = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))

vi.mock('../CadViewport', () => ({
  CadViewport: (props: Record<string, unknown>) => {
    viewport.props = props
    return null
  },
}))

const { cadEngine } = await import('../../cad/engine')
const { catalog } = await import('../../cad/catalog')
const { overflowBuildableSearch, restoreCatalogFixture } = await import('./paletteTestCatalog')
const { IDENTITY_BASIS } = await import('../../cad/math')
const { createEmptyDocument } = await import('../../cad/sample')
const { resetPreferences } = await import('./persistence')
const { useRegisterContribution } = await import('./ExtensionRegistry')
const { Workbench } = await import('./Workbench')
const { announceGenerationPromptReady } = await import('./promptFocus')
const { revealChrome } = await import('../../webmcp/chrome')
type PartInstance = import('../../cad/types').PartInstance

/**
 * A stand-in for the Generate contribution.
 *
 * `src/generation` owns the real one and it is lazily imported, which is the
 * whole reason the focus handoff is delicate: the shell reveals a section whose
 * field does not exist yet. This mounts one frame late on purpose, so the test
 * exercises the wait rather than a field that happened to be there already.
 */
function LateGeneratePanel() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 0)
    return () => clearTimeout(timer)
  }, [])
  useRegisterContribution({
    id: 'generation.panel',
    slot: 'panel-right',
    title: 'Generate',
    render: () =>
      ready ? (
        <div className="bw-gen">
          <textarea
            aria-label="What should be built"
            ref={(node) => {
              if (node) announceGenerationPromptReady()
            }}
          />
        </div>
      ) : (
        <div className="bw-gen" />
      ),
  })
  return null
}

const RED = 4
const GREY = 72

/** One grey brick on the ground, so "paint it red" has something to paint. */
function oneBrick() {
  const document = createEmptyDocument()
  const subassemblyId = Object.keys(document.subassemblies)[0]
  const brick: PartInstance = {
    id: 'brick',
    definitionId: '3001',
    color: GREY,
    transform: { position: [0, -24, 0], basis: IDENTITY_BASIS },
    subassemblyId,
    stepId: document.steps[0].id,
    provenance: 'human',
    protected: false,
  }
  document.parts = { brick }
  document.steps[0].partIds = ['brick']
  document.subassemblies[subassemblyId].partIds = ['brick']
  return document
}

/** Two bricks, so a click can move an existing selection rather than create one. */
function twoBricks() {
  const document = oneBrick()
  const subassemblyId = Object.keys(document.subassemblies)[0]
  document.parts = {
    a: { ...document.parts.brick, id: 'a' },
    b: { ...document.parts.brick, id: 'b', transform: { position: [120, -24, 0], basis: IDENTITY_BASIS } },
  }
  document.steps[0].partIds = ['a', 'b']
  document.subassemblies[subassemblyId].partIds = ['a', 'b']
  return document
}

function mount(contributions: readonly (() => null)[] = []) {
  render(
    <MemoryRouter initialEntries={['/editor']}>
      <Workbench contributions={contributions} />
    </MemoryRouter>,
  )
  // The guide no longer opens itself, but a session that has been sent to it
  // deliberately still has to be cleared before anything else can be reached.
  click('.welcome-start')
}

/**
 * A control, by selector.
 *
 * `getByRole(role, { name })` computes an accessible name for every candidate,
 * and the mounted palette alone contributes sixty cards' worth of buttons. That
 * pushed a cold run of this file past the default per-test timeout, so these
 * address controls by the attribute that *is* their accessible name.
 */
function control(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) throw Error(`No control matching ${selector}`)
  return element
}
const click = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector)
  if (element) fireEvent.click(element)
  return Boolean(element)
}

/** Replays the callback the viewport fires when a click resolves onto a part. */
function clickPart(partId: string) {
  const onSelect = viewport.props?.onSelect as (id: string, additive: boolean, subassembly: boolean) => void
  act(() => onSelect(partId, false, false))
}

// The swatch names its own outcome, so the selector has to as well.
const paintSwatch = (code: number) => `.swatches button[aria-label="Paint the selection ${catalog.color(code).name}"]`
const armSwatch = (code: number) => `.swatches button[aria-label="Use ${catalog.color(code).name} for the next brick"]`
const toolButton = (label: string) => `.tool-button[aria-label="${label}"]`
const partColors = () => Object.values(cadEngine.getDocument().parts).map((part) => part.color)
const sectionOpen = (id: string) =>
  document.querySelector(`[data-section="${id}"] .dock-section-toggle`)?.getAttribute('aria-expanded')

// jsdom ships no scroll implementation, and revealing a dock section scrolls it
// into view. Not a behaviour under test; without it the reveal path throws.
Element.prototype.scrollIntoView ??= () => {}

beforeEach(() => {
  resetPreferences()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/editor')
  viewport.props = null
  cadEngine.replaceDocument(oneBrick())
})
afterEach(cleanup)

describe('the first-load control budget', () => {
  /**
   * A ceiling on what a first load puts on screen.
   *
   * Every control here was defensible on its own; the editor still opened with
   * roughly seventy of them, most unable to act on anything because there was
   * no model and nothing selected. The number is a budget, not a target — it
   * exists so the next defensible control has to displace one rather than join
   * the pile. Raise it deliberately, with a reason, or don't.
   *
   * Raised from 46 to 48: Pan and Orbit joined Select/Move/Rotate/Connect as
   * explicit tool-mode buttons. Both gestures already existed as mouse
   * modifiers, which is exactly the problem — a touch or keyboard-only
   * operator had no way to reach them at all, and a mouse operator had no way
   * to discover them. Nothing displaced: the two next most cuttable things on
   * this list are the category tabs and the view cube, and both predate this
   * change and answer to their own budgets.
   */
  it('opens with a countable amount of chrome, not a cockpit', () => {
    mount()
    const interactive = [
      ...document.querySelectorAll<HTMLElement>(
        'button, select, input:not([type="file"]), [role="tab"], [role="radio"], [role="separator"][tabindex]',
      ),
    ].filter((node) => !node.closest('.parts-grid, .swatches, [hidden], [aria-hidden="true"]'))

    expect(interactive.length).toBeLessThanOrEqual(48)
    // Controls whose subject is absent are the ones that used to make up the
    // difference, so name a few explicitly rather than trusting the count.
    for (const gone of ['Remove selection', 'Command deck', 'Frame selected parts', 'Left view', 'Back view']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull()
    }
    expect(screen.queryByLabelText('Viewport render mode')).toBeNull()
  })
})

describe('the beginner path through the shell', () => {
  it('paints the selection when a palette colour is clicked', () => {
    mount()
    act(() => cadEngine.setSelection(['brick']))
    expect(partColors()).toEqual([GREY])
    expect(control('.palette-target').textContent).toMatch(/Paints 1 selected/)

    fireEvent.click(control(paintSwatch(RED)))

    expect(partColors()).toEqual([RED])
  })

  it('only arms the next brick when a colour is clicked with nothing selected', () => {
    mount()
    act(() => cadEngine.setSelection([]))
    const before = cadEngine.getDocument().revision

    expect(control('.palette-target').textContent).toMatch(/Colours the next brick/)

    fireEvent.click(control(armSwatch(RED)))

    expect(partColors()).toEqual([GREY])
    expect(cadEngine.getDocument().revision).toBe(before)
    expect(control('.palette-current strong').textContent).toBe(catalog.color(RED).name)
  })

  it('hands over the move handles as soon as a brick is clicked', () => {
    mount()
    expect(control(toolButton('Select'))).toHaveAttribute('aria-checked', 'true')

    clickPart('brick')

    // Move is the only tool that draws a manipulator, so this is the difference
    // between a selected brick you can drag and one that ignores the drag.
    expect(control(toolButton('Move'))).toHaveAttribute('aria-checked', 'true')
  })

  it('answers that first click with the Selection sheet, not the transform cockpit', () => {
    mount()

    clickPart('brick')

    expect(sectionOpen('selection')).toBe('true')
    expect(sectionOpen('transform')).toBe('false')
  })

  it('keeps the transform sheet shut when a click moves the selection along', () => {
    // The case a fresh document hides: a brick is already in hand — placing one
    // selects it — so the click that picks a different brick is not a 0 -> N
    // selection, and comparing tools alone reads the implicit hand-over to Move
    // as a deliberate reach for it.
    cadEngine.replaceDocument(twoBricks())
    mount()
    act(() => cadEngine.setSelection(['a']))

    clickPart('b')

    expect(control(toolButton('Move'))).toHaveAttribute('aria-checked', 'true')
    expect(sectionOpen('transform')).toBe('false')
  })

  it('hands over the handles after a region select too', () => {
    cadEngine.replaceDocument(twoBricks())
    mount()

    const onSelectMany = viewport.props?.onSelectMany as (ids: string[], additive: boolean) => void
    act(() => onSelectMany(['a', 'b'], false))

    expect(control(toolButton('Move'))).toHaveAttribute('aria-checked', 'true')
    expect(sectionOpen('transform')).toBe('false')
  })

  it('opens the transform sheet when Move is reached for deliberately', () => {
    mount()
    act(() => cadEngine.setSelection(['brick']))

    fireEvent.click(control(toolButton('Move')))

    expect(sectionOpen('transform')).toBe('true')
  })

  it('lands the describe route with the caret already in the prompt', async () => {
    render(
      <MemoryRouter initialEntries={['/editor']}>
        <Workbench contributions={[LateGeneratePanel]} />
      </MemoryRouter>,
    )

    // Nothing stands between the route and the field on first run any more:
    // the guide no longer opens itself, so the reveal mounts the panel and the
    // caret lands in it without a dialog to dismiss first.
    expect(document.querySelector('.welcome-guide')).toBeNull()
    expect(document.querySelector('.bw-gen textarea')).toBeNull()

    act(() => void window.dispatchEvent(new CustomEvent('brickwright:intent-describe')))
    await waitFor(() => {
      expect(document.activeElement).toBe(document.querySelector('.bw-gen textarea'))
    })
  })

  it('puts a brick down from catalog search with shift-enter', () => {
    cadEngine.replaceDocument(createEmptyDocument())
    mount()
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(0)

    const search = control('[data-catalog-search]')
    fireEvent.change(search, { target: { value: '3001' } })
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true })

    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(1)
    expect(cadEngine.getDocument().parts[Object.keys(cadEngine.getDocument().parts)[0]].definitionId).toBe('3001')
    expect(document.querySelector('.placement-bar')).toBeNull()
    expect(cadEngine.getSnapshot().selection).toHaveLength(1)
  })

  it('announces persistence on the save chip instead of hiding a failure', () => {
    mount()
    const chip = control('.save-state')
    expect(chip.getAttribute('role')).toBe('status')
    expect(chip.getAttribute('aria-live')).toBe('polite')
    expect(chip.getAttribute('aria-label')).toMatch(/Saved|In memory/)
    expect(chip.querySelector('span')?.textContent).toMatch(/Saved|In memory|Not saved/)
  })

  it('keeps mode and Esc on the tool island, and offers no screen-shape menu', () => {
    mount()
    const mode = control('[data-testid="tool-mode"]')
    expect(mode.textContent).toMatch(/SELECT/i)
    expect(mode.textContent).toMatch(/Esc returns to Select/)
    // The docks are draggable and `clampLayout` fits them to the real window.
    // Asking an operator to classify their own monitor first bought nothing.
    expect(document.querySelector('select[aria-label="Layout preset"]')).toBeNull()
    expect(document.querySelector('.statusbar')).toBeNull()
  })

  it('puts a brick down from the empty viewport in one press', () => {
    cadEngine.replaceDocument(createEmptyDocument())
    mount()
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(0)

    fireEvent.click(control('.viewport-empty button'))

    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(1)
    // Committed, not armed: an armed part leaves the viewport looking unchanged
    // until the pointer crosses it, and costs a second click to finish.
    expect(document.querySelector('.placement-bar')).toBeNull()
    expect(cadEngine.getSnapshot().selection).toHaveLength(1)
  })

  // Search, arm, land and undo used to live only in the controller suite.
  // This walks the same path through the assembled shell: the catalog field,
  // the viewport's onPlace callback, and the toolbar undo control.
  it('searches the catalog, places a brick, and undoes through the shell', () => {
    cadEngine.replaceDocument(createEmptyDocument())
    mount()
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(0)

    const search = control('[data-catalog-search]')
    fireEvent.change(search, { target: { value: '3001' } })
    expect(document.querySelector('[data-part-id="3001"]')).not.toBeNull()

    fireEvent.keyDown(search, { key: 'Enter' })
    expect(document.querySelector('.placement-bar')).not.toBeNull()
    expect(document.querySelector('[data-part-id="3001"]')?.className).toMatch(/armed/)

    const onPlace = viewport.props?.onPlace as (
      transform: { position: readonly [number, number, number]; basis: typeof IDENTITY_BASIS },
      legal?: boolean,
      reason?: string,
    ) => boolean
    act(() => {
      expect(onPlace({ position: [0, -24, 0], basis: IDENTITY_BASIS }, true, 'ground')).toBe(true)
    })

    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(1)
    expect(cadEngine.getDocument().parts[Object.keys(cadEngine.getDocument().parts)[0]].definitionId).toBe('3001')
    expect(cadEngine.getSnapshot().canUndo).toBe(true)
    expect(document.querySelector('.placement-bar')).toBeNull()

    fireEvent.click(control('button[aria-label^="Undo"]'))

    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(0)
    expect(cadEngine.getSnapshot().canUndo).toBe(false)
  })

  it('lands catalog search after the left dock has to remount', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    mount()
    expect(document.querySelector('.viewport-empty')).not.toBeNull()

    fireEvent.click(control('button[aria-label="Collapse the left panel"]'))
    expect(document.querySelector('[data-catalog-search]')).toBeNull()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    await waitFor(() => {
      expect(document.activeElement).toBe(document.querySelector('[data-catalog-search]'))
    })
  })

  it('walks catalog results from the search field and pages BUILDABLE with the next/prev buttons', () => {
    overflowBuildableSearch()
    try {
      mount()
      const search = control('[data-catalog-search]')
      expect(document.querySelector('.part-card.cursor')).toBeNull()

      fireEvent.keyDown(search, { key: 'ArrowDown' })
      expect(document.querySelector('.part-card.cursor')).not.toBeNull()
      expect(document.querySelector('[data-catalog-search]')).toBe(search)

      fireEvent.keyDown(search, { key: 'ArrowDown' })
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      const pager = document.querySelector('.parts-pager')
      expect(pager).not.toBeNull()
      const indicator = pager!.querySelector('[role="status"]')
      expect(indicator?.getAttribute('aria-live')).toBe('polite')
      expect(document.querySelectorAll('.part-card.unplaceable')).toHaveLength(0)
      const first = document.querySelector('[data-part-id]')?.getAttribute('data-part-id')
      const beforeHighlight = document.querySelector('.part-card.cursor')?.getAttribute('data-part-id')
      expect(beforeHighlight).not.toBe(first)

      const next = control('button[aria-label="Next page of results"]')
      const prev = control('button[aria-label="Previous page of results"]')
      expect((prev as HTMLButtonElement).disabled).toBe(true)
      const label = indicator?.textContent
      fireEvent.click(next)
      expect(indicator?.textContent).not.toBe(label)
      const pageFirst = document.querySelector('[data-part-id]')
      expect(pageFirst?.getAttribute('data-part-id')).not.toBe(first)
      expect(document.querySelector('.part-card.cursor')).toBe(pageFirst)
      expect((prev as HTMLButtonElement).disabled).toBe(false)
      expect((next as HTMLButtonElement).disabled).toBe(true)

      fireEvent.click(prev)
      expect(document.querySelector('[data-part-id]')?.getAttribute('data-part-id')).toBe(first)
      expect(document.querySelector('[data-catalog-search]')).toBe(search)
    } finally {
      restoreCatalogFixture()
    }
  })

  it('reveals model health as its own block without disturbing Selection', () => {
    mount()
    act(() => cadEngine.setSelection(['brick']))
    expect(sectionOpen('health')).not.toBe('true')

    act(() => {
      revealChrome('health')
    })
    expect(sectionOpen('health')).toBe('true')
    expect(document.querySelector('.model-health')).not.toBeNull()
    expect(sectionOpen('selection')).toBe('true')
  })

  // The statics pass is the expensive part of the health report, and a closed
  // block must not pay for it. The header count comes off the kernel snapshot.
  it('does not mount the health navigator while its block is shut', () => {
    mount()
    act(() => cadEngine.setSelection(['brick']))
    expect(document.querySelector('.model-health')).toBeNull()
    expect(document.querySelector('[data-section="health"] .dock-badge')).not.toBeNull()
  })

  it('offers the model map when nothing is selected, and the selection when something is', () => {
    cadEngine.replaceDocument(twoBricks())
    mount()
    fireEvent.click(control('button[title="The selected brick"]'))

    // Nothing picked: four sheets of controls with no subject help no one.
    expect(document.querySelector('[data-section="model.explorer"]')).not.toBeNull()
    expect(document.querySelector('[data-section="selection"]')).toBeNull()

    act(() => cadEngine.setSelection(['a', 'b']))
    expect(document.querySelector('[data-section="model.explorer"]')).toBeNull()
    expect(control('[data-section="selection"] .dock-badge').textContent).toBe('2')
  })

  it('places, inspects, then undoes chrome back to the empty viewport', () => {
    cadEngine.replaceDocument(createEmptyDocument())
    mount()
    expect(document.querySelector('.viewport-empty')).not.toBeNull()

    const search = control('[data-catalog-search]')
    fireEvent.change(search, { target: { value: '3001' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(document.querySelector('.placement-bar')?.getAttribute('data-legal')).toBe('pending')
    fireEvent.click(control('button[aria-label="Cancel placement"]'))
    expect(document.querySelector('.placement-bar')).toBeNull()
    expect(document.querySelector('.viewport-empty')).not.toBeNull()

    fireEvent.click(control('.viewport-empty button'))
    const partId = Object.keys(cadEngine.getDocument().parts)[0]
    expect(partId).toBeTruthy()
    expect(document.querySelector('.viewport-empty')).toBeNull()
    expect(document.querySelector('.selection-hud')).not.toBeNull()
    expect(control(toolButton('Move'))).toHaveAttribute('aria-checked', 'true')

    act(() => {
      revealChrome('inspector')
    })
    expect(control('[data-section="selection"]').textContent).toMatch(/3001/)
    expect(cadEngine.getSnapshot().selection).toEqual([partId])

    fireEvent.click(control('button[aria-label^="Undo"]'))

    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(0)
    expect(cadEngine.getSnapshot().selection).toEqual([])
    expect(document.querySelector('.viewport-empty')).not.toBeNull()
    expect(document.querySelector('.selection-hud')).toBeNull()
    expect(document.querySelector('.placement-bar')).toBeNull()
    expect(control(toolButton('Select'))).toHaveAttribute('aria-checked', 'true')
    // Nothing selected any more, so Object falls back to the model map.
    expect(document.querySelector('[data-section="model.explorer"]')).not.toBeNull()
  })

  it('names the Connect pair in the HUD the same way the Connect sheet does', () => {
    cadEngine.replaceDocument(twoBricks())
    mount()
    fireEvent.click(control(toolButton('Connect')))
    clickPart('a')
    clickPart('b')
    expect(control('.connect-panel').getAttribute('data-stage')).toBe('review')
    expect(control('.connect-panel').textContent).toMatch(/MOVING/)
    expect(control('.connect-panel').textContent).toMatch(/TARGET/)
    const hud = control('.selection-hud')
    expect(hud.querySelector('.selection-hud-name')?.textContent).toMatch(/→/)
    expect(hud.textContent).toMatch(/WORLD/)
    expect(hud.textContent).toMatch(/LDU/)
    expect(cadEngine.getSnapshot().selection).toEqual(['a'])
    expect(hud.querySelector('.selection-hud-identity')?.tagName).not.toBe('BUTTON')
  })

  it('gives Connect the whole Object panel while a mate is armed', () => {
    cadEngine.replaceDocument(twoBricks())
    mount()
    act(() => cadEngine.setSelection(['a']))
    expect(sectionOpen('selection')).toBe('true')
    fireEvent.click(control(toolButton('Connect')))
    clickPart('a')
    clickPart('b')
    expect(control('.connect-panel').getAttribute('data-stage')).toBe('review')
    expect(sectionOpen('connect')).toBe('true')
    // A two-stage flow with its own stage machine does not share the column.
    expect(document.querySelector('[data-section="selection"]')).toBeNull()
    expect(viewport.props?.highlightIds).toEqual(['b'])
    expect(viewport.props?.selection).toEqual(['a'])
    const chips = document.querySelector('[aria-label="Source connector"]')
    expect(Number(chips?.getAttribute('data-connector-count') ?? 0)).toBeGreaterThan(12)
    expect(chips?.querySelectorAll('[role="radio"]').length).toBeGreaterThan(12)
    expect(document.querySelector('.selection-hud-rotation')).not.toBeNull()
  })

  it('keeps Connect armed when switching to Design instead of cancelling the mate', () => {
    cadEngine.replaceDocument(twoBricks())
    mount()
    fireEvent.click(control(toolButton('Connect')))
    clickPart('a')
    expect(control('.connect-panel').getAttribute('data-stage')).toBe('target')
    fireEvent.click(control('button[title="Generate a build"]'))
    expect(control(toolButton('Connect'))).toHaveAttribute('aria-checked', 'true')
    expect(document.querySelector('.connect-panel')).toBeNull()
    fireEvent.click(control('button[title="The selected brick"]'))
    expect(control('.connect-panel').getAttribute('data-stage')).toBe('target')
  })

  // Mate owns the Object panel while it is armed, so a reveal of some other
  // Object surface has to disarm it — otherwise `workspace_reveal` reports
  // `applied: true` and the caller is looking at Connect.
  it('disarms an in-progress mate when another Object surface is revealed', () => {
    cadEngine.replaceDocument(twoBricks())
    mount()
    fireEvent.click(control(toolButton('Connect')))
    clickPart('a')
    expect(control('.connect-panel').getAttribute('data-stage')).toBe('target')

    act(() => {
      revealChrome('transform')
    })

    expect(document.querySelector('.connect-panel')).toBeNull()
    expect(sectionOpen('transform')).toBe('true')
    expect(control(toolButton('Connect'))).toHaveAttribute('aria-checked', 'false')
  })

  it('labels Connect chips uniquely instead of repeating the family name', () => {
    cadEngine.replaceDocument(twoBricks())
    mount()
    fireEvent.click(control(toolButton('Connect')))
    clickPart('a')
    const chips = [...document.querySelectorAll('[aria-label="Source connector"] [role="radio"]')].map(
      (node) => node.textContent?.trim(),
    )
    const named = chips.filter((label) => label && label !== 'ANY')
    expect(named.length).toBeGreaterThan(1)
    expect(new Set(named).size).toBe(named.length)
    expect(named.some((label) => /\d+,\d+/.test(label ?? ''))).toBe(true)
    expect(named.some((label) => /M\d+$/.test(label ?? ''))).toBe(false)
  })

})
