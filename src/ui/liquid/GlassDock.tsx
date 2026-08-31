import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeRefs, useLiquidSurface, type LiquidBlur, type LiquidRadius } from './LiquidMaterial'

export interface GlassDockProps extends HTMLAttributes<HTMLElement> {
  as?: 'aside' | 'nav' | 'div'
  radius?: LiquidRadius
  blur?: LiquidBlur
  overLight?: boolean
  children?: ReactNode
}

/** A complementary sidebar surface. Give it an accessible name when it is an aside. */
export const GlassDock = forwardRef<HTMLElement, GlassDockProps>(function GlassDock(
  { as: Component = 'aside', radius = 'panel', blur = 'nav', className, overLight, children, ...props },
  ref,
) {
  const surface = useLiquidSurface({ role: 'dock', roleClass: 'glass-dock', radius, blur, className, overLight })
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
