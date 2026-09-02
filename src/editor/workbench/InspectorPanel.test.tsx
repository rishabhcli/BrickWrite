import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY_BASIS } from '../../cad/math'
import { createEmptyDocument } from '../../cad/sample'
import type { EngineSnapshot, PartInstance } from '../../cad/types'
import { validateDocument } from '../../cad/validation'
import { InspectorPanel, inspectorKernelParts } from './InspectorPanel'

afterEach(cleanup)

const part = (id: string, position: [number, number, number], color: number): PartInstance => ({
  id,
  definitionId: '3001',
  color,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

function blockedSnapshot(): EngineSnapshot {
  const document = createEmptyDocument()
  document.parts = {
    allowed: part('allowed', [0, 0, 0], 4),
    wrong: part('wrong', [400, 0, 0], 15),
  }
  document.subassemblies.hull.partIds = ['allowed', 'wrong']
  document.constraints = [
    {
      id: 'palette_build',
      kind: 'palette',
      label: 'Build palette',
      value: [4],
      hard: true,
    },
  ]
  return {
    document,
    transactions: [],
    proposals: [],
    canUndo: false,
    canRedo: false,
    autonomy: 'inspect',
    validation: validateDocument(document),
    selection: [],
  }
}

const handlers = {
  articulation: [],
  onTransform: vi.fn(),
  onRecolor: vi.fn(),
  onProtect: vi.fn(),
  onSelectIds: vi.fn(),
  onArticulate: vi.fn(),
}

describe('inspector OBJECT / VALIDATE chrome', () => {
  it('names VALIDATE from model health, not the unnamed kernel-healthy dot', () => {
    const state = blockedSnapshot()
    expect(state.validation.healthy).toBe(false)
    expect(state.validation.constraints.some((item) => item.status === 'fail')).toBe(true)

    render(<InspectorPanel state={state} {...handlers} />)

    const object = screen.getByRole('tab', { name: 'OBJECT' })
    const validate = screen.getByRole('tab', { name: /Validate, \d+ blockers?/ })
    expect(object).toHaveAttribute('aria-selected', 'true')
    expect(validate).toHaveAttribute('aria-selected', 'false')
    expect(validate.querySelector('.warning-dot')).not.toBeNull()
    expect(validate.querySelector('.warning-dot')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: 'OBJECT' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: /blocker found/i })).toBeNull()
  })

  it('moves between inspector views with the arrow keys', () => {
    render(<InspectorPanel state={blockedSnapshot()} {...handlers} />)

    const object = screen.getByRole('tab', { name: 'OBJECT' })
    object.focus()
    fireEvent.keyDown(object, { key: 'ArrowRight' })

    const validate = screen.getByRole('tab', { name: /Validate, \d+ blockers?/ })
    expect(validate).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: /blocker found/i })).toBeVisible()
    expect(screen.getByRole('tabpanel', { name: /Validate/ })).toBeVisible()
  })

  it('does not nest a complementary landmark inside the inspector', () => {
    render(<InspectorPanel state={blockedSnapshot()} view="validate" {...handlers} />)
    const host = document.querySelector('.inspector-panel .model-health')
    expect(host?.tagName).toBe('SECTION')
    expect(screen.getByRole('region', { name: 'Model health navigator' })).toBeVisible()
  })

  it('does not claim nothing is selected when the kernel holds two parts', () => {
    const state = blockedSnapshot()
    state.selection = ['allowed', 'wrong']
    expect(inspectorKernelParts(state)).toHaveLength(2)

    render(<InspectorPanel state={state} selectedPart={state.document.parts.allowed} {...handlers} />)

    expect(screen.queryByText('NO OBJECT SELECTED')).toBeNull()
    expect(screen.getByText('2 PARTS SELECTED')).toBeVisible()
    expect(screen.getByText(/kernel has 2 parts/i)).toBeVisible()
    expect(document.querySelector('.empty-inspector')?.getAttribute('data-selection-count')).toBe('2')
  })

  it('admits a selected part the catalog cannot describe', () => {
    const state = blockedSnapshot()
    state.document.parts.ghost = {
      ...state.document.parts.allowed,
      id: 'ghost',
      definitionId: 'not-a-compiled-part',
    }
    state.selection = ['ghost']

    render(<InspectorPanel state={state} {...handlers} />)

    expect(screen.queryByText('NO OBJECT SELECTED')).toBeNull()
    expect(screen.getByText('IDENTITY MISSING')).toBeVisible()
    expect(screen.getByText(/not-a-compiled-part is selected/)).toBeVisible()
  })
})
