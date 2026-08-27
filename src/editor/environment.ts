import * as THREE from 'three'

/**
 * A studio environment, generated rather than downloaded.
 *
 * Injection-moulded ABS does not read as plastic under lights alone. What makes
 * a brick look like a brick is the *reflection*: a broad soft highlight rolling
 * across the top face, a dimmer bounce off the surface it stands on, and a
 * darker band at the horizon that gives the sides their edge. That is an image-
 * based light, and every renderer that makes plastic look real uses one.
 *
 * Brickwright cannot fetch an HDR: the application refuses remote dependencies,
 * and a build guide that phones out for a texture is not self-contained. So the
 * environment is built here — a three-band sky, an overhead softbox, and a
 * lower fill — rendered into a tiny equirectangular float texture and passed
 * through `PMREMGenerator`, which is the same path a loaded HDR takes. It costs
 * one 64 × 32 allocation and one prefilter at startup.
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

const ZENITH: Rgb = [0.42, 0.47, 0.52]
const HORIZON: Rgb = [0.17, 0.19, 0.21]
const GROUND: Rgb = [0.05, 0.055, 0.06]

/**
 * Builds the equirectangular source.
 *
 * `v` runs 0 at the top of the sphere to 1 at the bottom, and `u` around it.
 * The softbox is an ellipse placed high and slightly to one side, matching the
 * key light the viewport uses, so reflection and shading agree about where the
 * light is — when they disagree, plastic reads as painted.
 */
function studioSource(): THREE.DataTexture {
  const data = new Float32Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y += 1) {
    const v = (y + 0.5) / HEIGHT
    for (let x = 0; x < WIDTH; x += 1) {
      const u = (x + 0.5) / WIDTH

      // Sky above the horizon, ground below it, with a soft transition.
      let colour: Rgb = v < 0.5
        ? mix(ZENITH, HORIZON, Math.pow(v / 0.5, 0.6))
        : mix(HORIZON, GROUND, Math.pow((v - 0.5) / 0.5, 0.5))

      // Key softbox: broad, high, warm-neutral.
      const keyU = Math.min(Math.abs(u - 0.62), 1 - Math.abs(u - 0.62))
      const key = Math.exp(-((keyU / 0.16) ** 2) - (((v - 0.16) / 0.13) ** 2))
      colour = [colour[0] + key * 5.2, colour[1] + key * 5.3, colour[2] + key * 5.4]

      // Cool rim from behind, so silhouettes separate from the background.
      const rimU = Math.min(Math.abs(u - 0.12), 1 - Math.abs(u - 0.12))
      const rim = Math.exp(-((rimU / 0.2) ** 2) - (((v - 0.3) / 0.22) ** 2))
      colour = [colour[0] + rim * 0.5, colour[1] + rim * 0.72, colour[2] + rim * 0.85]

      // Low bounce, standing in for light returning off the build surface.
      const bounce = Math.exp(-(((v - 0.78) / 0.26) ** 2)) * 0.28
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
 * Prefilters the studio into an environment map for the given renderer.
 *
 * The caller owns the returned texture and should dispose it with the scene.
 * The source and the generator are released here, because both are throwaway.
 */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const source = studioSource()
  const generator = new THREE.PMREMGenerator(renderer)
  generator.compileEquirectangularShader()
  const target = generator.fromEquirectangular(source)
  source.dispose()
  generator.dispose()
  return target.texture
}
