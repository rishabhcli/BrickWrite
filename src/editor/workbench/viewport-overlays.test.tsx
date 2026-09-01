import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SelectionHUD } from './SelectionHUD'
import { ViewportNavigator } from './ViewportNavigator'

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

describe('selection HUD', () => {
  it('exposes the main modelling actions beside a live position', () => {
    const onTool = vi.fn()
    const onFocus = vi.fn()
    const onGround = vi.fn()
    const onDuplicate = vi.fn()
    const onMore = vi.fn()
    render(
      <SelectionHUD
        count={1}
        label="Brick 2 x 4"
        position={[20, -24, 0]}
        tool="move"
        onTool={onTool}
        onFocus={onFocus}
        onGround={onGround}
        onDuplicate={onDuplicate}
        onMore={onMore}
      />,
    )

    expect(screen.getByLabelText('Position 20, -24, 0 LDU')).toHaveTextContent('X20Y-24Z0')
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
})
