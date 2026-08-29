import type { ArticulatedJoint } from '../../cad/articulation'
import type { EnvironmentName } from '../environment'
import type { CaptureMetadata } from './capture'
import type { JointHandle } from './jointDrag'
import type { RegionOptions, RegionShape } from './regionSelect'
import type { ResourceCounts } from './resources'
import type { SectionPlane } from './sectionPlanes'
import type { SweepResult } from './sweep'
import type { NamedView, OutsideTreatment } from './visibility'

/**
 * The renderer's imperative surface.
 *
 * Everything here is a *capability*, not a widget. The viewport owns picking,
 * visibility, section planes, joint dragging, motion policy and capture; the
 * panels around it are one client of those capabilities and the acceptance run
 * is another. Exposing them as an interface rather than as props has two
 * consequences that are the reason for doing it:
 *
 *   - The workbench UI can be rebuilt, moved or replaced without the renderer
 *     changing, because it drives the same entry points the tests drive. A
 *     feature that only exists as a React prop is a feature only the current UI
 *     can reach.
 *   - Every acceptance assertion runs through the production code path. A
 *     browser test that reimplements picking in `page.evaluate` proves the test
 *     works; a browser test that calls `pick()` proves the renderer works.
 *
 * It is installed on `window.__brickwrightRenderer`, matching the existing
 * `__brickwrightRenderStats` and `__brickwrightGizmo` probes.
 */

export interface PickOptions {
  /** Search radius in canvas pixels around the point. */
  readonly radius?: number
  /** Advance occlusion cycling rather than always returning the frontmost part. */
  readonly cycle?: boolean
}

export interface PickReport {
  readonly partId: string | null
  readonly id: number
  readonly latencyMs: number
  /** How deep into the occlusion stack this pick was; 0 is the frontmost. */
  readonly cycleDepth: number
}

export interface RegionReport {
  readonly partIds: readonly string[]
  readonly pixels: readonly number[]
  readonly latencyMs: number
  /**
   * What the old projected-centre rule would have selected.
   *
   * Carried in the result so the correctness gate can assert the *difference*
   * rather than merely assert the new rule's own output, which would pass
   * whatever the rule happened to be.
   */
  readonly centreRuleWouldSelect: readonly string[]
}

export interface VisibilityPatch {
  readonly isolateSeedIds?: readonly string[] | null
  readonly hops?: number
  readonly outside?: OutsideTreatment
  readonly ghostOpacity?: number
  readonly hiddenPartIds?: readonly string[]
}

export interface VisibilityReport {
  readonly solid: number
  readonly ghosted: number
  readonly hidden: number
  readonly ghostOpacity: number
  readonly isolating: boolean
  readonly hops: number
  readonly derivedOn: 'worker' | 'synchronous'
}

export interface JointSummary {
  readonly edgeId: string
  readonly kind: string
  readonly family: string
  readonly label: string
  readonly handles: readonly JointHandle[]
  readonly pivotLdu: readonly [number, number, number]
  readonly axis: readonly [number, number, number]
  readonly movingCount: number
  /** Canvas position of the pivot, so a driver can aim at the real handle. */
  readonly screen: { readonly x: number; readonly y: number; readonly behindCamera: boolean }
}

export interface JointDragReport {
  readonly active: boolean
  readonly edgeId: string | null
  readonly handle: JointHandle | null
  readonly rotateDegrees: number
  readonly slideLdu: number
  /** Parts whose drawn pose differs from the document's right now. */
  readonly previewCount: number
  readonly sweep: SweepResult | null
  /** Transactions this drag has committed. Exactly 0 until release, then 1. */
  readonly commits: number
}

export interface RendererStats {
  readonly drawCalls: number
  readonly triangles: number
  readonly geometries: number
  readonly programs: number
  readonly fps: number
  readonly qualityTier: string
  readonly qualityIndex: number
  readonly idPass: { passes: number; lastPassMs: number; width: number; height: number; identities: number; draws: number }
  readonly contextLosses: number
  readonly contextRestores: number
}

export interface RendererControlSurface {
  readonly version: 1

