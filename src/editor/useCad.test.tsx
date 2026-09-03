import { StrictMode } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createRoverDocument } from '../cad/__fixtures__/rover'
import { useCadSelection, useCadSnapshot, useCadValidation } from './useCad'

beforeEach(() => cadEngine.replaceDocument(createRoverDocument()))
afterEach(cleanup)

describe('CAD selector subscriptions', () => {
  it('does not render document subscribers for selection, autonomy, or proposal emissions', () => {
    let documentRenders = 0
    let selectionRenders = 0
    function Document() { useCadSnapshot(snapshot => snapshot.document); documentRenders++; return null }
    function Selection() { useCadSelection(); selectionRenders++; return null }
    render(<><Document /><Selection /></>)
    const initialDocument = documentRenders
    const initialSelection = selectionRenders
    const id = Object.keys(cadEngine.getSnapshot().document.parts)[0]
    act(() => cadEngine.setSelection([id]))
    expect(selectionRenders).toBeGreaterThan(initialSelection)
    act(() => cadEngine.setAutonomy('build'))
    act(() => { cadEngine.preflight('No changes', [], 'human') })
    expect(cadEngine.getSnapshot().proposals.length).toBeGreaterThan(0)
    expect(documentRenders).toBe(initialDocument)
  })

  it('supports inline selectors, custom equality and changing closures in StrictMode', () => {
    const { result, rerender } = renderHook(({ field }) => useCadSnapshot(snapshot => ({ value: field === 'revision' ? snapshot.document.revision : snapshot.selection.length }), (a, b) => a.value === b.value), {
      initialProps: { field: 'revision' }, wrapper: StrictMode,
    })
    const initial = result.current
    act(() => cadEngine.setAutonomy('build'))
    expect(result.current).toBe(initial)
    const id = Object.keys(cadEngine.getSnapshot().document.parts)[0]
    act(() => cadEngine.setSelection([id]))
    expect(result.current).toBe(initial)
    rerender({ field: 'selection' })
    expect(result.current.value).toBe(1)
  })

  it('keeps validation identity for same-document emissions', () => {
    const { result } = renderHook(() => useCadValidation())
    const validation = result.current
    act(() => cadEngine.setSelection([]))
    act(() => cadEngine.setAutonomy('build'))
    expect(result.current).toBe(validation)
  })
})
