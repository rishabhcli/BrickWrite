import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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
const { IDENTITY_BASIS } = await import('../../cad/math')
const { createEmptyDocument } = await import('../../cad/sample')
const { resetPreferences } = await import('./persistence')
const { useRegisterContribution } = await import('./ExtensionRegistry')
const { Workbench } = await import('./Workbench')
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
    render: () => <div className="bw-gen">{ready ? <textarea aria-label="What should be built" /> : null}</div>,
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

const swatch = (code: number) => `.swatches button[aria-label="${catalog.color(code).name}"]`
const toolButton = (label: string) => `.tool-button[aria-label="${label}"]`
/** Lets the queued timers and animation frames the shell schedules actually run. */
const frames = () =>
  act(async () => {
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 16))
  })
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

describe('the beginner path through the shell', () => {
  it('paints the selection when a palette colour is clicked', () => {
    mount()
    act(() => cadEngine.setSelection(['brick']))
    expect(partColors()).toEqual([GREY])

    fireEvent.click(control(swatch(RED)))

    expect(partColors()).toEqual([RED])
  })

  it('only arms the next brick when a colour is clicked with nothing selected', () => {
    mount()
    act(() => cadEngine.setSelection([]))
    const before = cadEngine.getDocument().revision

    fireEvent.click(control(swatch(RED)))

    expect(partColors()).toEqual([GREY])
    expect(cadEngine.getDocument().revision).toBe(before)
    expect(control('.palette-label span').textContent).toContain(catalog.color(RED).name)
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

  it('announces persistence on the save chip instead of hiding a failure', () => {
    mount()
    const chip = control('.save-state')
    expect(chip.getAttribute('role')).toBe('status')
    expect(chip.getAttribute('aria-live')).toBe('polite')
    expect(chip.getAttribute('aria-label')).toMatch(/Saved|In memory/)
    expect(chip.querySelector('span')?.textContent).toMatch(/Saved|In memory|Not saved/)
  })

  it('keeps mode, Esc and layout-preset affordances in the existing chrome', () => {
    mount()
    const mode = control('[data-testid="tool-mode"]')
    expect(mode.textContent).toMatch(/SELECT/i)
    expect(mode.textContent).toMatch(/Esc returns to Select/)
    expect(control('select[aria-label="Layout preset"]')).not.toBeNull()
    expect(document.querySelector('.statusbar')).toBeNull()
    fireEvent.change(control('select[aria-label="Layout preset"]'), { target: { value: 'laptop' } })
    expect(document.querySelector('.app-shell')?.getAttribute('data-preset')).toBe('laptop')
    expect(document.querySelector('.app-shell')?.getAttribute('data-bottom-size')).toBe('124')
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
})
