import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { catalog } from '../../cad/catalog'
import { cadEngine } from '../../cad/engine'
import { getPartBounds } from '../../cad/geometry'
import { IDENTITY_BASIS } from '../../cad/math'
import {createEmptyDocument} from '../../cad/sample'
import { createRoverDocument } from '../../cad/__fixtures__/rover'
import { CommandPalette } from './CommandPalette'
import { PalettePanel } from './PalettePanel'
import * as catalogLoader from '../../cad/catalog-loader'
import { SelectionPanel } from './SelectionPanel'
import { TransformPanel } from './TransformPanel'
import { defaultShortcutMap, formatChord } from './shortcuts'
import { resetPreferences, writePreference } from './persistence'
import { overflowBuildableSearch, restoreCatalogFixture } from './paletteTestCatalog'
import { useWorkbench, type Workbench } from './useWorkbench'

/**
 * Panel behaviour, against the real controller and the real kernel.
 *
 * These deliberately do not stub `useWorkbench`: a transform panel that fires
 * the right callback but never reaches the command bus is exactly the kind of
 * regression a stubbed test cannot see. The fixture catalogue is a genuine
 * slice of the compiled library, so the parts, connectors and colours are real.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  resetPreferences()
  cadEngine.replaceDocument(createRoverDocument())
  // The showcase declares a hard 10 x 14 stud envelope and a piece budget. Both
  // are real kernel gates — proved elsewhere — but they would refuse the large
  // deliberate moves these panel tests make, so they are lifted first.
  const constraints = cadEngine.getDocument().constraints
  if (constraints.length) {
    cadEngine.execute(
      'Lift design constraints for the panel fixture',
      constraints.map((constraint) => ({ type: 'constraint.remove' as const, constraintId: constraint.id })),
      'human',
    )
  }
})

/** Three showcase parts with genuinely different X extents, so align has work. */
function spreadPartIds(): string[] {
  const parts = Object.values(cadEngine.getDocument().parts)
  const seen = new Map<number, string>()
  for (const part of parts) {
    const key = Math.round(getPartBounds(part).min[0])
    if (!seen.has(key)) seen.set(key, part.id)
  }
  return [...seen.values()].slice(0, 3)
}

function Harness({ children }: { children: (workbench: Workbench) => ReactNode }) {
  const workbench = useWorkbench()
  return <>{children(workbench)}</>
}

const showcasePartIds = () => Object.keys(cadEngine.getDocument().parts)
const select = (ids: string[]) => act(() => cadEngine.setSelection(ids))
const revision = () => cadEngine.getSnapshot().document.revision

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

