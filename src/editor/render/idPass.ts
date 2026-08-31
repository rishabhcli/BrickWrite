import * as THREE from 'three'
import { encodeId, NO_ID, PickRegistry } from './ids'
import {
  coverageInRegion,
  nearestIdInPatch,
  rasterizeRegion,
  regionBounds,
  type RegionOptions,
  type RegionShape,
} from './regionSelect'
import { rendererResources } from './resources'

/**
 * GPU identity picking.
 *
 * Picking used to run through React's pointer system, which raycasts on the CPU:
 * every instanced batch intersected, every hit walked back to a member entry,
 * all of it on the frame's critical path. It is correct and it does not scale —
 * the cost is proportional to the *model*, so the tool gets less responsive
 * exactly as the model gets more valuable.
 *
 * This pass draws the scene a second time into an off-screen buffer where each
 * part writes its own integer identity instead of its shaded colour, and then
 * reads back only the pixels the operator asked about. Three properties follow
 * that the CPU path could not offer at any price:
 *
 *   - **Pixel accuracy.** A pick lands on the part whose pixel is under the
 *     cursor, including through a hole in a Technic beam or between the studs of
 *     a grille tile, because the buffer is the same rasterisation the operator is
 *     looking at.
 *   - **Region selection by coverage.** A lasso reads which identities cover the
 *     pixels inside it. Occlusion is free: an id pass with a depth test writes
 *     only visible surfaces, so a buried part is not in the buffer to be found.
 *   - **Occlusion cycling.** Repeated clicks in the same place hide the
 *     identities already walked and re-read, which steps strictly backwards
 *     through depth order at that pixel.
 *
 * ## Cost
 *
 * The pass costs the same draw calls as the beauty pass — it reuses the very
 * same instanced batches, with `scene.overrideMaterial` swapping in the identity
 * shader — and a fraction of the fragment work, since the shader does no
 * lighting. A single pick additionally uses `setViewOffset` to rasterise *only*
 * a small window around the cursor, so the fragment cost of a click is a few
 * hundred pixels regardless of the viewport's size.
 *
 * ## Selection priority — the documented, predictable rules
 *
 *  1. **Depth wins.** A single pick returns the identity nearest the camera at
 *     that pixel. There is no size, order or type preference; what is in front
 *     is what is picked.
 *  2. **Exact hit first, then nearest within the pick radius.** The centre pixel
 *     is tested alone before any neighbour, so a direct hit is never overridden
 *     by a larger part one pixel away. Only if the centre is background does the
 *     search expand outward, ring by ring, and stop at the first ring containing
 *     anything.
 *  3. **Region selection counts covered pixels, not centres.** An identity is
 *     selected when at least `minPixels` (default 1) of its pixels lie inside
 *     the region. Results are ordered by coverage, so a caller that truncates
 *     keeps what the operator most plainly circled.
 *  4. **Only visible surfaces participate.** Ghosted, hidden and clipped-away
 *     geometry is excluded from the pass, so it can be neither picked nor
 *     region-selected. What you cannot see, you cannot select.
 *  5. **Cycling is strictly monotonic in depth.** Clicking again within the
 *     cycle radius and timeout returns the next identity *behind* the last one.
 *     When the stack is exhausted the cycle restarts at the frontmost, so the
 *     interaction is a loop rather than a dead end.
 *  6. **Ties are impossible.** Every identity is unique per draw and the depth
 *     buffer resolves coincident surfaces the same way the beauty pass does, so
 *     two parts can never both claim one pixel.
 */

/** Layer carrying pickable geometry. The id camera renders only this layer. */
export const PICK_LAYER = 1

/** Hidden-identity slots for occlusion cycling. Depth this deep at one pixel is rare. */
const HIDDEN_SLOTS = 8

/** Default half-width of the window a single pick rasterises and searches. */
export const PICK_RADIUS_PX = 4

/** Never allocate an id target larger than this; a 4K canvas does not need 4K picks. */
const MAX_TARGET_PIXELS = 2_600_000

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>

uniform float uBase;
flat varying float vId;

