import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { mergeRefs, useLiquidSurface, type LiquidBlur, type LiquidRadius } from './LiquidMaterial'

export interface GlassPanelProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'aside'
  radius?: LiquidRadius
  blur?: LiquidBlur
  overLight?: boolean
  className?: string
  children: ReactNode
}

/**
 * A bounded material surface for a card, section, or complementary region.
 *
 * Panels stay on the blur material by design. A dock holds three of them at
 * once and a lensed surface inside another lensed surface refracts a backdrop
 * that has already been refracted, which reads as smeared rather than deep.
 */
export const GlassPanel = forwardRef<HTMLElement, GlassPanelProps>(function GlassPanel(
  { as: Component = 'div', radius = 'panel', blur = 'control', className, overLight, children, ...props },
  ref,
) {
  const surface = useLiquidSurface({ role: 'panel', roleClass: 'glass-panel', radius, blur, className, overLight })
  return (
    <Component
      ref={mergeRefs(surface.hostRef, ref) as never}
      className={surface.className}
      data-tier={surface.dataTier}
      {...props}
    >
      {children}
    </Component>
  )
})
