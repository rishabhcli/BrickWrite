import { m } from 'motion/react'
import { forwardRef, type ComponentPropsWithoutRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeRefs, useLiquidSurface } from './LiquidMaterial'
import { useLiquidEnvironment } from './LiquidStage'
import { transitionFor } from './motion'

export interface GlassSheetProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'aria-modal' | 'aria-hidden' | 'hidden'> {
  /** Whether the owner currently presents this sheet. No focus or modal state is managed here. */
  open?: boolean
  /** Set false when the owner deliberately presents a non-modal dialog. */
  modal?: boolean
  overLight?: boolean
  children?: ReactNode
}

/**
 * A styled dialog surface. Consumers own mounting, backdrop behaviour, Escape,
 * focus trapping, and focus restoration so app-specific dialog flows stay in
 * their existing controllers.
 */
export const GlassSheet = forwardRef<HTMLDivElement, GlassSheetProps>(function GlassSheet(
  { open = true, modal = true, className, overLight, children, ...props },
  ref,
) {
  const surface = useLiquidSurface({
    role: 'sheet',
    roleClass: 'glass-sheet liquid-sheet',
    radius: 'sheet',
    blur: 'nav',
    className,
    overLight,
  })
  const { reducedMotion } = useLiquidEnvironment()

  /*
   * The intent tier: a sheet is something the operator deliberately summoned,
   * so it arrives with a visible overshoot rather than appearing.
   *
   * Only the arrival is animated. `hidden` collapses a closed sheet to
   * display:none — which is the behaviour consumers and tests already rely on
   * to keep it out of the accessibility tree — and nothing animates out of
   * display:none. Animating the dismissal would mean owning unmount timing,
   * which this primitive deliberately leaves with the consumer.
   */
  return (
    <m.div
      {...(props as ComponentPropsWithoutRef<typeof m.div>)}
      ref={mergeRefs<HTMLDivElement>(surface.hostRef, ref)}
      role="dialog"
      aria-modal={modal || undefined}
      aria-hidden={!open || undefined}
      hidden={!open}
      data-state={open ? 'open' : 'closed'}
      data-tier={surface.dataTier}
      className={surface.className}
      initial={false}
      animate={open ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
      transition={transitionFor('intent', reducedMotion)}
    >
      {/* A hidden sheet must not mount a lens: it would keep a displacement
          map, a ResizeObserver and a pointer subscription alive for a surface
          nobody can see. */}
      {open ? surface.lens : null}
      {children}
    </m.div>
  )
})