describe('palette', () => {
  const renderPalette = (overrides: Partial<React.ComponentProps<typeof PalettePanel>> = {}) => {
    const onArm = vi.fn()
    const onAdd = vi.fn()
    const onColorChange = vi.fn()
    const view = render(
      <PalettePanel
        activeColor={15}
        armedId={null}
        onArm={onArm}
        onAdd={onAdd}
        onColorChange={onColorChange}
        {...overrides}
      />,
    )
    return { ...view, onArm, onAdd, onColorChange }
  }

  it('renders buildable parts from the compiled catalogue', () => {
    const { container } = renderPalette()
    expect(container.querySelectorAll('.part-card').length).toBeGreaterThan(10)
    expect(container.querySelectorAll('.part-thumb img').length).toBeGreaterThan(10)
  })

  it('faces the catalogue by knowledge tier', () => {
    renderPalette()
    fireEvent.click(screen.getByRole('button', { name: /FILTERS/ }))
    const tabs = screen
      .getAllByRole('tab')
      .filter((tab) => /BUILDABLE|MODELLED|CATALOGUED|EVERYTHING/.test(tab.textContent ?? ''))
    expect(tabs).toHaveLength(4)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  })

  it('narrows the grid as the query narrows', () => {
    const { container } = renderPalette()
    const before = container.querySelectorAll('.part-card').length
    fireEvent.change(screen.getByLabelText('Search parts'), { target: { value: 'brick 2 x 4' } })
    const after = container.querySelectorAll('.part-card').length
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
    expect(container.querySelector('.part-copy strong')?.textContent).toMatch(/2 x 4|2 × 4/i)
  })

  it('arms the highlighted result from the keyboard alone', () => {
    const { onArm } = renderPalette()
    const search = screen.getByLabelText('Search parts')
    fireEvent.change(search, { target: { value: '3001' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onArm).toHaveBeenCalledTimes(1)
    expect(onArm.mock.calls[0][0].id).toBe('3001')
  })

  it('adds immediately on shift-enter rather than arming', () => {
    const { onArm, onAdd } = renderPalette()
    const search = screen.getByLabelText('Search parts')
    fireEvent.change(search, { target: { value: '3001' } })
    fireEvent.keyDown(search, { key: 'Enter', shiftKey: true })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onArm).not.toHaveBeenCalled()
  })

  it('pages BUILDABLE with the next/prev buttons, and resets the cursor onto the new page', () => {
    overflowBuildableSearch()
    try {
      const { container } = renderPalette()
      const pager = container.querySelector('.parts-pager')
      expect(pager).not.toBeNull()
      const indicator = pager?.querySelector('[role="status"]')
      expect(indicator?.getAttribute('aria-live')).toBe('polite')
      expect(container.querySelectorAll('.part-card.unplaceable')).toHaveLength(0)
      expect(screen.queryByRole('tab', { name: /EVERYTHING/ })).toBeNull()

      const next = screen.getByRole('button', { name: 'Next page of results' })
      const prev = screen.getByRole('button', { name: 'Previous page of results' })
      expect(prev).toBeDisabled()
      expect(next).not.toBeDisabled()

      const search = screen.getByLabelText('Search parts')
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      const beforeHighlight = container.querySelector('.part-card.cursor')?.getAttribute('data-part-id')
      const first = container.querySelector('[data-part-id]')?.getAttribute('data-part-id')
      expect(beforeHighlight).not.toBe(first)

      const label = indicator?.textContent
      fireEvent.click(next)
      expect(indicator?.textContent).not.toBe(label)
      const pageFirst = container.querySelector('[data-part-id]')
      expect(pageFirst?.getAttribute('data-part-id')).not.toBe(first)
      expect(container.querySelector('.part-card.cursor')).toBe(pageFirst)
      expect(prev).not.toBeDisabled()
      expect(next).toBeDisabled()

      fireEvent.click(prev)
      expect(container.querySelector('[data-part-id]')?.getAttribute('data-part-id')).toBe(first)
      expect(container.querySelector('.part-card.cursor')?.getAttribute('data-part-id')).toBe(first)
      expect(prev).toBeDisabled()

      fireEvent.keyDown(search, { key: 'PageDown' })
      expect(container.querySelector('[data-part-id]')?.getAttribute('data-part-id')).not.toBe(first)
      fireEvent.keyDown(search, { key: 'PageUp' })
      expect(container.querySelector('[data-part-id]')?.getAttribute('data-part-id')).toBe(first)
    } finally {
      restoreCatalogFixture()
    }
  })

  it('does not invent a keyboard cursor when paging with the mouse', () => {
    overflowBuildableSearch()
    try {
      const { container } = renderPalette()
      expect(container.querySelector('.part-card.cursor')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Next page of results' }))
      expect(container.querySelector('.part-card.cursor')).toBeNull()
    } finally {
      restoreCatalogFixture()
    }
  })

  it('pages a favourites set that overflows one page', () => {
    overflowBuildableSearch()
    writePreference(
      'palette.favourites.v1',
      catalog.placeable().map((part) => part.canonicalId),
    )
    try {
      const { container } = renderPalette()
      fireEvent.click(screen.getByRole('button', { name: /FILTERS/ }))
      fireEvent.click(screen.getByRole('tab', { name: /FAVOURITES/ }))
      const pager = container.querySelector('.parts-pager')
      expect(pager).not.toBeNull()
      expect(pager?.getAttribute('aria-label')).toBe('Favourites pages')
      const indicator = pager?.querySelector('[role="status"]')
      expect(indicator?.getAttribute('aria-live')).toBe('polite')
      expect(container.querySelectorAll('.part-card').length).toBe(60)
      expect(container.querySelectorAll('.part-card.unplaceable')).toHaveLength(0)
      const first = container.querySelector('[data-part-id]')?.getAttribute('data-part-id')
      const label = indicator?.textContent
      fireEvent.click(screen.getByRole('button', { name: 'Next page of results' }))
      expect(indicator?.textContent).not.toBe(label)
      expect(container.querySelector('[data-part-id]')?.getAttribute('data-part-id')).not.toBe(first)
      const search = screen.getByLabelText('Search parts')
      fireEvent.keyDown(search, { key: 'PageUp' })
      expect(container.querySelector('[data-part-id]')?.getAttribute('data-part-id')).toBe(first)
    } finally {
      restoreCatalogFixture()
    }
  })

  it('collects favourites into their own set', () => {
    const { container } = renderPalette()
    fireEvent.click(screen.getByRole('button', { name: /FILTERS/ }))
    const favouritesTab = screen.getByRole('tab', { name: /FAVOURITES/ })
    expect(favouritesTab.getAttribute('disabled')).not.toBeNull()
    fireEvent.click(container.querySelectorAll('.part-favourite')[0])
    expect(screen.getByRole('tab', { name: /FAVOURITES/ }).textContent).toContain('1')
    fireEvent.click(screen.getByRole('tab', { name: /FAVOURITES/ }))
    expect(container.querySelectorAll('.part-card').length).toBe(1)
  })

  it('gives category chips a real button type', () => {
    const { container } = renderPalette()
    const chips = [...container.querySelectorAll('.category-row button')]
    expect(chips.length).toBeGreaterThan(3)
    expect(chips.every((chip) => chip.getAttribute('type') === 'button')).toBe(true)
  })

  it('switches between card and list layouts', () => {
    const { container } = renderPalette()
    expect(container.querySelector('.parts-grid')?.className).toContain('view-card')
    fireEvent.click(screen.getByRole('radio', { name: 'List view' }))
    expect(container.querySelector('.parts-grid')?.className).toContain('view-list')
  })

  it('exposes facets for size, connector family and colour availability', () => {
    renderPalette()
    fireEvent.click(screen.getByRole('button', { name: /FILTERS/ }))
    expect(screen.getByLabelText('Footprint')).not.toBeNull()
    expect(screen.getByLabelText('Connector')).not.toBeNull()
    expect(screen.getByRole('switch')).not.toBeNull()
  })

  it('filters by connector family through the compiled metadata', () => {
    const { container } = renderPalette()
    const before = container.querySelectorAll('.part-card').length
    fireEvent.click(screen.getByRole('button', { name: /FILTERS/ }))
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'clip' } })
    const after = container.querySelectorAll('.part-card').length
    expect(after).toBeLessThan(before)
  })

  it('picks up with the pointer and emits live platform coordinates', () => {
    const onDragPart = vi.fn(() => true)
    const { container } = renderPalette({ onDragPart })
    const card = container.querySelector('.part-card') as HTMLElement
    const live = vi.fn()
    window.addEventListener('brickwright:part-drag', live)
    fireEvent.pointerDown(card, { pointerId: 7, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 40, clientY: 50 })
    expect(onDragPart).toHaveBeenCalledTimes(1)
    expect(live).toHaveBeenCalledTimes(1)
    expect((live.mock.calls[0][0] as CustomEvent).detail).toEqual({ clientX: 40, clientY: 50 })
    window.removeEventListener('brickwright:part-drag', live)
  })

  it('explains an empty result instead of showing a blank grid', () => {
    renderPalette()
    fireEvent.change(screen.getByLabelText('Search parts'), { target: { value: 'zzzz-not-a-real-part' } })
    expect(screen.getByText(/Nothing matches/)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Search every identity' })).not.toBeNull()
  })

  it('returns the keyboard to search after the query is cleared', () => {
    renderPalette()
    const search = screen.getByLabelText('Search parts') as HTMLInputElement
    fireEvent.change(search, { target: { value: '3001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
  })

  it('clears a query from Escape without leaving the field', () => {
    renderPalette()
    const search = screen.getByLabelText('Search parts') as HTMLInputElement
    search.focus()
    fireEvent.change(search, { target: { value: '3001' } })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
  })

  it('retries a failed wider-catalogue fetch from the panel', async () => {
    vi.spyOn(catalog, 'catalogueLoaded', 'get').mockReturnValue(false)
    vi.spyOn(catalogLoader, 'externalCatalogueAvailable').mockReturnValue(true)
    const load = vi.spyOn(catalogLoader, 'loadExternalCatalogue')
    load.mockRejectedValueOnce(new Error('offline'))
    renderPalette()
    fireEvent.click(screen.getByRole('button', { name: /FILTERS/ }))
    fireEvent.click(screen.getByRole('tab', { name: /CATALOGUED/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i))
    load.mockResolvedValueOnce(5812)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(load).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Transform controls
// ---------------------------------------------------------------------------

describe('transform controls', () => {
  const renderTransform = () => render(<Harness>{(w) => <TransformPanel workbench={w} />}</Harness>)

  it('states its scope and disables the steppers with nothing selected', () => {
    renderTransform()
    expect(screen.getByText('No selection')).not.toBeNull()
    expect((screen.getByLabelText('Nudge X positive') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the selected part’s exact pose', () => {
    const id = showcasePartIds()[0]
    const part = cadEngine.getDocument().parts[id]
    renderTransform()
    select([id])
    const field = screen.getByLabelText('X in LDraw units') as HTMLInputElement
    expect(Number(field.value)).toBeCloseTo(part.transform.position[0], 4)
  })

  it('commits a typed coordinate through the command bus', () => {
    const id = showcasePartIds()[0]
    renderTransform()
    select([id])
    const before = revision()
    const field = screen.getByLabelText('X in LDraw units')
    act(() => {
      fireEvent.change(field, { target: { value: '400' } })
      fireEvent.blur(field)
    })
    expect(revision()).toBe(before + 1)
    expect(cadEngine.getDocument().parts[id].transform.position[0]).toBe(400)
  })

  it('offers world, local and connector reference frames', () => {
    renderTransform()
    select([showcasePartIds()[0]])
    const group = screen.getByRole('radiogroup', { name: 'Reference frame' })
    const options = within(group).getAllByRole('radio')
    expect(options.map((option) => option.textContent)).toEqual(['WORLD', 'LOCAL', 'MATE'])
    expect(options[0].getAttribute('aria-checked')).toBe('true')
    fireEvent.click(options[1])
    expect(
      within(screen.getByRole('radiogroup', { name: 'Reference frame' }))
        .getAllByRole('radio')[1]
        .getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.getByText(/Typed coordinates stay world LDU/i)).toBeVisible()
    expect(
      screen.getByRole('group', { name: 'World position in LDraw units' }).getAttribute('data-position-frame'),
    ).toBe('world')
  })

  it('offers a pivot choice for rotation', () => {
    renderTransform()
    const options = within(screen.getByRole('radiogroup', { name: 'Rotation pivot' })).getAllByRole('radio')
    expect(options.map((option) => option.textContent)).toEqual(['ORIGIN', 'CENTRE', 'WORLD 0'])
  })

  it('locks an axis out of the numeric field', () => {
    const id = showcasePartIds()[0]
    renderTransform()
    select([id])
    expect((screen.getByLabelText('Y in LDraw units') as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(screen.getByTitle('Lock Y translation and rotation'))
    expect((screen.getByLabelText('Y in LDraw units') as HTMLInputElement).disabled).toBe(true)
  })

  it('nudges a multi-part selection as one transaction', () => {
    const ids = showcasePartIds().slice(0, 3)
    renderTransform()
    select(ids)
    const before = revision()
    const positions = ids.map((id) => cadEngine.getDocument().parts[id].transform.position[0])
    act(() => {
      fireEvent.click(screen.getByLabelText('Nudge X positive'))
    })
    expect(revision()).toBe(before + 1)
    ids.forEach((id, index) => {
      expect(cadEngine.getDocument().parts[id].transform.position[0]).toBeCloseTo(positions[index] + 20, 4)
    })
  })

  it('nudges a keyboard multi-selection as one transaction', () => {
    let api: Workbench | null = null
    render(
      <Harness>
        {(w) => {
          api = w
          return null
        }}
      </Harness>,
    )
    const ids = showcasePartIds().slice(0, 3)
    select(ids)
    const before = revision()
    const positions = ids.map((id) => cadEngine.getDocument().parts[id].transform.position[0])
    act(() => {
      api!.nudgeSelection(20, 0)
    })
    expect(revision()).toBe(before + 1)
    ids.forEach((id, index) => {
      expect(cadEngine.getDocument().parts[id].transform.position[0]).toBeCloseTo(positions[index] + 20, 4)
    })
  })

  it('quarter-turns a clutched stack as one rigid transaction', () => {
    cadEngine.replaceDocument(createEmptyDocument())
    const brick = (id: string, position: [number, number, number]) => ({
      id,
      definitionId: '3001',
      color: 72,
      transform: { position, basis: IDENTITY_BASIS },
      subassemblyId: 'hull',
      stepId: 'step_1',
      provenance: 'human' as const,
      protected: false,
    })
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('a', [0, 0, 0]) }], 'human', 0)
    cadEngine.execute('Stack', [{ type: 'part.add', part: brick('b', [0, -24, 0]) }], 'human', 1)
    let api: Workbench | null = null
    render(
      <Harness>
        {(w) => {
          api = w
          return null
        }}
      </Harness>,
    )
    select(['a', 'b'])
    const before = revision()
    const dy =
      cadEngine.getDocument().parts.b.transform.position[1] - cadEngine.getDocument().parts.a.transform.position[1]
    act(() => {
      api!.rotateSelection(90)
    })
    expect(revision()).toBe(before + 1)
    const after = cadEngine.getDocument().parts
    expect(after.b.transform.position[1] - after.a.transform.position[1]).toBeCloseTo(dy, 4)
  })

  it('needs two parts to align and three to distribute', () => {
    renderTransform()
    select(showcasePartIds().slice(0, 1))
    expect(
      screen
        .getAllByTitle('Select two or more parts to align.')
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    select(showcasePartIds().slice(0, 2))
    expect((screen.getByTitle('Align min on X') as HTMLButtonElement).disabled).toBe(false)
    expect(
      screen
        .getAllByTitle('Select three or more parts to distribute.')
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    select(showcasePartIds().slice(0, 3))
    expect((screen.getByTitle('Distribute evenly on X') as HTMLButtonElement).disabled).toBe(false)
  })

  it('aligns a selection from measured bounds, not from part origins', () => {
    const ids = spreadPartIds()
    renderTransform()
    select(ids)
    const before = revision()
    act(() => {
      fireEvent.click(screen.getByTitle('Align min on X'))
    })
    expect(revision()).toBeGreaterThan(before)
    const mins = ids.map((id) => getPartBounds(cadEngine.getDocument().parts[id]).min[0])
    for (const min of mins) expect(min).toBeCloseTo(mins[0], 3)
  })

  it('says why an action is unavailable rather than only greying out', () => {
    renderTransform()
    expect(screen.getByLabelText(/Clone — Select at least one part first/)).not.toBeNull()
  })

  it('lists alternative connector seats for a single part', () => {
    renderTransform()
    select(showcasePartIds().slice(0, 1))
    expect(screen.getByText('CONNECTOR SEATS')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Selection modes
// ---------------------------------------------------------------------------

describe('selection modes', () => {
  const renderSelection = () => render(<Harness>{(w) => <SelectionPanel workbench={w} />}</Harness>)

  it('keeps modes off-screen until something is selected', () => {
    renderSelection()
    expect(screen.queryByRole('button', { name: /^Colour/ })).toBeNull()
    select([showcasePartIds()[0]])
    expect((screen.getByRole('button', { name: /^Colour/ }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Visible' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('expands to every part sharing the selection’s colour', () => {
    const first = showcasePartIds()[0]
    renderSelection()
    select([first])
    const colour = cadEngine.getDocument().parts[first].color
    const expected = Object.values(cadEngine.getDocument().parts).filter((part) => part.color === colour).length
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Colour/ }))
    })
    expect(cadEngine.getSnapshot().selection).toHaveLength(expected)
  })

  it('walks the connection graph', () => {
    renderSelection()
    select([showcasePartIds()[0]])
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Connected/ }))
    })
    expect(cadEngine.getSnapshot().selection.length).toBeGreaterThan(1)
  })

  it('inverts the selection', () => {
    const total = showcasePartIds().length
    renderSelection()
    select([showcasePartIds()[0]])
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Inverse' }))
    })
    expect(cadEngine.getSnapshot().selection).toHaveLength(total - 1)
  })

  it('hides without touching the document, and restores', () => {
    const before = revision()
    renderSelection()
    select([showcasePartIds()[0]])
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Hide/ }))
    })
    expect(revision()).toBe(before)
    expect(screen.getByRole('button', { name: /Show everything/ }).hasAttribute('disabled')).toBe(false)
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Show everything/ }))
    })
    expect(screen.queryByRole('button', { name: /Show everything/ })).toBeNull()
  })

  it('saves and restores a named selection set', () => {
    const ids = showcasePartIds().slice(0, 2)
    renderSelection()
    select(ids)
    act(() => {
      fireEvent.change(screen.getByLabelText('Selection set name'), { target: { value: 'Rear hatch' } })
      fireEvent.click(screen.getByRole('button', { name: /SAVE/ }))
    })
    select([])
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Rear hatch/ }))
    })
    expect(cadEngine.getSnapshot().selection.sort()).toEqual([...ids].sort())
  })

  it('reports how much of a stale set survives', () => {
    const ids = showcasePartIds().slice(0, 2)
    renderSelection()
    select(ids)
    act(() => {
      fireEvent.change(screen.getByLabelText('Selection set name'), { target: { value: 'Doomed' } })
      fireEvent.click(screen.getByRole('button', { name: /SAVE/ }))
    })
    act(() => {
      cadEngine.execute('Remove one', [{ type: 'part.remove', partId: ids[0] }], 'human')
    })
    expect(screen.getByText(/1 gone/)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

describe('command palette', () => {
  const renderPalette = (props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) => {
    const onRun = vi.fn(() => ({ ran: true }))
    const onClose = vi.fn()
    const onShortcuts = vi.fn()
    const view = render(
      <CommandPalette
        open
        shortcuts={defaultShortcutMap()}
        onShortcuts={onShortcuts}
        onRun={onRun}
        disabledReason={() => null}
        onClose={onClose}
        {...props}
      />,
    )
    return { ...view, onRun, onClose, onShortcuts }
  }

  it('opens with the keyboard already in the search field', async () => {
    renderPalette()
    const input = screen.getByLabelText('Search commands')
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(document.activeElement).toBe(input)
  })

  it('filters commands by name and by keyword, ranking the titled match first', () => {
    renderPalette()
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'isolate' } })
    const options = screen.getAllByRole('option')
    // "Show everything" also mentions isolate in its description, and that is
    // the right result — the ranking is what has to put the command whose title
    // matches at the top.
    expect(options.length).toBeGreaterThanOrEqual(1)
    expect(options[0].textContent).toContain('Isolate selection')
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'eyedropper' } })
    expect(screen.getAllByRole('option')[0].textContent).toContain('Pick colour')
  })

  it('points the combobox at the highlighted option so arrows announce it', () => {
    renderPalette()
    const input = screen.getByRole('combobox', { name: 'Search commands' })
    expect(input.getAttribute('aria-haspopup')).toBe('listbox')
    const options = screen.getAllByRole('option')
    expect(options[0].id).toMatch(/^command-palette-option-/)
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('runs the command under the cursor on Enter', () => {
    const { onRun, onClose } = renderPalette()
    const input = screen.getByLabelText('Search commands')
    fireEvent.change(input, { target: { value: 'ghost' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRun).toHaveBeenCalledWith('visibility.ghost')
    expect(onClose).toHaveBeenCalled()
  })

  it('reports why a command did nothing instead of closing silently', () => {
    const { onClose } = renderPalette({ onRun: () => ({ ran: false, reason: 'Select at least one part first.' }) })
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'ghost' } })
    fireEvent.keyDown(screen.getByLabelText('Search commands'), { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toContain('Select at least one part first.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the current binding on every row', () => {
    renderPalette()
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'undo' } })
    expect(screen.getAllByRole('option')[0].textContent).toContain(formatChord('mod+z'))
  })

  it('marks an unavailable command and says what is missing', () => {
    renderPalette({ disabledReason: (id) => (id === 'edit.clone' ? 'Select at least one part first.' : null) })
    fireEvent.change(screen.getByLabelText('Search commands'), { target: { value: 'clone' } })
    const row = screen.getAllByRole('option')[0]
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('Select at least one part first.')
  })

  it('keeps Tab off the command options so focus stays on the combobox chrome', async () => {
    renderPalette()
    const input = screen.getByRole('combobox', { name: 'Search commands' })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    expect(document.activeElement).toBe(input)
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    for (const option of options) {
      expect(option).toHaveAttribute('tabIndex', '-1')
    }
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(options.some((option) => option === document.activeElement)).toBe(false)
  })

  it('traps focus so Tab cannot leave the dialog', () => {
    const { container } = renderPalette()
    const focusable = [
      ...container.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled)'),
    ]
    const last = focusable[focusable.length - 1]
    last.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])
  })

  it('closes on Escape', () => {
    const { onClose } = renderPalette()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('restores focus to whatever opened it', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = renderPalette()
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('rebinds a command from the keys tab', () => {
    const { onShortcuts } = renderPalette({ initialTab: 'keys' })
    fireEvent.click(screen.getByLabelText(/Change the shortcut for Move tool/))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    })
    expect(onShortcuts).toHaveBeenCalled()
    expect(onShortcuts.mock.calls[0][0]['tool.move']).toBe('w')
  })

  it('reports a conflict rather than silently shadowing a binding', () => {
    renderPalette({ initialTab: 'keys', shortcuts: { ...defaultShortcutMap(), 'tool.move': 'v' } })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('1 conflict')
    expect(alert.textContent).toContain('tool.move')
    expect(alert.textContent).toContain('tool.select')
  })

  it('clears a binding entirely', () => {
    const { onShortcuts } = renderPalette({ initialTab: 'keys' })
    fireEvent.click(screen.getByLabelText('Remove the shortcut for Move tool'))
    expect(onShortcuts.mock.calls[0][0]['tool.move']).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Palette re-rendering
// ---------------------------------------------------------------------------

/**
 * The palette is memoised, and a memo is only as good as the props feeding it.
 *
 * `useWorkbench` subscribes to the kernel with no selector, so it re-renders on
 * every commit — including one that only moved the selection. That is the
 * premise these assert first, because a memo that looks like it works because
 * the parent stopped re-rendering is not the thing being tested.
 *
 * The contract that makes the memo hold is that every callback the palette
 * receives is a `useCallback` over an empty dependency array. Adding a
 * dependency to any of them would silently restore the behaviour this replaced
 * — sixty part cards and the colour table rebuilt on every viewport click — and
 * nothing else in the suite would notice.
 */
describe('palette re-rendering', () => {
  const captureProps = () => {
    const seen: Array<{ activeColor: number; callbacks: unknown[] }> = []
    render(
      <Harness>
        {(w) => {
          seen.push({
            activeColor: w.activeColor,
            callbacks: [w.recolorSelection, w.addPart, w.armPart, w.beginPartDrag, w.dropPart, w.endPartDrag],
          })
          return null
        }}
      </Harness>,
    )
    return seen
  }

  it('re-renders the shell on a selection-only commit', () => {
    const seen = captureProps()
    const before = seen.length
    select(showcasePartIds().slice(0, 1))
    expect(seen.length).toBeGreaterThan(before)
  })

  it('hands the palette identical props across that commit', () => {
    const seen = captureProps()
    const before = seen.at(-1)!
    select(showcasePartIds().slice(0, 1))
    const after = seen.at(-1)!
    expect(after.activeColor).toBe(before.activeColor)
    after.callbacks.forEach((callback, index) => {
      expect(callback).toBe(before.callbacks[index])
    })
  })
})
