import { useId, useMemo } from 'react'
import { useLiquidPointer, type PointerPosition } from './LiquidStage'
import { displacementMap } from './displacement'
import type { Box } from './rect'

/**
 * Where the pointer sits relative to the surface, as -1..1 on each axis.
 *
 * Real glass does not have a fixed highlight. The specular travels as your eye
 * and the light move relative to the surface, and a highlight that never moves
 * is the clearest tell that a panel is a picture of glass rather than glass.
 * Clamped, so a surface reaches its extreme and stays there rather than keeping
 * on sliding as the pointer leaves the window.
 */
function pointerBias(rect: Box | null, pointer: PointerPosition): { x: number; y: number } {
  if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 }
  const clamp = (value: number) => Math.min(1, Math.max(-1, value))
  return {
    x: clamp((pointer.x - (rect.left + rect.width / 2)) / (rect.width / 2)),
    y: clamp((pointer.y - (rect.top + rect.height / 2)) / (rect.height / 2)),
  }
}

export interface LiquidLensProps {
  /** The host's box, tracked once by useLiquidSurface and shared with this lining. */
  rect: Box | null
  cornerRadius: number
  blurAmount: number
  /**
   * How bright the backdrop is, 0..1. Continuous rather than a flag: a surface
   * half over a white plate is genuinely between the two treatments, and a
   * switch has to answer that wrongly in one direction or the other.
   */
  lightness: number
  displacementScale: number
  aberrationIntensity: number
  elasticity: number
  saturation: number
}

/**
 * The tier-1 material, mounted as a lining rather than a wrapper.
 *
 * It sits at z-index -1 inside the host, which paints it above the host's own
 * background and below the host's content. That ordering is the reason this is
 * a lining and not a wrapper: wrapping would insert a box into the middle of
 * flex and grid layouts on surfaces that already work, and a migration that
 * rearranges the DOM cannot honestly claim to have only changed material.
 *
 * The host must form a stacking context — see the @layer note in material.css —
 * and must NOT use `isolation: isolate` to do it, because isolation forms a
 * backdrop root and would leave this element with nothing behind it to refract.
 *
 * Five layers, because backdrop-filter applies to what is *behind* an element:
 * anything painted onto the refracting element would sit on top of its own
 * refraction and flatten it.
 */
