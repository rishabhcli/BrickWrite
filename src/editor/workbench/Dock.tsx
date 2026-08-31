import { ChevronDown, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { DOCK_LIMITS, type DockId } from './layout'

/**
 * Dock chrome: the splitters, the collapse rails and the section headers.
 *
 * A splitter is a real control, not a hairline you have to find: it is a
 * focusable `separator` with arrow-key resizing, because a pointer-only resize
 * is a resize half the operators cannot perform.
 */

export function DockSplitter({
  dock,
  size,
  onResize,
  onDoubleClick,
}: {
  dock: DockId
  size: number
  onResize: (size: number) => void
  onDoubleClick?: () => void
}) {
  const dragging = useRef(false)
  const origin = useRef({ pointer: 0, size })
  const latest = useRef(size)
  latest.current = size

  const vertical = dock !== 'bottom'
  const limits = DOCK_LIMITS[dock]

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true
      origin.current = { pointer: vertical ? event.clientX : event.clientY, size: latest.current }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [vertical],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const delta = (vertical ? event.clientX : event.clientY) - origin.current.pointer
      // The left dock grows rightwards, the right and bottom docks grow the other
      // way, so the sign of the drag is per dock rather than global.
      const signed = dock === 'left' ? delta : -delta
      onResize(origin.current.size + signed)
    },
    [dock, onResize, vertical],
  )

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 32 : 8
      const grow = vertical ? 'ArrowRight' : 'ArrowDown'
      const shrink = vertical ? 'ArrowLeft' : 'ArrowUp'
      const towardsLarger = dock === 'left' ? grow : shrink
      const towardsSmaller = dock === 'left' ? shrink : grow
      if (event.key === towardsLarger) {
        event.preventDefault()
        onResize(latest.current + step)
      } else if (event.key === towardsSmaller) {
        event.preventDefault()
        onResize(latest.current - step)
      } else if (event.key === 'Home') {
        event.preventDefault()
        onResize(limits.min)
      } else if (event.key === 'End') {
        event.preventDefault()
        onResize(limits.max)
      }
    },
    [dock, limits.max, limits.min, onResize, vertical],
  )

  return (
    <div
      className={`dock-splitter ${vertical ? 'vertical' : 'horizontal'}`}
      data-dock={dock}
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={`Resize the ${dock} panel`}
      aria-valuenow={size}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      title={`Drag to resize · double-click to collapse · ${size}px`}
    >
      <i />
    </div>
  )
}

/** The 34px rail a collapsed side dock leaves behind, so it can be reopened. */
export function CollapsedRail({
  dock,
  label,
  onExpand,
}: {
  dock: 'left' | 'right'
  label: string
  onExpand: () => void
}) {
  return (
    <div className={`dock-rail ${dock}`}>
      <button type="button" onClick={onExpand} aria-label={`Show the ${label} panel`} title={`Show the ${label} panel`}>
        {dock === 'left' ? <PanelLeftOpen size={14} /> : <PanelRightOpen size={14} />}
      </button>
      <span>{label.toUpperCase()}</span>
    </div>
  )
}

/**
 * One collapsible section inside a dock.
 *
 * Progressive disclosure is the only way a palette, a transform sheet, a
 * selection sheet and four extension panels coexist in 300 pixels. Open state is
 * persisted by the caller, so the arrangement an operator settles on survives a
 * reload.
 */
export function DockSection({
  id,
  title,
  icon,
  badge,
  open,
  onToggle,
  actions,
  children,
  grow,
}: {
  id: string
  title: string
  icon?: ReactNode
  badge?: ReactNode
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
  /** True for the one section that should absorb the dock's spare height. */
  grow?: boolean
}) {
  return (
    <section className={`dock-section ${open ? 'open' : 'closed'} ${grow && open ? 'grow' : ''}`} data-section={id}>
      <header>
        <button
          type="button"
          className="dock-section-toggle"
          aria-expanded={open}
          aria-controls={`dock-section-${id}`}
          onClick={onToggle}
        >
          <ChevronDown size={11} className="dock-chevron" />
          {icon}
          <h3>{title}</h3>
        </button>
        {badge}
        {actions}
      </header>
      <div className="dock-section-body" id={`dock-section-${id}`} hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  )
}

/** Collapse control shown in a dock's own header. */
export function DockCollapseButton({ dock, onCollapse }: { dock: 'left' | 'right'; onCollapse: () => void }) {
  return (
    <button
      type="button"
      className="dock-collapse"
      onClick={onCollapse}
      aria-label={`Collapse the ${dock} panel`}
      title={`Collapse the ${dock} panel`}
    >
      {dock === 'left' ? <PanelLeftClose size={13} /> : <PanelRightClose size={13} />}
    </button>
  )
}

/** Reports the window size, so the layout can be clamped to what really fits. */
export function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1600 : window.innerWidth,
    height: typeof window === 'undefined' ? 1000 : window.innerHeight,
  }))

  useEffect(() => {
    let frame = 0
    const onResize = () => {
      // Coalesced to one measurement per frame: a drag-resize fires this
      // continuously and re-clamping the whole layout per event is wasted work.
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setSize({ width: window.innerWidth, height: window.innerHeight }))
    }
    window.addEventListener('resize', onResize)
    onResize()
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return size
}
