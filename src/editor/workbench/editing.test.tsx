import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cadEngine } from '../../cad/engine'
import { getPartBounds } from '../../cad/geometry'
import { IDENTITY_BASIS, rotateWorld } from '../../cad/math'
import { createEmptyDocument } from '../../cad/sample'
import type { PartInstance } from '../../cad/types'
import { captureParts, planPaste } from './clipboard'
import { createCommandHandlers } from './commands'
import { NumberField } from './NumberField'
import { resetPreferences } from './persistence'
import { TransformPanel } from './TransformPanel'
import {
  DEFAULT_MANIPULATION,
  manipulationPose,
  NO_LOCKS,
  planGizmoTransforms,
  planGroundSelection,
  poseKey,
} from './transform'
import { useWorkbench } from './useWorkbench'

function fixture() {
  const doc = createEmptyDocument()
  const make = (id: string, x: number, y: number): PartInstance => ({
    id,
    definitionId: '3001',
    color: 4,
    transform: { position: [x, y, 0], basis: IDENTITY_BASIS },
    subassemblyId: Object.keys(doc.subassemblies)[0],
    stepId: doc.steps[0].id,
    protected: false,
    provenance: 'human',
  })
  doc.parts = { a: make('a', 0, -24), b: make('b', 120, -24) }
  doc.steps[0].partIds = ['a', 'b']
  doc.subassemblies[Object.keys(doc.subassemblies)[0]].partIds = ['a', 'b']
  return doc
}
beforeEach(() => {
  resetPreferences()
  cadEngine.replaceDocument(fixture())
})
afterEach(cleanup)

