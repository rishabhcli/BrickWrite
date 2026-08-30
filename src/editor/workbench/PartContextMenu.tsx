import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { catalog } from '../../cad/catalog'
import type { Workbench } from './useWorkbench'

export function PartContextMenu({
  workbench: w,
  point,
  onClose,
}: {
  workbench: Workbench
  point: { x: number; y: number }
  onClose: (focusCanvas?: boolean) => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(point)
  const selected = w.state.selection.length
  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect()
    if (rect)
      setPosition({
        x: Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8)),
      })
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [point])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose(false)
    }
    const resize = () => onClose(false)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('resize', resize)
    }
  }, [onClose])
  const item = (label: string, action: () => unknown, enabled = true, danger = false) => (
    <button
      role="menuitem"
      disabled={!enabled}
      className={danger ? 'danger' : ''}
      onClick={() => {
        onClose()
        action()
      }}
    >
      {label}
    </button>
  )
  return (
    <div
      ref={menu}
      className="part-context-menu"
      role="menu"
      aria-label="Part actions"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onKeyDown={(event) => {
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        } else {
          event.stopPropagation()
        }
      }}
    >
      <div className="part-context-heading">
        {selected === 1
          ? (catalog.get(w.selectedPart?.definitionId ?? '')?.name ?? 'Selected part')
          : selected
            ? `${selected} selected parts`
            : 'Viewport'}
      </div>
      {selected > 0 && (
        <>
          {item('Pick up and reposition', () => w.pickUpSelection(), selected === 1)}
          {item('Build another like this', () => w.pickUpSelection(true), selected === 1)}
          {item('Move with gizmo', () => w.setTool('move'))}
          {item('Rotate with gizmo', () => w.setTool('rotate'))}
          <div role="separator" />
          {item('Copy parts', () => w.copySelection())}
          {item('Duplicate selection', w.duplicateSelection)}
        </>
      )}
      {item('Paste parts', w.pasteSelection, Boolean(w.clipboard))}
      {selected > 0 && (
        <>
          <div role="separator" />
          {item('Select connected parts', () => w.applySelectionMode('connected'))}
          {item('Focus selection', w.focusSelection)}
          {item('Hide selection', w.hideSelection)}
          {item('Delete selection', w.deleteSelection, true, true)}
        </>
      )}
      <div role="separator" />
      {item('Frame model', w.fitView)}
      {item('Show all parts', w.showEverything)}
      {item('Undo', () => w.replayHistory('undo'), w.state.canUndo)}
    </div>
  )
}
