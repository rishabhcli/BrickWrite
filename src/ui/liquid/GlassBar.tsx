import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeRefs, useLiquidSurface, type LiquidBlur, type LiquidRadius } from './LiquidMaterial'

export interface GlassBarProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'header' | 'nav'
  radius?: LiquidRadius
  blur?: LiquidBlur
  /** Set when the bar sits over bright content and must invert its edge. */
  overLight?: boolean
  children?: ReactNode
}

/** A bounded toolbar or navigation bar; callers choose its structural role. */
export const GlassBar = forwardRef<HTMLElement, GlassBarProps>(function GlassBar(
  { as: Component = 'div', radius = 'panel', blur = 'nav', className, overLight, children, ...props },
  ref,
) {
  const surface = useLiquidSurface({ role: 'bar', roleClass: 'glass-bar', radius, blur, className, overLight })
  return (
    <Component
      ref={mergeRefs(surface.hostRef, ref) as never}
      className={surface.className}
      data-tier={surface.dataTier}
      {...props}
    >
      {surface.lens}
      {children}
    </Component>
  )
})
