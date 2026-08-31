import { forwardRef, type HTMLAttributes } from 'react'
import { joinClassNames, useLiquidSurface } from './LiquidMaterial'

export type GlassNoticeTone = 'info' | 'success' | 'warning' | 'error'

export interface GlassNoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: GlassNoticeTone
}

/** A polite status by default, promoted to an assertive alert for errors. */
export const GlassNotice = forwardRef<HTMLDivElement, GlassNoticeProps>(function GlassNotice(
  { tone = 'info', className, role, ...props },
  ref,
) {
  const surface = useLiquidSurface({
    role: 'control',
    roleClass: 'glass-notice liquid-notice',
    radius: 'control',
    blur: 'chip',
    className: joinClassNames(`liquid-notice--${tone}`, `glass-notice--${tone}`, className),
  })
  return (
    <div
      ref={ref}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      data-tier={surface.dataTier}
      className={surface.className}
      {...props}
    />
  )
})
