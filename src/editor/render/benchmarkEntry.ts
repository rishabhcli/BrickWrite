import * as THREE from 'three'
import { catalog, STUD_LDU } from '../../cad/catalog'
import { lduToScene } from './frame'
import { IDENTITY_BASIS } from '../../cad/math'
import type { PartDefinition, PartInstance } from '../../cad/types'
import {
  buildBenchmarkScene,
  disposeBenchmark,
  layoutBlock,
  measureFrames,
  measurePicks,
  measureRenderCost,
  populateBatches,
  prepareCatalog,
  projectPartCentre,
  sampleCounters,
  type BenchmarkScene,
  type FrameStats,
  type PickStats,
  type RenderCostStats,
} from './benchmark'
import { IdPass } from './idPass'
import { centresInRegion, type RegionShape } from './regionSelect'
import { rendererResources } from './resources'

/**
 * Browser entry for the renderer benchmark.
 *
 * Loaded by `tools/e2e/renderer.mjs` into a page of its own so that the numbers
 * describe the renderer rather than the renderer plus a React tree, a catalogue
 * panel and a command deck. Everything it measures runs against the real
 * compiled catalog, the real geometry cache and the real materials.
 */

interface RunResult {
  readonly parts: number
  readonly frames: FrameStats
  /**
   * The renderer's own cost, with the display's refresh rate taken out of the
   * measurement.
   *
   * A 120 Hz panel reports 120 FPS for a scene costing four milliseconds and
   * for one costing eight, so a vsync-bound figure says nothing about how much
   * headroom is left before a model stops being interactive. This does.
   */
  readonly cost: RenderCostStats
  readonly renderer: string
  readonly qualityTier: string
}

let scene: BenchmarkScene | null = null
let idPass: IdPass | null = null
let canvas: HTMLCanvasElement | null = null
let definitions: PartDefinition[] = []

function ensureCanvas(width: number, height: number): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.id = 'benchmark-canvas'
    canvas.style.display = 'block'
    document.body.style.margin = '0'
    document.body.appendChild(canvas)
  }
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  return canvas
}

/** The GPU actually doing the work, so a number is attributable to a machine. */
function rendererName(renderer: THREE.WebGLRenderer): string {
  try {
    const context = renderer.getContext()
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    const unmasked = debug ? (context.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string) : null
    return unmasked ?? (context.getParameter(context.RENDERER) as string)
  } catch {
    return 'unknown'
  }
}

function teardown() {
  if (idPass) {
    idPass.dispose()
    idPass = null
  }
  if (scene) {
    disposeBenchmark(scene)
    scene = null
  }
}

const part = (id: string, definitionId: string, position: [number, number, number]): PartInstance => ({
  id,
  definitionId,
  color: 4,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'bench',
  stepId: 'bench',
  provenance: 'human',
  protected: false,
})

export interface BenchmarkApi {
  prepare(): Promise<{ definitions: number; renderer: string }>
  run(options: { count: number; durationMs?: number; width?: number; height?: number; qualityIndex?: number }): Promise<RunResult>
  picks(samples?: number): PickStats
  drawCallDelta(options: { base: number; extra: number }): { before: number; after: number; delta: number; trianglesBefore: number; trianglesAfter: number }
  regionCorrectness(): Promise<RegionCorrectnessReport>
  resources(): Record<string, number>
  dispose(): void
}

export interface RegionCorrectnessReport {
  /** The pick at the buried part's projected centre must return the occluder. */
  readonly occluderConfirmed: string | null
  readonly beamCoveredPixels: readonly string[]
  readonly beamCentreRule: readonly string[]
  readonly buriedCoveredPixels: readonly string[]
  readonly buriedCentreRule: readonly string[]
  readonly beamCentre: { x: number; y: number }
  readonly buriedCentre: { x: number; y: number }
}

