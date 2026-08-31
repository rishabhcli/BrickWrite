import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeRefs, useLiquidSurface, type LiquidBlur, type LiquidRadius } from './LiquidMaterial'

export interface GlassIslandProps extends HTMLAttributes<HTMLDivElement> {
  radius?: LiquidRadius
  blur?: LiquidBlur
  overLight?: boolean
  children?: ReactNode
}

/** A compact floating cluster; placement stays with the owner, never this primitive. */
export const GlassIsland = forwardRef<HTMLDivElement, GlassIslandProps>(function GlassIsland(
  { radius = 'island', blur = 'control', className, overLight, children, ...props },
  ref,
) {
  const surface = useLiquidSurface({ role: 'island', roleClass: 'glass-island', radius, blur, className, overLight })
  return (
    <div
      ref={mergeRefs<HTMLDivElement>(surface.hostRef, ref)}
      className={surface.className}
      data-tier={surface.dataTier}
      {...props}
    >
      {surface.lens}
      {children}
    </div>
  )
})
