import * as THREE from 'three'
import { catalog, STUD_LDU } from '../../cad/catalog'
import { loadCompiledCatalog } from '../../cad/catalog-loader'
import { geometryCache, MAIN_COLOUR } from '../../cad/mesh'
import { IDENTITY_BASIS } from '../../cad/math'
import type { PartDefinition, PartInstance, Transform } from '../../cad/types'
import { createEnvironment } from '../environment'
import { buildMergedEdgeGeometry, planBatches, type BatchMember } from '../PartBatch'
import { surfaceMaterialFor } from '../PartVisual'
import { IdPass, registerPickable } from './idPass'
import { QUALITY_TIERS } from './quality'
import { rendererResources } from './resources'
import type { RegionShape } from './regionSelect'

/**
 * The renderer's own benchmark.
 *
 * Every performance claim this workstream makes is produced here, in a real
 * browser, against real compiled LDraw geometry, with the same materials,
 * batching, merged edges, environment and lighting the viewport uses. Nothing is
 * stubbed, because a benchmark that measures a simplified scene measures a
 * program nobody runs.
 *
 * It builds its *own* renderer rather than driving the mounted editor for one
 * reason: the editor's canvas is one of several things on the page competing for
 * the same GPU, and a frame time measured with a React tree, a catalogue panel
 * and a command deck also rendering is not attributable to the renderer. Here
 * the only thing on the page is the scene being measured.
 *
 * The layout is a stacked block — a footprint of bricks repeated up through
 * courses, in a handful of part/colour combinations. That is deliberately the
 * *favourable* case for instanced batching and it is also what a real model
 * looks like: a building is a few dozen distinct part/colour pairs repeated
 * thousands of times. The draw-call assertion is what keeps this honest, since
 * it proves the batching is what is carrying the frame rate.
 */

export interface BenchmarkScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly parts: readonly PartInstance[]
}

export interface FrameStats {
  readonly frames: number
  readonly durationMs: number
  /** Frames per second over the measured window, warm-up excluded. */
  readonly meanFps: number
  /** The 5th percentile of instantaneous FPS: the slow frames, which are what stutter. */
  readonly p5Fps: number
  readonly p50Fps: number
  /** Worst single frame in the window, as FPS. */
  readonly minFps: number
  readonly meanFrameMs: number
  readonly p95FrameMs: number
  readonly drawCalls: number
  readonly triangles: number
  readonly programs: number
  readonly geometries: number
}

export interface PickStats {
  readonly picks: number
  readonly hits: number
  readonly meanMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
}

const COLOURS = [4, 15, 1, 14, 71, 0, 2]
/** Bricks and plates that exist in every compiled catalog build. */
const DEFINITIONS = ['3001', '3003', '3004', '3005', '3024', '3020', '3023']

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (!sorted.length) return 0
  const position = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[position]
}

/**
 * Lays out `count` parts as a stacked block.
 *
 * Courses are half-offset like real brickwork so that neighbouring parts
 * genuinely overlap in the broad phase — a grid of non-touching bricks would
 * make every spatial structure in the application look faster than it is.
 */
export function layoutBlock(count: number, definitions: readonly PartDefinition[]): PartInstance[] {
  const parts: PartInstance[] = []
  const perRow = Math.max(4, Math.ceil(Math.sqrt(count / 6)))
  const identity: Transform = { position: [0, 0, 0], basis: IDENTITY_BASIS }
  for (let index = 0; index < count; index += 1) {
    const layer = Math.floor(index / (perRow * perRow))
    const withinLayer = index % (perRow * perRow)
    const row = Math.floor(withinLayer / perRow)
    const column = withinLayer % perRow
    const definition = definitions[index % definitions.length]
    parts.push({
      id: `bench_${index}`,
      definitionId: definition.canonicalId,
      color: COLOURS[(index + layer) % COLOURS.length],
      transform: {
        ...identity,
        position: [
          column * STUD_LDU * 2 + (layer % 2 ? STUD_LDU : 0),
          -layer * 24,
          row * STUD_LDU * 2 + (layer % 2 ? STUD_LDU : 0),
        ],
      },
      subassemblyId: 'bench',
      stepId: 'bench',
      provenance: 'human',
      protected: false,
    })
  }
  return parts
}