  /** Pixel-accurate single pick. `cycle` walks depth order on repeated calls. */
  pick(canvasX: number, canvasY: number, options?: PickOptions): PickReport
  /** Covered-pixel region selection. Box or lasso, in canvas pixels. */
  pickRegion(shape: RegionShape, options?: RegionOptions): RegionReport
  /** Discards occlusion-cycle state, so the next pick returns the frontmost part. */
  resetCycle(): void

  /**
   * Where a part is on the canvas.
   *
   * A viewport that can pick by pixel must also be able to say where a pixel
   * *is*: callouts, note anchors, "scroll to this part" and every driven
   * interaction need it, and computing it outside the renderer would mean a
   * second copy of the projection.
   */
  screenPositionOf(partId: string): { x: number; y: number; behindCamera: boolean } | null
  /** The same, for an arbitrary document-space point. */
  projectPoint(pointLdu: readonly [number, number, number]): { x: number; y: number; behindCamera: boolean }
  /** Frames the camera on a set of parts and settles synchronously. */
  frameParts(partIds: readonly string[]): boolean
  /** Spherical pose relative to the orbit target, for keyboard e2e. */
  cameraPose(): { yawDeg: number; pitchDeg: number; distance: number }

  setVisibility(patch: VisibilityPatch): Promise<VisibilityReport>
  getVisibility(): VisibilityReport

  saveView(name: string): NamedView
  restoreView(name: string): boolean
  listViews(): readonly NamedView[]
  removeView(name: string): boolean

  addSectionPlane(axis: 'x' | 'y' | 'z'): SectionPlane
  listSectionPlanes(): readonly SectionPlane[]
  removeSectionPlane(id: string): boolean
  /** Grabs a plane's on-canvas handle at a point, as a pointer down would. */
  beginSectionDrag(id: string, mode: 'offset' | 'rotate', canvasX: number, canvasY: number): boolean
  updateSectionDrag(canvasX: number, canvasY: number): SectionPlane | null
  endSectionDrag(): SectionPlane | null

  listJoints(): readonly JointSummary[]
  beginJointDrag(edgeId: string, handle: JointHandle, canvasX: number, canvasY: number): boolean
  updateJointDrag(canvasX: number, canvasY: number): JointDragReport
  /** Restores the exact starting transforms. Commits nothing. */
  cancelJointDrag(): JointDragReport
  /** Commits exactly one transaction through the command bus. */
  commitJointDrag(): JointDragReport
  jointDragState(): JointDragReport

  setReducedMotion(value: boolean | null): void
  motionPolicy(): { animated: boolean; reason: string }
  /** Jumps every running animation to its settled state. */
  settle(): void
  setEnvironment(name: EnvironmentName): void
  setQuality(index: number | 'auto'): void
  /** True transmission for transparent elements, budget permitting. */
  setTransmission(enabled: boolean): void

  /** Settles motion, draws a frame, and reads it back with its metadata. */
  capture(): Promise<CaptureMetadata & { dataUrl: string }>

  stats(): RendererStats
  resources(): ResourceCounts
  /** Forces `WEBGL_lose_context`, for the recovery gate. */
  loseContext(): boolean
  restoreContext(): boolean
}

/** The joint list the surface reports, derived from the kernel's own decomposition. */
export function summariseJoint(
  joint: ArticulatedJoint,
  handles: readonly JointHandle[],
  screen: { x: number; y: number; behindCamera: boolean },
): JointSummary {
  return {
    edgeId: joint.edgeId,
    kind: joint.joint.kind,
    family: joint.family,
    label: joint.label,
    handles,
    pivotLdu: joint.pivotLdu,
    axis: joint.axis,
    movingCount: joint.movingPartIds.length,
    screen,
  }
}

declare global {
  interface Window {
    __brickwrightRenderer?: RendererControlSurface
  }
}

/** Installs the surface, returning the uninstaller for the effect's cleanup. */
export function installControlSurface(surface: RendererControlSurface): () => void {
  if (typeof window === 'undefined') return () => {}
  window.__brickwrightRenderer = surface
  return () => {
    if (window.__brickwrightRenderer === surface) delete window.__brickwrightRenderer
  }
}
