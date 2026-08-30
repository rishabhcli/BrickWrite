import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY_BASIS } from '../../cad/math'
import { createEmptyDocument } from '../../cad/sample'
import type { EngineSnapshot, PartInstance } from '../../cad/types'
import { validateDocument } from '../../cad/validation'
import { ModelHealthPanel } from './ModelHealthPanel'

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

function healthSnapshot(): EngineSnapshot {
  const document = createEmptyDocument()
  document.parts = {
    allowed: part('allowed', [0, 0, 0], 4),
    wrong: part('wrong', [400, 0, 0], 15),
  }
  document.subassemblies.hull.partIds = ['allowed', 'wrong']
  document.constraints = [{
    id: 'palette_build',
    kind: 'palette',
    label: 'Build palette',
    value: [4],
    hard: true,
  }]
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

describe('Model Health navigator', () => {
  it('shows measured blockers with repair evidence instead of an aggregate warning count', () => {
    render(
      <ModelHealthPanel
        state={healthSnapshot()}
        activeIssueId="constraint:palette_build"
        onFocusIssue={() => undefined}
      />,
    )

    expect(screen.getByRole('heading', { name: /blocker found/i })).toBeVisible()
    expect(screen.getByText('Build palette')).toBeVisible()
    expect(screen.getByText(/Recolour the highlighted parts/)).toBeVisible()
    expect(screen.getByText('Kernel constraint palette_build · fail')).toBeVisible()
  })

  it('hands the exact issue and requested navigation mode to the shared workspace', () => {
    const onFocus = vi.fn()
    render(
      <ModelHealthPanel
        state={healthSnapshot()}
        activeIssueId="constraint:palette_build"
        onFocusIssue={onFocus}
      />,
    )

    const issue = document.querySelector('[data-health-issue="constraint:palette_build"]') as HTMLElement
    fireEvent.click(within(issue).getByRole('button', { name: /frame/i }))

    expect(onFocus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'constraint:palette_build', partIds: ['wrong'] }),
      'frame',
    )
  })

  it('filters the deterministic issue queue by severity', () => {
    render(<ModelHealthPanel state={healthSnapshot()} onFocusIssue={() => undefined} />)

    fireEvent.click(screen.getByRole('tab', { name: /block/i }))
    expect(screen.getByText('Build palette')).toBeVisible()
    expect(screen.queryByText('Separate build islands')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /notice/i }))
    expect(screen.getByText('Separate build islands')).toBeVisible()
    expect(screen.queryByText('Build palette')).not.toBeInTheDocument()
  })
})