/** Ensures the compiled catalog and the benchmark's geometry are resident. */
export async function prepareCatalog(baseUrl = ''): Promise<PartDefinition[]> {
  if (!catalog.loaded) await loadCompiledCatalog(baseUrl)
  const definitions = DEFINITIONS.map((id) => catalog.get(id)).filter(
    (definition): definition is PartDefinition => Boolean(definition?.geometryAsset),
  )
  if (!definitions.length) throw new Error('The compiled catalog carries no placeable geometry to benchmark.')
  await geometryCache.preload(definitions)
  return definitions
}

/**
 * Builds a scene that matches the viewport's own construction.
 *
 * The lighting, environment, tone mapping and shadow configuration are copied
 * from `CadViewport` rather than simplified, because shadows and the prefiltered
 * environment are a real share of the frame and a benchmark without them would
 * flatter the renderer by a factor that varies with model size.
 */
export function buildBenchmarkScene(
  canvas: HTMLCanvasElement,
  parts: readonly PartInstance[],
  options: { readonly qualityIndex?: number; readonly dpr?: number } = {},
): BenchmarkScene {
  const tier = QUALITY_TIERS[Math.min(QUALITY_TIERS.length - 1, Math.max(0, options.qualityIndex ?? 1))]
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: tier.antialias,
    alpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(options.dpr ?? window.devicePixelRatio ?? 1, tier.maxDpr))
  renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 800, false)
  renderer.setClearColor('#0b1012')
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.92
  renderer.shadowMap.enabled = tier.shadowMapSize > 0
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.info.autoReset = false

  const scene = new THREE.Scene()
  scene.environment = rendererResources.track('benchmark', 'texture', createEnvironment(renderer, 'studio'))
  scene.environmentIntensity = tier.environmentIntensity

  const key = new THREE.DirectionalLight('#fff4e6', 1.7)
  key.position.set(-16, 24, 13)
  key.castShadow = tier.shadowMapSize > 0
  key.shadow.mapSize.set(tier.shadowMapSize || 1, tier.shadowMapSize || 1)
  key.shadow.bias = -0.0006
  key.shadow.normalBias = 0.02
  scene.add(key)
  scene.add(new THREE.HemisphereLight('#c3d6db', '#0b0f11', 0.22))
  const fill = new THREE.DirectionalLight('#8cddeb', 0.42)
  fill.position.set(18, 9, -17)
  scene.add(fill)

  const root = new THREE.Group()
  root.rotation.x = Math.PI
  root.scale.setScalar(1 / STUD_LDU)
  scene.add(root)

  const members: BatchMember[] = parts.map((part) => ({ part, transform: part.transform }))
  populateBatches(root, members)

  const bounds = new THREE.Box3().setFromObject(root)
  const centre = bounds.getCenter(new THREE.Vector3())
  const extent = Math.max(8, bounds.getSize(new THREE.Vector3()).length() * 0.5)
  const aspect = (canvas.clientWidth || 1280) / (canvas.clientHeight || 800)
  const camera = new THREE.PerspectiveCamera(34, aspect, 0.1, 4000)
  camera.position.copy(centre).add(new THREE.Vector3(0.86, 0.64, 1).normalize().multiplyScalar(extent * 2.4))
  camera.lookAt(centre)
  camera.userData.orbitCentre = centre
  camera.userData.orbitRadius = extent * 2.4

  const shadowExtent = Math.min(180, Math.max(14, extent))
  key.shadow.camera.left = -shadowExtent
  key.shadow.camera.right = shadowExtent
  key.shadow.camera.top = shadowExtent
  key.shadow.camera.bottom = -shadowExtent
  key.shadow.camera.far = shadowExtent * 6
  key.shadow.camera.updateProjectionMatrix()

  return { renderer, scene, camera, parts }
}