describe('rigid gizmo motion', () => {
  it.each([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const)('keeps a group rigid around axis %s %s %s', (x, y, z) => {
    const parts = Object.values(fixture().parts)
    const start = manipulationPose(parts, DEFAULT_MANIPULATION)
    const raw = rotateWorld(start, [x, y, z], Math.PI * 0.75, start.position)
    const plan = planGizmoTransforms(parts, start, raw, { rotating: true, gridLdu: 20, locks: NO_LOCKS })
    expect(plan).toHaveLength(2)
    for (const operation of plan) {
      if (operation.type !== 'part.transform') throw Error('Expected transform')
      const expected = rotateWorld(
        parts.find((part) => part.id === operation.partId)!.transform,
        [x, y, z],
        Math.PI * 0.75,
        start.position,
      )
      expect(poseKey(operation.transform)).toBe(poseKey(expected))
    }
  })
  it('snaps a delta without knocking off-grid height off its clutch', () => {
    const parts = [fixture().parts.a]
    const start = manipulationPose(parts, DEFAULT_MANIPULATION)
    const raw = { ...start, position: [start.position[0] + 21, start.position[1], start.position[2]] as const }
    const [operation] = planGizmoTransforms(parts, start, raw, { rotating: false, gridLdu: 20, locks: NO_LOCKS })
    expect(operation).toMatchObject({ transform: { position: [20, -24, 0] } })
    expect(
      planGizmoTransforms(parts, start, raw, { rotating: false, gridLdu: 20, locks: { ...NO_LOCKS, x: true } }),
    ).toEqual([])
  })
  it('uses the requested origin and local frame', () => {
    const parts = Object.values(fixture().parts)
    parts[0].transform = rotateWorld(parts[0].transform, [0, 1, 0], Math.PI / 2)
    const start = manipulationPose(parts, { ...DEFAULT_MANIPULATION, frame: 'local', pivot: 'origin' })
    expect(start).toEqual(parts[0].transform)
    expect(manipulationPose(parts, { ...DEFAULT_MANIPULATION, pivot: 'world-origin' }).position).toEqual([0, 0, 0])
    const raw = { ...start, position: [0, -24, -23] as const }
    const [op] = planGizmoTransforms(parts, start, raw, { rotating: false, gridLdu: 20, locks: NO_LOCKS })
    expect(op).toMatchObject({ transform: { position: [0, -24, -20] } })
  })
  it('does not create an edit for a click without motion', () => {
    const parts = Object.values(fixture().parts)
    const start = manipulationPose(parts, DEFAULT_MANIPULATION)
    expect(planGizmoTransforms(parts, start, start, { rotating: true, gridLdu: 20, locks: NO_LOCKS })).toEqual([])
  })
  it('grounds a whole selection without changing its relative positions', () => {
    const parts = Object.values(fixture().parts).map((part) => ({
      ...part,
      transform: { ...part.transform, position: [part.transform.position[0], -104, 0] as const },
    }))
    const plan = planGroundSelection(parts)
    expect(plan).toHaveLength(2)
    for (const op of plan) {
      if (op.type !== 'part.transform') throw Error('Expected transform')
      expect(
        getPartBounds({ ...parts.find((part) => part.id === op.partId)!, transform: op.transform }).max[1],
      ).toBeCloseTo(0)
    }
  })
})

describe('numeric drafts', () => {
  it('commits Enter then blur once, not twice', () => {
    const onCommit = vi.fn()
    render(<NumberField label="X" value={12} suffix="LDU" onCommit={onCommit} />)
    const field = screen.getByRole('spinbutton')
    fireEvent.change(field, { target: { value: '24.5' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.blur(field)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(24.5)
  })
  it('cancels Escape, ignores empty and unchanged fields, and restores the actual value', () => {
    const onCommit = vi.fn()
    render(<NumberField label="X" value={12} suffix="LDU" onCommit={onCommit} />)
    const field = screen.getByRole('spinbutton')
    fireEvent.change(field, { target: { value: '50' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.blur(field)
    expect(field).toHaveValue(12)
    fireEvent.change(field, { target: { value: '' } })
    fireEvent.blur(field)
    expect(field).toHaveValue(12)
    fireEvent.blur(field)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('editor transactions', () => {
  it('positions a selection from its measured centre as one undoable edit', () => {
    const { result } = renderHook(useWorkbench)
    act(() => cadEngine.setSelection(['a', 'b']))
    expect(result.current.selectionPosition[0]).toBeCloseTo(60)

    act(() => {
      expect(result.current.positionSelection(0, 200)).toBe(true)
    })

    expect(cadEngine.getDocument().parts.a.transform.position[0]).toBeCloseTo(140)
    expect(cadEngine.getDocument().parts.b.transform.position[0]).toBeCloseTo(260)
    expect(cadEngine.getDocument().revision).toBe(1)
    act(() => cadEngine.undo('human'))
    expect(cadEngine.getDocument().parts.a.transform.position[0]).toBe(0)
    expect(cadEngine.getDocument().parts.b.transform.position[0]).toBe(120)
  })

  it('duplicates an elevated brick onto the ground in a clear lane', () => {
    const document = fixture()
    document.parts.b.transform = { position: [0, -48, 0], basis: IDENTITY_BASIS }
    cadEngine.replaceDocument(document)
    const { result } = renderHook(useWorkbench)
    act(() => cadEngine.setSelection(['b']))
    act(() => {
      expect(result.current.duplicateSelection()).toBe(true)
    })
    const copied = cadEngine.getDocument().parts[cadEngine.getSnapshot().selection[0]]
    expect(copied.id).not.toBe('b')
    expect(getPartBounds(copied).max[1]).toBeCloseTo(0)
    expect(cadEngine.getSnapshot().validation.collisions).toEqual([])
  })

  it('selects parts restored by redo so the next edit works immediately', () => {
    const { result } = renderHook(useWorkbench)
    act(() => cadEngine.setSelection(['a']))
    act(() => result.current.copySelection())
    act(() => result.current.pasteSelection())
    const pasted = cadEngine.getSnapshot().selection[0]
    act(() => result.current.replayHistory('undo'))
    expect(cadEngine.getDocument().parts[pasted]).toBeUndefined()
    act(() => result.current.replayHistory('redo'))
    expect(cadEngine.getSnapshot().selection).toContain(pasted)
  })

  it('copies a snapshot, pastes repeatedly into clear space, and undoes one paste at a time', () => {
    const { result } = renderHook(useWorkbench)
    act(() => cadEngine.setSelection(['a', 'b']))
    act(() => {
      expect(result.current.copySelection()).toBe(true)
    })
    expect(cadEngine.getDocument().revision).toBe(0)
    act(() => {
      expect(result.current.pasteSelection()).toBe(true)
    })
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(4)
    expect(cadEngine.getSnapshot().selection).toHaveLength(2)
    act(() => {
      expect(result.current.pasteSelection()).toBe(true)
    })
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(6)
    act(() => {
      cadEngine.undo('human')
    })
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(4)
    act(() => {
      cadEngine.redo('human')
    })
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(6)
  })
  it('cuts and restores original positions without corrupting the clipboard on undo', () => {
    const { result } = renderHook(useWorkbench)
    const original = cadEngine.getDocument().parts.a.transform
    act(() => cadEngine.setSelection(['a']))
    act(() => {
      expect(result.current.copySelection(true)).toBe(true)
    })
    expect(cadEngine.getDocument().parts.a).toBeUndefined()
    act(() => {
      expect(result.current.pasteSelection()).toBe(true)
    })
    expect(cadEngine.getDocument().parts[cadEngine.getSnapshot().selection[0]].transform).toEqual(original)
  })
  it('keeps selection and clipboard after a constraint refuses a cut', () => {
    const { result } = renderHook(useWorkbench)
    act(() => cadEngine.setSelection(['a']))
    act(() => result.current.copySelection())
    const before = result.current.clipboard
    const execute = vi.spyOn(cadEngine, 'execute').mockReturnValueOnce({
      ok: false,
      error: { code: 'COLLISION', message: 'Refused for test', repair: 'Repair first' },
    })
    act(() => {
      expect(result.current.copySelection(true)).toBe(false)
    })
    expect(cadEngine.getSnapshot().selection).toEqual(['a'])
    expect(result.current.clipboard).toBe(before)
    execute.mockRestore()
  })
  it('ignores unchanged transforms and respects keyboard axis locks', () => {
    const { result } = renderHook(useWorkbench)
    act(() => cadEngine.setSelection(['a']))
    act(() => {
      result.current.handleTransform('a', cadEngine.getDocument().parts.a.transform)
    })
    expect(cadEngine.getDocument().revision).toBe(0)
    act(() => result.current.setTransformPrefs({ ...result.current.transformPrefs, locks: { ...NO_LOCKS, x: true } }))
    act(() => {
      result.current.nudgeSelection(20, 0)
    })
    expect(cadEngine.getDocument().revision).toBe(0)
  })
  it('select-all excludes hidden parts and inverse respects isolation', () => {
    const { result } = renderHook(useWorkbench)
    act(() => cadEngine.setSelection(['b']))
    act(() => {
      result.current.hideSelection()
    })
    act(() =>
      createCommandHandlers({
        workbench: result.current,
        toggleDock: vi.fn(),
        focusSearch: vi.fn(),
        exportLdr: vi.fn(),
        resetWorkspace: vi.fn(),
      })['select.all'](),
    )
    expect(cadEngine.getSnapshot().selection).toEqual(['a'])
    act(() => result.current.applySelectionMode('inverse'))
    expect(cadEngine.getSnapshot().selection).toEqual([])
  })
  it('edits a group centre precisely as one reversible transaction', () => {
    function Harness() {
      const w = useWorkbench()
      return <TransformPanel workbench={w} />
    }
    render(<Harness />)
    act(() => cadEngine.setSelection(['a', 'b']))
    const field = screen.getByLabelText('Z in LDraw units')
    fireEvent.change(field, { target: { value: '40.5' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.blur(field)
    expect(cadEngine.getDocument().revision).toBe(1)
    expect(Object.values(cadEngine.getDocument().parts).map((part) => part.transform.position[2])).toEqual([40.5, 40.5])
    act(() => {
      cadEngine.undo('human')
    })
    expect(Object.values(cadEngine.getDocument().parts).map((part) => part.transform.position[2])).toEqual([0, 0])
  })
  it('pastes across documents with fresh membership and no source aliases', () => {
    const source = fixture()
    const clipboard = captureParts(source, ['a', 'b'])!
    source.parts.a.color = 1
    const target = createEmptyDocument()
    target.id = 'another-document'
    const plan = planPaste(target, clipboard)
    cadEngine.replaceDocument(target)
    const committed = cadEngine.execute('Paste fixture', plan.operations, 'human')
    expect(committed.ok).toBe(true)
    expect(Object.values(cadEngine.getDocument().parts).map((part) => part.color)).toEqual([4, 4])
    expect(new Set(plan.selection).size).toBe(2)
    for (const part of Object.values(cadEngine.getDocument().parts)) {
      expect(cadEngine.getDocument().subassemblies[part.subassemblyId].partIds).toContain(part.id)
      expect(cadEngine.getDocument().steps.find((step) => step.id === part.stepId)?.partIds).toContain(part.id)
    }
  })
})
