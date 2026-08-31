import { forwardRef, type InputHTMLAttributes } from 'react'
import { useLiquidSurface } from './LiquidMaterial'

export type GlassFieldProps = InputHTMLAttributes<HTMLInputElement>

/** A native input; use its associated label, placeholder, and input type normally. */
export const GlassField = forwardRef<HTMLInputElement, GlassFieldProps>(function GlassField(
  { className, ...props },
  ref,
) {
  const surface = useLiquidSurface({
    role: 'control',
    roleClass: 'liquid-field glass-field',
    radius: 'control',
    blur: 'chip',
    className,
  })
  return <input ref={ref} data-tier={surface.dataTier} className={surface.className} {...props} />
})