const matrixOf = (transform: Transform, target: THREE.Matrix4): THREE.Matrix4 => {
  const b = transform.basis
  const [x, y, z] = transform.position
  return target.set(b[0], b[1], b[2], x, b[3], b[4], b[5], y, b[6], b[7], b[8], z, 0, 0, 0, 1)
}

/**
 * Adds instanced batches to a group, exactly as the viewport builds them.
 *
 * Returns the number of draws added, which is the quantity the draw-call gate
 * asserts on. Identity registration happens here too, so the benchmark's picking
 * measurements go through the same `IdPass` the editor uses rather than a
 * simplified stand-in.
 */
export function populateBatches(root: THREE.Object3D, members: readonly BatchMember[], idPass?: IdPass): number {
  const plan = planBatches(members, new Set<string>())
  const scratch = new THREE.Matrix4()
  let draws = 0
  for (const descriptor of plan.batches) {
    const geometry = geometryCache.get(descriptor.definition)
    if (!geometry) continue
    const materials = geometry.slices.map((slice) =>
      surfaceMaterialFor(slice.colour === MAIN_COLOUR ? descriptor.colorCode : slice.colour, descriptor.appearance),
    )
    const mesh = new THREE.InstancedMesh(geometry.surface, materials as unknown as THREE.Material, descriptor.members.length)
    descriptor.members.forEach((member, index) => mesh.setMatrixAt(index, matrixOf(member.transform, scratch)))
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.computeBoundingSphere()
    mesh.userData.members = descriptor.members
    if (idPass) {
      registerPickable(mesh, idPass.registry.reserve(descriptor.members.map((member) => member.part.id)))
    }
    root.add(mesh)
    draws += 1

    const merged = buildMergedEdgeGeometry(descriptor.members, geometry.edges)
    if (merged) {
      const line = new THREE.LineSegments(
        merged,
        new THREE.LineBasicMaterial({
          color: catalog.color(descriptor.colorCode).edge,
          transparent: true,
          opacity: 0.34,
          depthWrite: false,
        }),
      )
      root.add(line)
      draws += 1
    }
  }
  return draws
}

/**
 * Measures a fixed orbit.
 *
 * The camera moves for the whole window, because a static camera lets the driver
 * cache work that a real session never gets to cache, and because upload and
 * cull cost only appear when the view changes. Warm-up frames are discarded: the
 * first frames of a scene include shader compilation and the first shadow map,
 * neither of which recurs, and including them would report a number no operator
 * ever experiences.
 */
export function measureFrames(
  scene: BenchmarkScene,
  options: { readonly durationMs?: number; readonly warmupFrames?: number } = {},
): Promise<FrameStats> {
  const duration = options.durationMs ?? 3000
  const warmup = options.warmupFrames ?? 20
  const { renderer, camera } = scene
  const centre = camera.userData.orbitCentre as THREE.Vector3
  const radius = camera.userData.orbitRadius as number
  const startAngle = Math.atan2(camera.position.z - centre.z, camera.position.x - centre.x)
  const height = camera.position.y - centre.y

  return new Promise<FrameStats>((resolve) => {
    const frameTimes: number[] = []
    let frame = 0
    let last = performance.now()
    let measurementStart = 0

    const step = () => {
      const now = performance.now()
      const delta = now - last
      last = now
      frame += 1

      const angle = startAngle + (frame * Math.PI) / 240
      camera.position.set(centre.x + Math.cos(angle) * radius, centre.y + height, centre.z + Math.sin(angle) * radius)
      camera.lookAt(centre)

      renderer.info.reset()
      renderer.render(scene.scene, camera)

      if (frame === warmup) measurementStart = now
      if (frame > warmup) frameTimes.push(delta)

      const elapsed = measurementStart ? now - measurementStart : 0
      if (frame <= warmup || elapsed < duration) {
        requestAnimationFrame(step)
        return
      }

      const sorted = [...frameTimes].sort((a, b) => a - b)
      const total = frameTimes.reduce((sum, value) => sum + value, 0)
      resolve({
        frames: frameTimes.length,
        durationMs: total,
        meanFps: total > 0 ? (frameTimes.length * 1000) / total : 0,
        // Percentiles run over frame *times*, so the slow tail is the high end;
        // converting to FPS inverts the ordering, which is why p5 FPS reads off
        // the 95th percentile frame time.
        p5Fps: 1000 / Math.max(1e-6, percentile(sorted, 0.95)),
        p50Fps: 1000 / Math.max(1e-6, percentile(sorted, 0.5)),
        minFps: 1000 / Math.max(1e-6, sorted[sorted.length - 1] ?? 1),
        meanFrameMs: frameTimes.length ? total / frameTimes.length : 0,
        p95FrameMs: percentile(sorted, 0.95),
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length ?? 0,
        geometries: renderer.info.memory.geometries,
      })
    }
    requestAnimationFrame(step)
  })
}