void main() {
  // The identity is the draw's base plus the instance index, which is what lets
  // a nine-hundred-brick batch stay a single draw call in the id pass too.
  vId = uBase + float(gl_InstanceID);

  #ifdef USE_INSTANCING
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  #endif

  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`

const FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>

flat varying float vId;
uniform float uHidden[${HIDDEN_SLOTS}];

void main() {
  #include <clipping_planes_fragment>

  // Occlusion cycling: an identity already walked at this pixel is discarded
  // rather than depth-tested away, so whatever is behind it writes instead.
  for (int slot = 0; slot < ${HIDDEN_SLOTS}; slot += 1) {
    if (uHidden[slot] > 0.5 && abs(uHidden[slot] - vId) < 0.5) discard;
  }

  float id = vId;
  float r = floor(id / 65536.0);
  float g = floor(mod(id, 65536.0) / 256.0);
  float b = floor(mod(id, 256.0));
  gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}
`

/**
 * The material currently driving an id pass, or null.
 *
 * Module-scoped because `onBeforeRender` is installed once per pickable object
 * and fires on *every* render, including the beauty pass. Reading the active
 * material here means the handler is a single null check on the hot path
 * instead of a per-object branch on renderer state.
 */
let activeIdMaterial: THREE.ShaderMaterial | null = null

/**
 * Marks an object as pickable and gives it an identity range.
 *
 * Called from the batch and single-part components, which are the only places
 * that know which parts an object draws and in what instance order.
 */
export function registerPickable(object: THREE.Object3D, base: number) {
  object.userData.pickIdBase = base
  object.layers.enable(PICK_LAYER)
  object.onBeforeRender = idPassBeforeRender
}

/** Removes an object from the id pass without disturbing its beauty rendering. */
export function unregisterPickable(object: THREE.Object3D) {
  delete object.userData.pickIdBase
  object.layers.disable(PICK_LAYER)
  object.onBeforeRender = THREE.Object3D.prototype.onBeforeRender
}

function idPassBeforeRender(this: THREE.Object3D) {
  const material = activeIdMaterial
  if (!material) return
  const base = this.userData.pickIdBase
  material.uniforms.uBase.value = typeof base === 'number' ? base : NO_ID
  // ShaderMaterial uniforms are only re-uploaded when this is set, and it is
  // cleared by the renderer after each upload, so it has to be set per draw.
  material.uniformsNeedUpdate = true
}

export interface PickResult {
  readonly id: number
  readonly partId: string | null
  /** Milliseconds from the call to the resolved identity, including readback. */
  readonly latencyMs: number
}

export interface RegionResult {
  readonly ids: readonly number[]
  readonly partIds: readonly string[]
  /** Covered pixels per selected part, in the same order as `partIds`. */
  readonly pixels: readonly number[]
  readonly latencyMs: number
}

export interface IdPassOptions {
  /** Ceiling on the id target's pixel count. Lower trades pick precision for cost. */
  readonly maxPixels?: number
  /**
   * Identity registry to share.
   *
   * The bases handed to each batch are decided where the batch plan is built,
   * which is outside the canvas; the pass that reads them is inside it. Sharing
   * one registry is what keeps those two in step — a pass with its own registry
   * would resolve identities against a numbering nothing was drawn with.
   */
  readonly registry?: PickRegistry
}

/**
 * Owns the identity render target and everything that reads from it.
 *
 * Deliberately not a React component: picking is called from pointer handlers,
 * from the WebMCP surface and from the acceptance run, none of which are inside
 * a render. The React layer's only job is to construct one of these, keep it fed
 * with the current registry, and dispose it.
 */
export class IdPass {
  readonly registry: PickRegistry

  private target: THREE.WebGLRenderTarget | null = null
  private material: THREE.ShaderMaterial
  private patchCamera: THREE.Camera | null = null
  private patchBuffer = new Uint8Array(0)
  private regionBuffer = new Uint8Array(0)
  private hidden = new Float32Array(HIDDEN_SLOTS)
  private lastPassMs = 0
  private passes = 0

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly options: IdPassOptions = {},
  ) {
    this.registry = options.registry ?? new PickRegistry()
    this.material = rendererResources.track(
      'id-pass',
      'material',
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms: {
          uBase: { value: 0 },
          uHidden: { value: this.hidden },
        },
        // The pass is a data write, not an image: no blending, no tone mapping,
        // no colour management. Anything that touched the bytes would corrupt
        // the identities they encode.
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
      'identity shader',
    )
  }

  /** Current id target size in pixels, or zero before the first pass. */
  get size(): { width: number; height: number } {
    return this.target ? { width: this.target.width, height: this.target.height } : { width: 0, height: 0 }
  }

  /**
   * Scale from CSS pixels to id-buffer pixels.
   *
   * Every coordinate entering this class comes from `getBoundingClientRect`,
   * so it is in **CSS** pixels. The id target is sized from the *drawing*
   * buffer, which is CSS pixels times the device pixel ratio and then capped.
   * Dividing by the drawing buffer instead of by the element's CSS width drops
   * the device pixel ratio from the conversion, and on a 1.65× display that
   * lands every pick roughly forty per cent of the way toward the top-left
   * corner — close enough to still hit the model, which is exactly why it is
   * worth stating: the failure looks like it works.
   */
  get scale(): number {
    if (!this.target) return 1
    const cssWidth = this.renderer.domElement.clientWidth
    if (cssWidth > 0) return this.target.width / cssWidth
    const drawing = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    return drawing.x > 0 ? this.target.width / drawing.x : 1
  }

  get diagnostics(): { passes: number; lastPassMs: number; width: number; height: number; identities: number; draws: number } {
    return {
      passes: this.passes,
      lastPassMs: this.lastPassMs,
      ...this.size,
      identities: this.registry.size,
      draws: this.registry.drawCount,
    }
  }

  /**
   * Sizes the target to the drawing buffer, capped.
   *
   * Recreated rather than resized because a `WebGLRenderTarget` resize discards
   * its attachments anyway, and going through the registry keeps the old one's
   * disposal accounted for instead of leaving it to chance.
   */
  private ensureTarget(): THREE.WebGLRenderTarget {
    const drawing = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const cap = this.options.maxPixels ?? MAX_TARGET_PIXELS
    const area = Math.max(1, drawing.x * drawing.y)
    const shrink = area > cap ? Math.sqrt(cap / area) : 1
    const width = Math.max(1, Math.floor(drawing.x * shrink))
    const height = Math.max(1, Math.floor(drawing.y * shrink))
    if (this.target && this.target.width === width && this.target.height === height) return this.target
    if (this.target) rendererResources.release(this.target)
    this.target = rendererResources.track(
      'id-pass',
      'renderTarget',
      new THREE.WebGLRenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        // Identities must survive readback byte-exact, so no filtering and no
        // colour transform. A linear filter between two identities produces a
        // third one that belongs to a different part entirely.
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
        colorSpace: THREE.NoColorSpace,
        samples: 0,
      }),
      'identity target',
    )
    return this.target
  }

  /**
   * Draws the identity pass.
   *
   * `viewOffset` restricts rasterisation to a window of the frame, which is what
   * makes a single pick cost a few hundred fragments instead of two million.
   */
  private renderPass(
    camera: THREE.Camera,
    target: THREE.WebGLRenderTarget,
    hidden: readonly number[],
    viewOffset: { x: number; y: number; width: number; height: number } | null,
  ) {
    const renderer = this.renderer
    const scene = this.scene
    const started = typeof performance !== 'undefined' ? performance.now() : 0

    const previousTarget = renderer.getRenderTarget()
    const previousOverride = scene.overrideMaterial
    const previousBackground = scene.background
    const previousClear = renderer.getClearColor(new THREE.Color())
    const previousClearAlpha = renderer.getClearAlpha()
    const previousShadowAuto = renderer.shadowMap.autoUpdate
    const previousToneMapping = renderer.toneMapping

    const pickCamera = this.preparePatchCamera(camera, target, viewOffset)

    for (let slot = 0; slot < HIDDEN_SLOTS; slot += 1) this.hidden[slot] = hidden[slot] ?? 0
    this.material.uniforms.uHidden.value = this.hidden
    this.material.uniformsNeedUpdate = true

    // Identity 0 is "background", and the buffer is read back exactly as
    // cleared, so the clear colour must decode to 0 rather than to the
    // interface's dark teal — which decodes to a real part.
    renderer.setClearColor(0x000000, 0)
    // The scene's shadow maps describe the beauty pass; re-rendering them for a
    // pass that ignores lighting is pure cost. `autoUpdate` is used rather than
    // `enabled` because toggling `enabled` changes a shader define and would
    // recompile every material in the scene, twice per pick.
    renderer.shadowMap.autoUpdate = false
    renderer.toneMapping = THREE.NoToneMapping
    scene.background = null
    scene.overrideMaterial = this.material
    activeIdMaterial = this.material

    try {
      renderer.setRenderTarget(target)
      renderer.clear(true, true, false)
      renderer.render(scene, pickCamera)
    } finally {
      activeIdMaterial = null
      scene.overrideMaterial = previousOverride
      scene.background = previousBackground
      renderer.setRenderTarget(previousTarget)
      renderer.setClearColor(previousClear, previousClearAlpha)
      renderer.shadowMap.autoUpdate = previousShadowAuto
      renderer.toneMapping = previousToneMapping
      this.lastPassMs = (typeof performance !== 'undefined' ? performance.now() : 0) - started
      this.passes += 1
    }
  }

  /**
   * A stand-in camera carrying the live pose and, optionally, a view offset.
   *
   * The live camera is never mutated: `setViewOffset` dirties its projection
   * matrix, and a pick that left the operator's camera subtly reprojected would
   * be a defect that only shows up as drift after a few hundred clicks.
   */
  private preparePatchCamera(
    camera: THREE.Camera,
    target: THREE.WebGLRenderTarget,
    viewOffset: { x: number; y: number; width: number; height: number } | null,
  ): THREE.Camera {
    const source = camera as THREE.PerspectiveCamera & THREE.OrthographicCamera
    let clone = this.patchCamera as (THREE.PerspectiveCamera & THREE.OrthographicCamera) | null
    // The clone is rebuilt when the projection type changes, which happens when
    // the operator switches to the orthographic diagnostic view.
    const wrongType =
      !clone ||
      Boolean((clone as THREE.PerspectiveCamera).isPerspectiveCamera) !== Boolean(source.isPerspectiveCamera)
    if (wrongType) {
      clone = (source.isPerspectiveCamera
        ? new THREE.PerspectiveCamera()
        : new THREE.OrthographicCamera()) as THREE.PerspectiveCamera & THREE.OrthographicCamera
      this.patchCamera = clone
    }
    clone!.copy(source, false)
    clone!.layers.set(PICK_LAYER)
    if (viewOffset) {
      clone!.setViewOffset(target.width, target.height, viewOffset.x, viewOffset.y, viewOffset.width, viewOffset.height)
    } else {
      clone!.clearViewOffset()
    }
    clone!.updateMatrixWorld(true)
    clone!.updateProjectionMatrix()
    return clone!
  }

  /** Compile the real visible identity draws, not an off-canvas patch which
   * frustum-culls every brick and leaves the first real click cold. */
  warm(camera: THREE.Camera): void {
    const target = this.ensureTarget()

    // The full-frame path, which `pickRegion` takes for a marquee.
    this.renderPass(camera, target, [], null)
    this.renderer.readRenderTargetPixels(target, 0, 0, 1, 1, new Uint8Array(4))

    // And the windowed path, which `pick` takes for every click. These are not
    // the same pass: a pick renders through `setViewOffset` and reads a
    // `patch × patch` block out of the target's bottom-left corner, so warming
    // only the full frame leaves the first real click paying for the offset
    // projection and the larger readback. That was the whole cost the warm-up
    // exists to remove, and measuring it is the only way to know it was.
    const patch = PICK_RADIUS_PX * 2 + 1
    this.renderPass(camera, target, [], { x: 0, y: 0, width: patch, height: patch })
    if (this.patchBuffer.length < patch * patch * 4) this.patchBuffer = new Uint8Array(patch * patch * 4)
    this.renderer.readRenderTargetPixels(target, 0, target.height - patch, patch, patch, this.patchBuffer)
  }

  /**
   * Resolves the part under a canvas point.
   *
   * `hidden` carries the identities already walked at this pixel, which is what
   * turns a repeated click into occlusion cycling.
   */
  pick(
    camera: THREE.Camera,
    canvasX: number,
    canvasY: number,
    options: { readonly radius?: number; readonly hidden?: readonly number[] } = {},
  ): PickResult {
    const started = typeof performance !== 'undefined' ? performance.now() : 0
    const target = this.ensureTarget()
    const scale = this.scale
    const radius = Math.max(0, Math.round(options.radius ?? PICK_RADIUS_PX))
    const patch = radius * 2 + 1
    const x = Math.round(canvasX * scale)
    const y = Math.round(canvasY * scale)

    this.renderPass(camera, target, options.hidden ?? [], {
      x: x - radius,
      y: y - radius,
      width: patch,
      height: patch,
    })

    const needed = patch * patch * 4
    if (this.patchBuffer.length < needed) this.patchBuffer = new Uint8Array(needed)
    // The window is rasterised into the target's bottom-left corner, because
    // `setViewOffset` maps the sub-window across the whole target and the target
    // is only read at `patch × patch`.
    this.renderer.readRenderTargetPixels(target, 0, target.height - patch, patch, patch, this.patchBuffer)

    const id = nearestIdInPatch(this.patchBuffer, patch, patch, radius, radius, true)
    return {
      id,
      partId: this.registry.resolve(id),
      latencyMs: (typeof performance !== 'undefined' ? performance.now() : 0) - started,
    }
  }

  /**
   * Selects every part whose pixels fall inside a region.
   *
   * The full frame is rasterised here rather than a window, because the region
   * *is* the window and it can be most of the screen. Only the region's bounding
   * box is read back.
   */
  pickRegion(camera: THREE.Camera, shape: RegionShape, options: RegionOptions = {}): RegionResult {
    const started = typeof performance !== 'undefined' ? performance.now() : 0
    const target = this.ensureTarget()
    const scale = this.scale
    const scaled = scaleShape(shape, scale)
    this.renderPass(camera, target, [], null)

    const bounds = regionBounds(scaled, target.width, target.height)
    if (!bounds.width || !bounds.height) {
      return { ids: [], partIds: [], pixels: [], latencyMs: 0 }
    }
    const needed = bounds.width * bounds.height * 4
    if (this.regionBuffer.length < needed) this.regionBuffer = new Uint8Array(needed)
    // `readRenderTargetPixels` addresses from the bottom-left; the region is in
    // top-left screen coordinates, so the row origin is mirrored here and the
    // rows are un-mirrored during counting.
    this.renderer.readRenderTargetPixels(
      target,
      bounds.left,
      target.height - bounds.top - bounds.height,
      bounds.width,
      bounds.height,
      this.regionBuffer,
    )

    const mask = rasterizeRegion(scaled, bounds)
    const coverage = coverageInRegion(this.regionBuffer, bounds, mask, { ...options, flipY: true })
    const ids: number[] = []
    const partIds: string[] = []
    const pixels: number[] = []
    for (const entry of coverage) {
      const partId = this.registry.resolve(entry.id)
      if (!partId) continue
      ids.push(entry.id)
      partIds.push(partId)
      pixels.push(entry.pixels)
    }
    return {
      ids,
      partIds,
      pixels,
      latencyMs: (typeof performance !== 'undefined' ? performance.now() : 0) - started,
    }
  }

  /** Frees the target. The shader is shared and released with the registry scope. */
  dispose() {
    if (this.target) {
      rendererResources.release(this.target)
      this.target = null
    }
    rendererResources.release(this.material)
    this.patchBuffer = new Uint8Array(0)
    this.regionBuffer = new Uint8Array(0)
  }

  /** Rebuilds the shader and target after a context loss. */
  restore() {
    if (this.target) {
      rendererResources.release(this.target)
      this.target = null
    }
    this.material.needsUpdate = true
  }
}

