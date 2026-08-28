import * as THREE from 'three'

/**
 * Studio environments, generated rather than downloaded.
 *
 * Injection-moulded ABS does not read as plastic under lights alone. What makes
 * a brick look like a brick is the *reflection*: a broad soft highlight rolling
 * across the top face, a dimmer bounce off the surface it stands on, and a
 * darker band at the horizon that gives the sides their edge. That is an image-
 * based light, and every renderer that makes plastic look real uses one.
 *
 * Brickwright cannot fetch an HDR: the application refuses remote dependencies,
 * and a build guide that phones out for a texture is not self-contained. So the
 * environments are built here — banded skies, softboxes and fills rendered into
 * tiny equirectangular float textures and passed through `PMREMGenerator`, which
 * is the same path a loaded HDR takes. Each costs one 64 × 32 allocation and one
 * prefilter.
 *
 * Four are offered because the right environment is a judgement about what is
 * being looked at, not a style preference. `studio` is the editor's default and
 * the most neutral. `softbox` flattens contrast for reading fine detail on a
 * complex greeble. `daylight` gives strong directional shape for checking form
 * and overhangs. `night` is a dark surround that makes translucent and
 * light-piping elements legible, which the bright environments wash out.
 */

const WIDTH = 64
const HEIGHT = 32

/** Linear-space colour, since the texture feeds a float pipeline. */
type Rgb = [number, number, number]

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

export type EnvironmentName = 'studio' | 'softbox' | 'daylight' | 'night'

interface Band {
  readonly zenith: Rgb
  readonly horizon: Rgb
  readonly ground: Rgb
}

/** One emissive patch on the sphere: an ellipse in equirectangular space. */
interface Emitter {
  /** Longitude 0–1 and latitude 0–1, top to bottom. */
  readonly u: number
  readonly v: number
  readonly radiusU: number
  readonly radiusV: number
  readonly colour: Rgb
}

interface EnvironmentRecipe {
  readonly band: Band
  readonly emitters: readonly Emitter[]
  /** Broad low bounce standing in for light returning off the build surface. */
  readonly bounce: number
}

/**
 * The recipes.
 *
 * The key emitter in every one of them sits at u ≈ 0.62, matching the
 * `directionalLight` the viewport places at `[-16, 24, 13]`. When the shading
 * light and the reflected light disagree about where the source is, plastic
 * reads as painted — the specular highlight lands somewhere the diffuse shading
 * says it cannot be — so the two are kept deliberately in step.
 */
const RECIPES: Record<EnvironmentName, EnvironmentRecipe> = {
  studio: {
    band: { zenith: [0.42, 0.47, 0.52], horizon: [0.17, 0.19, 0.21], ground: [0.05, 0.055, 0.06] },
    emitters: [
      { u: 0.62, v: 0.16, radiusU: 0.16, radiusV: 0.13, colour: [5.2, 5.3, 5.4] },
      { u: 0.12, v: 0.3, radiusU: 0.2, radiusV: 0.22, colour: [0.5, 0.72, 0.85] },
    ],
    bounce: 0.28,
  },
  softbox: {
    // Two large, nearly-equal sources and a bright surround: the classic
    // product-photography setup, which minimises the shadowed faces so that
    // surface detail rather than form carries the image.
    band: { zenith: [0.55, 0.57, 0.6], horizon: [0.34, 0.35, 0.37], ground: [0.18, 0.185, 0.19] },
    emitters: [
      { u: 0.62, v: 0.18, radiusU: 0.24, radiusV: 0.2, colour: [3.4, 3.45, 3.5] },
      { u: 0.16, v: 0.26, radiusU: 0.22, radiusV: 0.2, colour: [2.4, 2.45, 2.55] },
      { u: 0.88, v: 0.34, radiusU: 0.18, radiusV: 0.18, colour: [1.4, 1.45, 1.5] },
    ],
    bounce: 0.5,
  },
  daylight: {
    // A small, very bright sun against a large blue sky. The tight emitter is
    // what produces a hard specular and crisp terminator, which is what makes
    // an overhang or a mis-seated slope obvious.
    band: { zenith: [0.32, 0.46, 0.78], horizon: [0.58, 0.62, 0.7], ground: [0.16, 0.15, 0.13] },
    emitters: [
      { u: 0.62, v: 0.12, radiusU: 0.05, radiusV: 0.045, colour: [26, 24.5, 21] },
      { u: 0.35, v: 0.42, radiusU: 0.3, radiusV: 0.25, colour: [0.35, 0.42, 0.6] },
    ],
    bounce: 0.34,
  },
  night: {
    // Near-black surround with cool practicals. Trans-clear and trans-neon parts
    // are read from what passes *through* them, and every bright environment
    // buries that behind a reflection of itself.
    band: { zenith: [0.012, 0.016, 0.026], horizon: [0.02, 0.024, 0.032], ground: [0.006, 0.007, 0.009] },
    emitters: [
      { u: 0.62, v: 0.2, radiusU: 0.1, radiusV: 0.09, colour: [2.6, 2.75, 3.1] },
      { u: 0.18, v: 0.36, radiusU: 0.12, radiusV: 0.14, colour: [0.5, 1.3, 1.5] },
      { u: 0.86, v: 0.3, radiusU: 0.1, radiusV: 0.12, colour: [1.2, 0.55, 0.35] },
    ],
    bounce: 0.05,
  },
}

