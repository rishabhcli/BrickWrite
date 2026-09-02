import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { createExtensionRegistry, ExtensionRegistryProvider, type WorkbenchApi } from './ExtensionRegistry'
import { SelectionHUD } from './SelectionHUD'
import { ViewportNavigator } from './ViewportNavigator'
import { ViewportQuickControls } from './ViewportQuickControls'
import { ViewportStage } from './ViewportStage'
import { IDLE_CONNECT, type Workbench } from './useWorkbench'
import { createEmptyDocument } from '../../cad/sample'
import { IDENTITY_BASIS } from '../../cad/math'

vi.mock('../CadViewport', () => ({
  CadViewport: () => null,
}))

afterEach(cleanup)

function OverlayHost({ children }: { children: React.ReactNode }) {
  const [registry] = useState(() => createExtensionRegistry())
  const api = { snapshot: { selection: [] }, selection: [], tool: 'select' } as unknown as WorkbenchApi
  return (
    <ExtensionRegistryProvider registry={registry} api={api}>
      {children}
    </ExtensionRegistryProvider>
  )
}

describe('viewport orientation cube', () => {
  it('keeps every canonical camera direction one click away', () => {
    const onView = vi.fn()
    render(<ViewportNavigator view="isometric" onView={onView} />)

    expect(screen.getByRole('button', { name: 'Isometric view' })).toHaveAttribute('aria-pressed', 'true')
    for (const [name, view] of [
      ['Top view', 'top'],
      ['Front view', 'front'],
      ['Right view', 'right'],
      ['Left view', 'left'],
      ['Back view', 'rear'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(onView).toHaveBeenLastCalledWith(view)
    }
  })
})

describe('visible snap presets', () => {
  it('changes the grid without opening a select menu', () => {
    const setGridLdu = vi.fn()
    const setTransformPrefs = vi.fn()
    render(
      <ViewportQuickControls
        workbench={
          {
            renderMode: 'beauty',
            setRenderMode: vi.fn(),
            fitView: vi.fn(),
            focusSelection: vi.fn(),
            state: { selection: ['brick'] },
            gridLdu: 20,
            setGridLdu,
            transformPrefs: { connectorSnap: true },
            setTransformPrefs,
          } as unknown as Workbench
        }
      />,
    )

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Snap 1 stud' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Snap 1 plate' }))
    expect(setGridLdu).toHaveBeenCalledWith(8)
  })
})