/**
 * A scene built to make the two rules disagree, against real WebGL.
 *
 * Three parts, chosen so the arrangement is one that occurs in every model:
 *
 *   beam     a 1×4 brick. Long enough that a region over one end contains its
 *            pixels and not its centre.
 *   buried   a 1×1 plate, entirely behind a 2×4 brick.
 *   blocker  the 2×4 doing the burying.
 *
 * The occlusion is *confirmed* rather than assumed: a single pick at the buried
 * part's own projected centre must come back as the blocker. If the arrangement
 * ever stops occluding, the report says so and the assertion fails loudly rather
 * than passing because nothing was found.
 */
async function regionCorrectness(): Promise<RegionCorrectnessReport> {
  teardown()
  const width = 1200
  const height = 800
  const element = ensureCanvas(width, height)
  const beam = part('beam', definitions.find((d) => d.canonicalId === '3010') ? '3010' : definitions[0].canonicalId, [0, 0, 0])
  const blocker = part('blocker', '3001', [0, 200, -60])
  const buried = part('buried', '3024', [0, 216, 0])

  scene = buildBenchmarkScene(element, [beam, blocker, buried], { qualityIndex: 1 })

  /**
   * Aim the camera straight down the occlusion axis.
   *
   * The benchmark's default three-quarter view is right for measuring a model
   * and wrong for this: an oblique view slides the blocker sideways off the
   * part it is supposed to bury, and the arrangement stops testing anything. In
   * LDraw's frame +Y is down and the root turns 180° about X, so the scene's +Z
   * is the document's −Z — which is where the blocker sits relative to the
   * buried plate.
   */
  const focus = new THREE.Vector3(0, (lduToScene(buried.transform.position).y + lduToScene(beam.transform.position).y) / 2, 0)
  scene.camera.position.set(focus.x, focus.y, focus.z + 40)
  scene.camera.lookAt(focus)
  scene.camera.updateMatrixWorld(true)
  scene.camera.updateProjectionMatrix()

  const root = scene.scene.children.find((child) => child.type === 'Group') as THREE.Group
  // The batches built by `buildBenchmarkScene` are not registered for picking;
  // rebuild them here through the identity registry so the pass has ids.
  root.clear()
  idPass = new IdPass(scene.renderer, scene.scene)
  populateBatches(root, [beam, blocker, buried].map((instance) => ({ part: instance, transform: instance.transform })), idPass)
  scene.scene.updateMatrixWorld(true)
  scene.renderer.render(scene.scene, scene.camera)

  const centreOf = (instance: PartInstance) => projectPartCentre(scene!, root, instance, element)
  const beamCentre = centreOf(beam)
  const buriedCentre = centreOf(buried)
  const blockerCentre = centreOf(blocker)

  // The beam's right-hand end in document space, projected.
  const beamEnd = projectPartCentre(scene, root, { ...beam, transform: { ...beam.transform, position: [34, 0, 0] } }, element)

  const around = (x: number, y: number, radius: number): RegionShape => ({
    kind: 'lasso',
    points: Array.from({ length: 12 }, (_, index) => {
      const angle = (index / 12) * Math.PI * 2
      return [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius] as const
    }),
  })

  const centres = [
    { id: 'beam', x: beamCentre.x, y: beamCentre.y, behindCamera: beamCentre.behindCamera },
    { id: 'buried', x: buriedCentre.x, y: buriedCentre.y, behindCamera: buriedCentre.behindCamera },
    { id: 'blocker', x: blockerCentre.x, y: blockerCentre.y, behindCamera: blockerCentre.behindCamera },
  ]

  // Small enough that the beam's own centre falls outside it, which is the
  // whole point of the case.
  const beamRegion = around(beamEnd.x, beamEnd.y, 14)
  const buriedRegion = around(buriedCentre.x, buriedCentre.y, 14)

  const occluder = idPass.pick(scene.camera, buriedCentre.x, buriedCentre.y, { radius: 0 })

  return {
    occluderConfirmed: occluder.partId,
    beamCoveredPixels: idPass.pickRegion(scene.camera, beamRegion).partIds,
    beamCentreRule: centresInRegion(centres, beamRegion),
    buriedCoveredPixels: idPass.pickRegion(scene.camera, buriedRegion).partIds,
    buriedCentreRule: centresInRegion(centres, buriedRegion),
    beamCentre: { x: beamCentre.x, y: beamCentre.y },
    buriedCentre: { x: buriedCentre.x, y: buriedCentre.y },
  }
}

