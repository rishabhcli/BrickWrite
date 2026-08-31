import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import glassCss from './material.css?inline'
import {
  GlassBar,
  GlassButton,
  GlassDock,
  GlassField,
  GlassIsland,
  GlassNotice,
  GlassPanel,
  GlassSheet,
  GlassTabs,
} from './index'

afterEach(cleanup)

describe('glass primitives', () => {
  it('mounts bounded material roles with native elements and props', () => {
    const onClick = vi.fn()
    const { container } = render(
      <>
        <GlassBar as="header" aria-label="Project controls">
          bar
        </GlassBar>
        <GlassDock aria-label="Inspector">dock</GlassDock>
        <GlassIsland aria-label="Tool cluster">island</GlassIsland>
        <GlassPanel as="section" aria-label="Details">
          panel
        </GlassPanel>
        <label>
          Query <GlassField placeholder="Find parts" />
        </label>
        <GlassButton onClick={onClick}>Save</GlassButton>
        <GlassButton disabled>Unavailable</GlassButton>
        <GlassSheet aria-label="Project menu">sheet</GlassSheet>
        <GlassNotice>Saved</GlassNotice>
        <GlassNotice tone="error">Could not save</GlassNotice>
      </>,
    )

    expect(screen.getByRole('banner', { name: 'Project controls' })).toHaveClass('liquid-fill', 'glass-bar')
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toHaveClass('glass-dock', 'liquid-radius-panel')
    expect(screen.getByRole('region', { name: 'Details' })).toHaveClass('glass-panel', 'liquid-blur-control')
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveClass('glass-field', 'liquid-radius-control')
    expect(screen.getByRole('dialog', { name: 'Project menu' })).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save')

    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('liquid-fill', 'liquid-radius-control')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled()
    expect(container.querySelectorAll('.liquid-fill')).toHaveLength(10)
  })

  it('uses distinct material variables for filled, tinted, and plain buttons', () => {
    render(
      <>
        <GlassButton variant="filled">Filled</GlassButton>
        <GlassButton variant="tinted">Tinted</GlassButton>
        <GlassButton variant="plain">Plain</GlassButton>
      </>,
    )

    const fills = ['Filled', 'Tinted', 'Plain'].map((name) =>
      getComputedStyle(screen.getByRole('button', { name })).getPropertyValue('--liquid-button-fill').trim(),
    )
    expect(new Set(fills).size).toBe(3)
    expect(screen.getByRole('button', { name: 'Filled' })).toHaveClass('liquid-fill', 'liquid-button--filled')
    expect(glassCss).toMatch(/\.liquid-button\s*\{[\s\S]*--liquid-material:\s*var\(--liquid-button-fill\)/)
    expect(glassCss).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*--liquid-button-fill: var\(--panel-2/,
    )
  })

  it('does not allow forwarded props to weaken tablist or dialog semantics', () => {
    const unsafeTabProps = { role: 'presentation', 'aria-orientation': 'vertical' } as unknown as ComponentProps<
      typeof GlassTabs
    >
    const unsafeSheetProps = { role: 'alert', 'aria-modal': 'false' } as unknown as ComponentProps<typeof GlassSheet>

    render(
      <>
        <GlassTabs
          {...unsafeTabProps}
          aria-label="Required tab semantics"
          value="design"
          onValueChange={() => undefined}
          tabs={[{ id: 'design', label: 'Design' }]}
          orientation="horizontal"
        />
        <GlassSheet {...unsafeSheetProps} aria-label="Required dialog semantics">
          sheet
        </GlassSheet>
      </>,
    )

    expect(screen.getByRole('tablist', { name: 'Required tab semantics' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    )
    expect(screen.getByRole('dialog', { name: 'Required dialog semantics' })).toHaveAttribute('aria-modal', 'true')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('exposes controlled tabs with roving selection and keyboard navigation', () => {
    function Harness() {
      const [value, setValue] = useState('design')
      return (
        <GlassTabs
          aria-label="Inspector view"
          value={value}
          onValueChange={setValue}
          tabs={[
            { id: 'design', label: 'Design' },
            { id: 'object', label: 'Object' },
            { id: 'history', label: 'History', disabled: true },
          ]}
        />
      )
    }

    render(<Harness />)
    const tablist = screen.getByRole('tablist', { name: 'Inspector view' })
    const design = screen.getByRole('tab', { name: 'Design' })
    const object = screen.getByRole('tab', { name: 'Object' })

    expect(design).toHaveAttribute('aria-selected', 'true')
    expect(design).toHaveAttribute('tabindex', '0')
    expect(object).toHaveAttribute('tabindex', '-1')

    design.focus()
    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    expect(object).toHaveAttribute('aria-selected', 'true')
    expect(object).toHaveFocus()

    fireEvent.keyDown(tablist, { key: 'End' })
    expect(object).toHaveFocus()
    fireEvent.keyDown(tablist, { key: 'Home' })
    expect(design).toHaveFocus()
  })

  it('keeps an invalid controlled value unselected while retaining a keyboard anchor', () => {
    const onValueChange = vi.fn()
    render(
      <GlassTabs
        aria-label="Invalid controlled value"
        value="missing"
        onValueChange={onValueChange}
        tabs={[
          { id: 'design', label: 'Design' },
          { id: 'object', label: 'Object' },
          { id: 'history', label: 'History', disabled: true },
        ]}
      />,
    )

    const design = screen.getByRole('tab', { name: 'Design' })
    const object = screen.getByRole('tab', { name: 'Object' })
    expect(design).toHaveAttribute('aria-selected', 'false')
    expect(object).toHaveAttribute('aria-selected', 'false')
    expect(design).toHaveAttribute('tabindex', '0')

    design.focus()
    fireEvent.keyDown(design, { key: 'ArrowRight' })
    expect(onValueChange).toHaveBeenCalledWith('object')
    expect(object).toHaveFocus()
  })

  it('uses ArrowUp and ArrowDown for vertically oriented tabs', () => {
    function Harness() {
      const [value, setValue] = useState('design')
      return (
        <GlassTabs
          aria-label="Vertical inspector view"
          orientation="vertical"
          value={value}
          onValueChange={setValue}
          tabs={[
            { id: 'design', label: 'Design' },
            { id: 'object', label: 'Object' },
          ]}
        />
      )
    }

    render(<Harness />)
    const design = screen.getByRole('tab', { name: 'Design' })
    const object = screen.getByRole('tab', { name: 'Object' })
    design.focus()
    fireEvent.keyDown(design, { key: 'ArrowDown' })
    expect(object).toHaveAttribute('aria-selected', 'true')
    expect(object).toHaveFocus()
    fireEvent.keyDown(object, { key: 'ArrowUp' })
    expect(design).toHaveFocus()
  })

  it('hides a closed sheet without controlling owner focus or Escape behaviour', () => {
    const { container } = render(
      <GlassSheet open={false} aria-label="Closed sheet">
        hidden
      </GlassSheet>,
    )
    const sheet = container.querySelector('[role="dialog"]') as HTMLDivElement
    expect(sheet).toHaveAttribute('hidden')
    expect(sheet).toHaveAttribute('data-state', 'closed')
  })
})