describe('selection HUD', () => {
  it('exposes the main modelling actions beside a live position', () => {
    const onTool = vi.fn()
    const onFocus = vi.fn()
    const onGround = vi.fn()
    const onDuplicate = vi.fn()
    const onPosition = vi.fn()
    const onRotate = vi.fn()
    const onMore = vi.fn()
    render(
      <SelectionHUD
        count={1}
        label="Brick 2 x 4"
        position={[20, -24, 0]}
        locks={{ x: false, y: false, z: false }}
        frame="world"
        rotation={[0, 90, 0]}
        tool="move"
        onTool={onTool}
        onFocus={onFocus}
        onGround={onGround}
        onDuplicate={onDuplicate}
        onPosition={onPosition}
        onRotate={onRotate}
        onMore={onMore}
      />,
    )

    expect(screen.getByLabelText('World position 20, -24, 0 LDU')).toBeInTheDocument()
    expect(screen.getByLabelText('Rotation 0, 90, 0 degrees')).toBeInTheDocument()
    expect(screen.getByLabelText('Brick 2 x 4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More actions for Brick 2 x 4' })).toBeInTheDocument()
    expect(screen.getByLabelText('World position 20, -24, 0 LDU').textContent).toMatch(/LDU/)
    expect(screen.getByLabelText('World position 20, -24, 0 LDU').getAttribute('data-position-frame')).toBe('world')
    const x = screen.getByRole('spinbutton', { name: 'X in LDraw units' })
    expect(x).toHaveValue(20)
    fireEvent.change(x, { target: { value: '40' } })
    fireEvent.keyDown(x, { key: 'Enter' })
    expect(onPosition).toHaveBeenCalledWith(0, 40)
    expect(screen.getByRole('button', { name: 'Move selection' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Rotate selection' }))
    expect(onTool).toHaveBeenCalledWith('rotate')
    fireEvent.click(screen.getByRole('button', { name: 'Mate selection' }))
    expect(onTool).toHaveBeenCalledWith('connect')
    fireEvent.click(screen.getByRole('button', { name: 'Focus selection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ground selection' }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate selection' }))
    expect(onFocus).toHaveBeenCalledOnce()
    expect(onGround).toHaveBeenCalledOnce()
    expect(onDuplicate).toHaveBeenCalledOnce()
  })

  it('keeps the identity named as the selection, not as more-actions', () => {
    const onMore = vi.fn()
    render(
      <SelectionHUD
        count={2}
        label="Brick 2 x 4 → Plate 2 x 4"
        position={[0, 0, 0]}
        locks={{ x: true, y: false, z: false }}
        frame="world"
        tool="connect"
        onTool={vi.fn()}
        onFocus={vi.fn()}
        onGround={vi.fn()}
        onDuplicate={vi.fn()}
        onPosition={vi.fn()}
        onMore={onMore}
      />,
    )
    expect(screen.getByLabelText('Brick 2 x 4 → Plate 2 x 4').tagName).not.toBe('BUTTON')
    expect(screen.getByLabelText('World position 0, 0, 0 LDU').querySelector('input')?.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Brick 2 x 4 → Plate 2 x 4' }))
    expect(onMore).toHaveBeenCalledOnce()
  })
})

function overlayWorkbench(overrides: Record<string, unknown> = {}): Workbench {
  const document = createEmptyDocument()
  document.parts = {
    a: {
      id: 'a',
      definitionId: '3001',
      color: 4,
      transform: { position: [0, -24, 0], basis: IDENTITY_BASIS },
      subassemblyId: Object.keys(document.subassemblies)[0],
      stepId: document.steps[0].id,
      provenance: 'human',
      protected: false,
    },
  }
  document.steps[0].partIds = ['a']
  return {
    state: {
      document,
      selection: ['a'],
      proposals: [{ id: 'p1', label: 'Ghost brick', operations: [{ type: 'noop' }] }],
      validation: { partCount: 1, collisions: [], constraints: [], healthy: true },
    },
    renderMode: 'beauty',
    placement: { definitionId: '3001', quarterTurns: 0, movingPartId: null },
    placementDefinition: { name: 'Brick 2 x 4' },
    connect: IDLE_CONNECT,
    playbackStep: 0,
    setPlaybackStep: vi.fn(),
    transformPrefs: { locks: { x: false, y: false, z: false }, frame: 'world' },
    selectionPosition: [0, -24, 0],
    selectedDefinition: { name: 'Brick 2 x 4' },
    tool: 'select',
    setTool: vi.fn(),
    focusSelection: vi.fn(),
    groundSelection: vi.fn(),
    duplicateSelection: vi.fn(),
    positionSelection: vi.fn(),
    acceptProposal: vi.fn(),
    rejectProposal: vi.fn(),
    setRenderMode: vi.fn(),
    cameraView: 'isometric',
    setCameraView: vi.fn(),
    viewportProposals: [],
    renderedDocument: document,
    canvasRef: { current: null },
    gridLdu: 20,
    ...overrides,
  } as unknown as Workbench
}

describe('viewport overlay stacking', () => {
  it('stacks playback above the HUD and placement above a proposal instead of sharing one slot', () => {
    render(
      <OverlayHost>
        <ViewportStage workbench={overlayWorkbench()} />
      </OverlayHost>,
    )
    const top = document.querySelector('[data-overlay-stack="top"]')
    const bottom = document.querySelector('[data-overlay-stack="bottom"]')
    expect(top?.querySelector('.instruction-overlay')).not.toBeNull()
    expect(bottom?.querySelector('.placement-bar')).not.toBeNull()
    expect(bottom?.querySelector('.proposal-overlay')).not.toBeNull()
    expect(top?.querySelector('.selection-hud')).toBeNull()
    const order = [...bottom!.children].map((node) => node.className)
    expect(order[0]).toMatch(/placement-bar/)
    expect(order[1]).toMatch(/proposal-overlay/)
  })
})