/** Maps a shape from canvas pixels into id-buffer pixels. */
function scaleShape(shape: RegionShape, scale: number): RegionShape {
  if (scale === 1) return shape
  if (shape.kind === 'box') {
    return { kind: 'box', x0: shape.x0 * scale, y0: shape.y0 * scale, x1: shape.x1 * scale, y1: shape.y1 * scale }
  }
  return { kind: 'lasso', points: shape.points.map(([x, y]) => [x * scale, y * scale] as const) }
}

/**
 * Occlusion cycling state.
 *
 * Kept out of `IdPass` because it is an *interaction* concern: what counts as
 * "the same click again" is a question about pointers and time, not about
 * buffers. Separating them means the cycle rules can be unit tested without a
 * GPU, which is the only way to assert that the cycle is monotonic.
 */
export class OcclusionCycle {
  private anchor: { x: number; y: number } | null = null
  private walked: number[] = []
  private lastAt = -Infinity

  constructor(
    private readonly radiusPx = 3,
    private readonly timeoutMs = 1400,
  ) {}

  /**
   * Identities to hide for the next pick at this point.
   *
   * A click that moved, or that came after the timeout, restarts the walk — an
   * operator who clicks the same brick a minute later means "select this",
   * not "give me the fourth thing behind it".
   */
  hiddenFor(x: number, y: number, now: number): number[] {
    const continued =
      this.anchor !== null &&
      now - this.lastAt <= this.timeoutMs &&
      Math.hypot(x - this.anchor.x, y - this.anchor.y) <= this.radiusPx
    if (!continued) {
      this.anchor = { x, y }
      this.walked = []
    }
    this.lastAt = now
    return [...this.walked]
  }

  /**
   * Records what the pick returned.
   *
   * Background ends the walk and restarts it, so the cycle loops back to the
   * frontmost part rather than becoming permanently exhausted.
   */
  record(id: number) {
    if (id === NO_ID) {
      this.walked = []
      return
    }
    if (this.walked.length >= HIDDEN_SLOTS) {
      this.walked = []
      return
    }
    this.walked.push(id)
  }

  reset() {
    this.anchor = null
    this.walked = []
    this.lastAt = -Infinity
  }

  get depth(): number {
    return this.walked.length
  }
}

/** Re-exported so a caller can encode an identity without importing two modules. */
export { encodeId }