export function LiquidLens({
  rect,
  cornerRadius,
  blurAmount,
  lightness,
  displacementScale,
  aberrationIntensity,
  elasticity,
  saturation,
}: LiquidLensProps) {
  const pointer = useLiquidPointer()
  const filterId = useId().replace(/[^a-zA-Z0-9-]/g, '')

  const width = rect?.width ?? 0
  const height = rect?.height ?? 0

  // The bend reaches in from the rim by a little over the corner radius, so a
  // sharp-cornered bar still reads as having thickness.
  const band = Math.max(10, Math.min(cornerRadius * 1.75, Math.min(width, height) / 2))
  const map = useMemo(
    () => (width > 0 && height > 0 ? displacementMap({ width, height, radius: cornerRadius, band }) : null),
    [width, height, cornerRadius, band],
  )

  const bias = pointerBias(rect, pointer)

  // Elasticity leans the highlight past the pointer, so the surface reads as
  // having give rather than as a decal tracking it exactly.
  const lean = 1 + elasticity
  const sheenX = 50 + bias.x * 32 * lean
  const sheenY = 50 + bias.y * 32 * lean

  /*
   * Light comes from above.
   *
   * That single assumption is what turns a uniform hairline into an edge with
   * thickness: the top rim catches the light, the bottom rim falls into shade,
   * and the eye reads the difference as a bevel it can almost feel. A rim of
   * even brightness all the way round reads as a drawn border instead.
   *
   * Over bright content the whole relationship inverts — glass on snow shows a
   * dark edge — and it does so by degrees rather than at a threshold, which is
   * what `lightness` carries.
   */
  const light = Math.min(1, Math.max(0, lightness))
  const mix = (dark: number, bright: number) => dark + (bright - dark) * light

  /**
   * White over a dark backdrop, black over a bright one, neutral in between.
   *
   * Both the tone and the strength travel together, so a surface drifting onto
   * a white plate fades its light rim out and its dark rim in rather than
   * swapping one for the other on a frame.
   */
  const grade = (darkAlpha: number, brightAlpha: number) => {
    const tone = Math.round(255 * (1 - light))
    return `rgba(${tone}, ${tone}, ${tone}, ${mix(darkAlpha, brightAlpha).toFixed(3)})`
  }
  /** The same grade run the other way, for the shaded side of the rim. */
  const gradeInverse = (darkAlpha: number, brightAlpha: number) => {
    const tone = Math.round(255 * light)
    return `rgba(${tone}, ${tone}, ${tone}, ${mix(darkAlpha, brightAlpha).toFixed(3)})`
  }

  const rimTop = grade(0.62, 0.3)
  const rimBottom = gradeInverse(0.34, 0.34)
  const rimAll = grade(0.16, 0.16)
  const rimOuter = `rgba(0, 0, 0, ${mix(0.42, 0.22).toFixed(3)})`
  const sheenPeak = mix(0.2, 0.1)
  const glow = grade(0.13, 0.1)

  return (
    <span aria-hidden="true" className="liquid-lens">
      {map ? (
        <svg className="liquid-lens__defs" width="0" height="0">
          <defs>
            {/*
              Three displacement passes at slightly different strengths, one per
              channel, recombined. That difference is dispersion: glass bends
              blue harder than red, and it is the reason a real edge shows
              colour where a blurred rectangle shows none.
            */}
            <filter id={filterId} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
              <feImage href={map} result="map" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%" />
              <feDisplacementMap
                in="SourceGraphic"
                in2="map"
                scale={displacementScale + aberrationIntensity}
                xChannelSelector="R"
                yChannelSelector="G"
                result="red"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="map"
                scale={displacementScale}
                xChannelSelector="R"
                yChannelSelector="G"
                result="green"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="map"
                scale={displacementScale - aberrationIntensity}
                xChannelSelector="R"
                yChannelSelector="G"
                result="blue"
              />
              <feColorMatrix
                in="red"
                type="matrix"
                values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                result="redOnly"
              />
              <feColorMatrix
                in="green"
                type="matrix"
                values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                result="greenOnly"
              />
              <feColorMatrix
                in="blue"
                type="matrix"
                values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                result="blueOnly"
              />
              <feBlend in="redOnly" in2="greenOnly" mode="screen" result="redGreen" />
              <feBlend in="redGreen" in2="blueOnly" mode="screen" />
            </filter>
          </defs>
        </svg>
      ) : null}

      {/*
        The refracting layer. Blur and saturation run before the displacement so
        the bend samples an already-softened backdrop, which keeps a rim from
        looking like a smeared screenshot of the model behind it.
      */}
      <span
        className="liquid-lens__warp"
        style={{
          backdropFilter: map
            ? `blur(${blurAmount}px) saturate(${saturation}%) url(#${filterId})`
            : `blur(${blurAmount}px) saturate(${saturation}%)`,
          WebkitBackdropFilter: `blur(${blurAmount}px) saturate(${saturation}%)`,
        }}
      />

      {/* The broad specular, tracking the pointer. */}
      <span
        className="liquid-lens__sheen"
        style={{
          background: `radial-gradient(130% 150% at ${sheenX}% ${sheenY}%, rgba(255,255,255,${sheenPeak}) 0%, rgba(255,255,255,0.035) 40%, transparent 70%)`,
        }}
      />

      {/*
        The inner ring, set in from the rim by the same band the bend uses.
        Thick glass gathers light just inside its edge; without this the surface
        reads as a film rather than as a slab with depth.
      */}
      <span
        className="liquid-lens__glow"
        style={{ boxShadow: `inset 0 0 ${Math.round(band)}px ${Math.round(-band * 0.55)}px ${glow}` }}
      />

      {/* The rim: lit from above, shaded below, hairline all round, seated outside. */}
      <span
        className="liquid-lens__rim"
        style={{
          boxShadow: [
            `inset 0 1px 0 ${rimTop}`,
            `inset 0 -1px 0 ${rimBottom}`,
            `inset 0 0 0 0.5px ${rimAll}`,
            `0 0 0 0.5px ${rimOuter}`,
          ].join(', '),
        }}
      />
    </span>
  )
}
