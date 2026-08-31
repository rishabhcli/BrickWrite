import { forwardRef, useId, type HTMLAttributes, type KeyboardEvent } from 'react'
import { joinClassNames, useLiquidSurface } from './LiquidMaterial'

export interface GlassTab {
  id: string
  label: string
  disabled?: boolean
}

export interface GlassTabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'role' | 'aria-orientation'> {
  tabs: readonly GlassTab[]
  value: string
  onValueChange: (value: string) => void
  orientation?: 'horizontal' | 'vertical'
}

function firstEnabled(tabs: readonly GlassTab[]): GlassTab | undefined {
  return tabs.find((tab) => !tab.disabled)
}

function nextEnabled(tabs: readonly GlassTab[], currentId: string, offset: number): GlassTab | undefined {
  const enabled = tabs.filter((tab) => !tab.disabled)
  if (!enabled.length) return undefined
  const index = enabled.findIndex((tab) => tab.id === currentId)
  return enabled[((index < 0 ? 0 : index) + offset + enabled.length) % enabled.length]
}

function focusedTabId(event: KeyboardEvent<HTMLDivElement>): string | undefined {
  const target = event.target
  if (!(target instanceof HTMLElement)) return undefined
  return target.closest<HTMLElement>('[data-glass-tab-id]')?.dataset.glassTabId
}

/**
 * A controlled roving-tabindex tablist. It manages selection only through
 * onValueChange; tab panels and their visibility remain the caller's state.
 */
export const GlassTabs = forwardRef<HTMLDivElement, GlassTabsProps>(function GlassTabs(
  { tabs, value, onValueChange, orientation = 'horizontal', className, onKeyDown, ...props },
  ref,
) {
  const generatedId = useId()
  const surface = useLiquidSurface({
    role: 'control',
    roleClass: 'liquid-tabs glass-tabs',
    radius: 'island',
    blur: 'chip',
    className,
  })

  // Do not substitute a different selection when a controlled owner supplies
  // an invalid or disabled value: its panel state must stay truthfully aligned
  // with aria-selected. The first enabled tab only anchors keyboard entry.
  const selected = tabs.find((tab) => tab.id === value && !tab.disabled)?.id
  const keyboardAnchor = selected ?? firstEnabled(tabs)?.id

  const selectAndFocus = (tab: GlassTab) => {
    onValueChange(tab.id)
    document.getElementById(`${generatedId}-${tab.id}`)?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || !keyboardAnchor) return

    const previousKey = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
    const nextKey = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
    const currentId = focusedTabId(event) ?? keyboardAnchor
    let target: GlassTab | undefined

    if (event.key === previousKey) target = nextEnabled(tabs, currentId, -1)
    else if (event.key === nextKey) target = nextEnabled(tabs, currentId, 1)
    else if (event.key === 'Home') target = firstEnabled(tabs)
    else if (event.key === 'End') target = [...tabs].reverse().find((tab) => !tab.disabled)
    else return

    if (target) {
      event.preventDefault()
      selectAndFocus(target)
    }
  }

  return (
    <div
      {...props}
      ref={ref}
      role="tablist"
      aria-orientation={orientation}
      data-tier={surface.dataTier}
      className={surface.className}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const active = tab.id === selected
        return (
          <button
            key={tab.id}
            id={`${generatedId}-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active || tab.id === keyboardAnchor ? 0 : -1}
            disabled={tab.disabled}
            data-glass-tab-id={tab.id}
            className={joinClassNames('liquid-tabs__tab', 'glass-tabs__tab', active && 'is-selected')}
            onClick={() => onValueChange(tab.id)}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
})
