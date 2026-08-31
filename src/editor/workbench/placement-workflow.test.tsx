import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cadEngine } from '../../cad/engine'
import { getPartBounds } from '../../cad/geometry'
import { IDENTITY_BASIS, rotateWorld } from '../../cad/math'
import { resolvePlacement } from '../../cad/placement'
import { createEmptyDocument } from '../../cad/sample'
import type { PartInstance } from '../../cad/types'
import { createCommandHandlers } from './commands'
import { PartContextMenu } from './PartContextMenu'
import { PlacementBar, placementMessage } from './PlacementBar'
import { resetPreferences } from './persistence'
import { useWorkbench } from './useWorkbench'

beforeEach(() => {
  resetPreferences()
  const doc = createEmptyDocument()
  const part: PartInstance = {
    id: 'brick',
    definitionId: '3001',
    color: 4,
    transform: { position: [0, -24, 0], basis: IDENTITY_BASIS },
    subassemblyId: Object.keys(doc.subassemblies)[0],
    stepId: doc.steps[0].id,
    provenance: 'human',
    protected: false,
  }
  doc.parts = { brick: part }
  doc.steps[0].partIds = ['brick']
  doc.subassemblies[part.subassemblyId].partIds = ['brick']
  cadEngine.replaceDocument(doc)
  cadEngine.setSelection(['brick'])
})
afterEach(cleanup)

describe('building at the cursor', () => {
  it('picking up and cancelling never modifies the model or history', () => {
    const { result } = renderHook(useWorkbench)
    const before = cadEngine.getDocument()
    act(() => {
      expect(result.current.pickUpSelection()).toBe(true)
    })
    expect(result.current.placement?.movingPartId).toBe('brick')
    expect(cadEngine.getDocument()).toEqual(before)
    act(() => result.current.cancelPlacement())
    expect(cadEngine.getDocument()).toEqual(before)
    expect(cadEngine.getSnapshot().canUndo).toBe(false)
  })
  it('reseats the same part atomically and undo restores the original location', () => {
    const { result } = renderHook(useWorkbench)
    act(() => result.current.pickUpSelection())
    act(() => {
      expect(result.current.placeArmed({ position: [120, -24, 0], basis: IDENTITY_BASIS })).toBe(true)
    })
    expect(Object.keys(cadEngine.getDocument().parts)).toEqual(['brick'])
    expect(cadEngine.getDocument().parts.brick.transform.position).toEqual([120, -24, 0])
    expect(result.current.placement).toBeNull()
    act(() => result.current.replayHistory('undo'))
    expect(cadEngine.getDocument().parts.brick.transform.position).toEqual([0, -24, 0])
  })
  it('a refused landing keeps the original and the held brick', () => {
    const { result } = renderHook(useWorkbench)
    act(() => result.current.pickUpSelection())
    const before = cadEngine.getDocument()
    act(() => {
      expect(result.current.placeArmed({ position: [120, -24, 0], basis: IDENTITY_BASIS }, false, 'collision')).toBe(
        false,
      )
    })
    expect(cadEngine.getDocument()).toEqual(before)
    expect(result.current.placement?.movingPartId).toBe('brick')
  })
  it('building another samples the colour and full orientation, with single-placement mode', () => {
    const doc = cadEngine.getDocument()
    const rotation = rotateWorld(doc.parts.brick.transform, [1, 0, 0], Math.PI / 2)
    const bottom = getPartBounds({ ...doc.parts.brick, transform: rotation }).max[1]
    const tilted = {
      ...rotation,
      position: [rotation.position[0], rotation.position[1] - bottom, rotation.position[2]] as const,
    }
    cadEngine.replaceDocument({ ...doc, parts: { brick: { ...doc.parts.brick, transform: tilted } } })
    cadEngine.setSelection(['brick'])
    const { result } = renderHook(useWorkbench)
    act(() => result.current.pickUpSelection(true))
    expect(result.current.placement?.basis).toEqual(cadEngine.getDocument().parts.brick.transform.basis)
    expect(result.current.placement?.color).toBe(4)
    expect(result.current.placement?.movingPartId).toBeUndefined()
    act(() => result.current.setRepeatPlacement(false))
    const landing = resolvePlacement(
      result.current.placement!,
      cadEngine.getDocument(),
      { point: [160, 0, 0], partId: null },
      20,
    )!
    expect(getPartBounds({ ...doc.parts.brick, transform: landing.transform }).max[1]).toBeCloseTo(0)
    act(() => {
      expect(result.current.placeArmed(landing.transform, landing.legal, landing.reason)).toBe(true)
    })
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(2)
    expect(result.current.placement).toBeNull()
  })
  it('reverse turning a held brick does not rotate the selection', () => {
    const { result } = renderHook(useWorkbench)
    act(() => result.current.pickUpSelection())
    const before = cadEngine.getDocument()
    act(() =>
      createCommandHandlers({
        workbench: result.current,
        toggleDock: vi.fn(),
        focusSearch: vi.fn(),
        exportLdr: vi.fn(),
        resetWorkspace: vi.fn(),
      })['edit.quarter-turn'](),
    )
    expect(result.current.placement?.quarterTurns).toBe(-1)
    expect(cadEngine.getDocument()).toEqual(before)
  })
  it('rejects ground collisions in the preview rather than promising a legal landing', () => {
    const doc = cadEngine.getDocument()
    const blocked = {
      ...doc,
      parts: {
        brick: {
          ...doc.parts.brick,
          definitionId: '3070b',
          transform: { position: [0, -8, 0] as const, basis: IDENTITY_BASIS },
        },
      },
    }
    const result = resolvePlacement(
      { definitionId: '3001', color: 4, quarterTurns: 0 },
      blocked,
      { point: [0, 0, 0], partId: null },
      20,
    )!
    expect(result.legal).toBe(false)
    expect(result.reason).toBe('collision')
    expect(placementMessage(result)).toMatch(/Blocked/)
  })
  it('exposes rotation, repeat and cancellation as real controls', () => {
    const hook = renderHook(useWorkbench)
    act(() => hook.result.current.pickUpSelection(true))
    const view = render(<PlacementBar workbench={hook.result.current} preview={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rotate placement counterclockwise' }))
    view.rerender(<PlacementBar workbench={hook.result.current} preview={null} />)
    expect(screen.getByLabelText('Placement angle')).toHaveTextContent('270°')
    fireEvent.click(screen.getByRole('button', { name: 'Keep building' }))
    expect(hook.result.current.repeatPlacement).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel placement' }))
    expect(hook.result.current.placement).toBeNull()
  })
  it('picks up on drag start and puts an abandoned drag back without an edit', () => {
    const hook = renderHook(useWorkbench)
    const before = cadEngine.getDocument()
    act(() => expect(hook.result.current.beginPartDrag({ id: '3001', name: 'Brick 2 x 4' })).toBe(true))
    expect(hook.result.current.placement?.definitionId).toBe('3001')
    act(() => hook.result.current.endPartDrag())
    expect(hook.result.current.placement).toBeNull()
    expect(cadEngine.getDocument()).toEqual(before)
  })
  it('context actions support keyboard focus and Escape without mutating the model', () => {
    const hook = renderHook(useWorkbench)
    const close = vi.fn()
    render(<PartContextMenu workbench={hook.result.current} point={{ x: 10, y: 10 }} onClose={close} />)
    expect(screen.getByRole('menuitem', { name: 'Pick up and reposition' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Build another like this' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(close).toHaveBeenCalled()
    expect(cadEngine.getSnapshot().canUndo).toBe(false)
  })
})