/**
 * Measures pick latency over a grid of points covering the model.
 *
 * Points are spread rather than repeated so the measurement includes misses,
 * edges and dense interiors — repeating one point would measure a warm driver
 * path and nothing else. Latency is wall time from the call to a resolved part
 * id, which includes the render, the synchronous `readPixels` stall and the
 * resolution, because that stall is the whole reason GPU picking needs measuring
 * at all.
 */
export function measurePicks(
  scene: BenchmarkScene,
  idPass: IdPass,
  canvas: HTMLCanvasElement,
  samples = 240,
): PickStats {
  const width = canvas.clientWidth || canvas.width
  const height = canvas.clientHeight || canvas.height
  const side = Math.ceil(Math.sqrt(samples))
  const timings: number[] = []
  let hits = 0
  for (let index = 0; index < samples; index += 1) {
    const column = index % side
    const row = Math.floor(index / side)
    const x = ((column + 0.5) / side) * width
    const y = ((row + 0.5) / side) * height
    const started = performance.now()
    const result = idPass.pick(scene.camera, x, y)
    timings.push(performance.now() - started)
    if (result.partId) hits += 1
  }
  const sorted = [...timings].sort((a, b) => a - b)
  return {
    picks: timings.length,
    hits,
    meanMs: timings.reduce((sum, value) => sum + value, 0) / Math.max(1, timings.length),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
  }
}

/** One frame's renderer counters, for the draw-call gate. */
export function sampleCounters(scene: BenchmarkScene): { drawCalls: number; triangles: number; geometries: number } {
  scene.renderer.info.reset()
  scene.renderer.render(scene.scene, scene.camera)
  return {
    drawCalls: scene.renderer.info.render.calls,
    triangles: scene.renderer.info.render.triangles,
    geometries: scene.renderer.info.memory.geometries,
  }
}

export interface RegionCorrectnessCase {
  readonly shape: RegionShape
  readonly selected: readonly string[]
  readonly centreSelected: readonly string[]
}

/** Screen position of a part's centre, for comparing against the covered-pixel rule. */
export function projectPartCentre(
  scene: BenchmarkScene,
  root: THREE.Object3D,
  part: PartInstance,
  canvas: HTMLCanvasElement,
): { x: number; y: number; behindCamera: boolean } {
  const definition = catalog.get(part.definitionId)
  const bounds = definition?.dimensions?.bounds
  const local = bounds
    ? new THREE.Vector3(
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2,
      )
    : new THREE.Vector3()
  const matrix = matrixOf(part.transform, new THREE.Matrix4())
  const world = local.applyMatrix4(matrix).applyMatrix4(root.matrixWorld)
  const projected = world.clone().project(scene.camera)
  return {
    x: ((projected.x + 1) / 2) * (canvas.clientWidth || canvas.width),
    y: ((1 - projected.y) / 2) * (canvas.clientHeight || canvas.height),
    behindCamera: projected.z > 1,
  }
}

/** Frees everything a benchmark run allocated, so repeated runs do not accumulate. */
export function disposeBenchmark(scene: BenchmarkScene) {
  scene.scene.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.geometry) return
    // Batch geometry is shared with the catalog cache and must survive; merged
    // edge buffers are built per batch and are this scene's to free.
    if (mesh.type === 'LineSegments') mesh.geometry.dispose()
  })
  rendererResources.releaseScope('benchmark')
  scene.renderer.dispose()
}
