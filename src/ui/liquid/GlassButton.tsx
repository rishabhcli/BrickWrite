import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { joinClassNames, useLiquidSurface } from './LiquidMaterial'

export type GlassButtonVariant = 'filled' | 'tinted' | 'plain'

export interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: GlassButtonVariant
}

/**
 * A native button with the normal disabled, form, and keyboard behaviour.
 * It defaults to type=button so a toolbar action cannot accidentally submit a
 * surrounding form; pass type="submit" for the standard form action.
 *
 * The press response is the 2.5% gel compression from the token scale, applied
 * in CSS rather than through a spring: a button is pressed and released faster
 * than a spring can settle, so a transition is both cheaper and more accurate.
 */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton(
  { variant = 'tinted', className, type = 'button', ...props },
  ref,
) {
  const surface = useLiquidSurface({
    role: 'control',
    roleClass: 'liquid-button glass-button',
    radius: 'control',
    blur: 'chip',
    className: joinClassNames(`liquid-button--${variant}`, `glass-button--${variant}`, className),
  })
  return <button ref={ref} type={type} data-tier={surface.dataTier} className={surface.className} {...props} />
})