const api: BenchmarkApi = {
  async prepare() {
    definitions = await prepareCatalog('')
    const probe = new THREE.WebGLRenderer({ canvas: document.createElement('canvas') })
    const name = rendererName(probe)
    probe.dispose()
    return { definitions: definitions.length, renderer: name }
  },

  async run({ count, durationMs = 3000, width = 1600, height = 1000, qualityIndex = 1 }) {
    teardown()
    const element = ensureCanvas(width, height)
    const parts = layoutBlock(count, definitions)
    scene = buildBenchmarkScene(element, parts, { qualityIndex })
    const root = scene.scene.children.find((child) => child.type === 'Group') as THREE.Group
    idPass = new IdPass(scene.renderer, scene.scene)
    root.clear()
    populateBatches(root, parts.map((instance) => ({ part: instance, transform: instance.transform })), idPass)
    scene.scene.updateMatrixWorld(true)
    const frames = await measureFrames(scene, { durationMs })
    const cost = measureRenderCost(scene, 90)
    return {
      parts: parts.length,
      frames,
      cost,
      renderer: rendererName(scene.renderer),
      qualityTier: `index ${qualityIndex}`,
    }
  },

  picks(samples = 240) {
    if (!scene || !idPass || !canvas) throw new Error('Call run() before picks().')
    return measurePicks(scene, idPass, canvas, samples)
  },

  drawCallDelta({ base, extra }) {
    teardown()
    const element = ensureCanvas(1280, 800)
    const parts = layoutBlock(base, definitions)
    scene = buildBenchmarkScene(element, parts, { qualityIndex: 1 })
    const root = scene.scene.children.find((child) => child.type === 'Group') as THREE.Group
    root.clear()
    populateBatches(root, parts.map((instance) => ({ part: instance, transform: instance.transform })))
    scene.scene.updateMatrixWorld(true)
    const before = sampleCounters(scene)

    // The extra parts are laid out beside the block in the same few part/colour
    // combinations, which is what a real agent batch looks like and what
    // instanced batching is supposed to absorb.
    const added = layoutBlock(extra, definitions).map((instance, index) => ({
      ...instance,
      id: `extra_${index}`,
      transform: {
        ...instance.transform,
        position: [
          instance.transform.position[0] + STUD_LDU * 4,
          instance.transform.position[1],
          instance.transform.position[2] + STUD_LDU * 4,
        ] as [number, number, number],
      },
    }))
    // The production viewport rebuilds one batch plan from the next document;
    // it does not append a second set of batches beside the old plan. Appending
    // here measured duplicate batch objects (one extra draw per definition /
    // colour pair), not how draw calls scale with the number of instances.
    for (const child of [...root.children]) {
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose()
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        for (const material of materials) material.dispose()
      }
    }
    root.clear()
    populateBatches(
      root,
      [...parts, ...added].map((instance) => ({ part: instance, transform: instance.transform })),
    )
    scene.scene.updateMatrixWorld(true)
    const after = sampleCounters(scene)

    return {
      before: before.drawCalls,
      after: after.drawCalls,
      delta: after.drawCalls - before.drawCalls,
      trianglesBefore: before.triangles,
      trianglesAfter: after.triangles,
    }
  },

  regionCorrectness,

  resources() {
    return { ...rendererResources.byScope(), total: rendererResources.counts().total }
  },

  dispose() {
    teardown()
  },
}

declare global {
  interface Window {
    __brickwrightBench?: BenchmarkApi
    __brickwrightCatalogReady?: boolean
  }
}

window.__brickwrightBench = api
window.__brickwrightCatalogReady = catalog.loaded