/**
 * Builds the equirectangular source.
 *
 * `v` runs 0 at the top of the sphere to 1 at the bottom, and `u` around it.
 * Emitters wrap in longitude, which matters for a source near u = 0: without the
 * wrap it would be clipped in half and the reflection would show a hard seam.
 */
function environmentSource(recipe: EnvironmentRecipe): THREE.DataTexture {
  const data = new Float32Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y += 1) {
    const v = (y + 0.5) / HEIGHT
    for (let x = 0; x < WIDTH; x += 1) {
      const u = (x + 0.5) / WIDTH

      // Sky above the horizon, ground below it, with a soft transition.
      let colour: Rgb =
        v < 0.5
          ? mix(recipe.band.zenith, recipe.band.horizon, Math.pow(v / 0.5, 0.6))
          : mix(recipe.band.horizon, recipe.band.ground, Math.pow((v - 0.5) / 0.5, 0.5))

      for (const emitter of recipe.emitters) {
        const du = Math.min(Math.abs(u - emitter.u), 1 - Math.abs(u - emitter.u))
        const falloff = Math.exp(-((du / emitter.radiusU) ** 2) - (((v - emitter.v) / emitter.radiusV) ** 2))
        colour = [
          colour[0] + falloff * emitter.colour[0],
          colour[1] + falloff * emitter.colour[1],
          colour[2] + falloff * emitter.colour[2],
        ]
      }

      const bounce = Math.exp(-(((v - 0.78) / 0.26) ** 2)) * recipe.bounce
      colour = [colour[0] + bounce, colour[1] + bounce * 1.02, colour[2] + bounce * 1.05]

      const offset = (y * WIDTH + x) * 4
      data[offset] = colour[0]
      data[offset + 1] = colour[1]
      data[offset + 2] = colour[2]
      data[offset + 3] = 1
    }
  }
  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.FloatType)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.LinearSRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/**
 * Prefilters an environment for the given renderer.
 *
 * The caller owns the returned texture and should dispose it with the scene, or
 * hand it to the resource registry. The source and the generator are released
 * here, because both are throwaway.
 */
export function createEnvironment(renderer: THREE.WebGLRenderer, name: EnvironmentName = 'studio'): THREE.Texture {
  const source = environmentSource(RECIPES[name])
  const generator = new THREE.PMREMGenerator(renderer)
  generator.compileEquirectangularShader()
  const target = generator.fromEquirectangular(source)
  source.dispose()
  generator.dispose()
  const texture = target.texture
  // The render target holds the only reference to the framebuffer behind the
  // texture; disposing the texture alone leaks it, so the disposal is chained
  // here where both are still in scope.
  const dispose = texture.dispose.bind(texture)
  texture.dispose = () => {
    dispose()
    target.dispose()
  }
  return texture
}

/**
 * Intensity each environment should be applied at.
 *
 * Baked into the module rather than left to the caller because the recipes have
 * genuinely different total energy — `daylight` carries a 26× sun — and a single
 * scene intensity would make switching environments also change the exposure,
 * which reads as a bug rather than as a lighting choice.
 */
export const ENVIRONMENT_INTENSITY: Record<EnvironmentName, number> = {
  studio: 0.55,
  softbox: 0.62,
  daylight: 0.4,
  night: 0.9,
}

/** The editor's default environment. Retained as the original public name. */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  return createEnvironment(renderer, 'studio')
}
