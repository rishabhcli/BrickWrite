/**
 * Workstream 10 — explore. Published surface.
 *
 * The explorer, the envelope renderer both surfaces draw with, the projection
 * maths behind it, and the fork seam a deployment plugs its cloud project store
 * into. See `docs/integration/landing.md`.
 */
export { ExplorePage, default as Explore } from './ExplorePage'
export { EnvelopeView, type EnvelopeViewProps } from './EnvelopeView'
export { useOnScreen, useReducedMotion } from './motion'
export {
  buildScene,
  cameraBasis,
  depthOf,
  explodeOffsets,
  fitScene,
  PART_FIELDS,
  pointInPolygon,
  project,
  shadeHex,
  visibleFaces,
  type BoxFace,
  type Camera,
  type CameraBasis,
  type Fit,
  type SceneBox,
  type SceneOptions,
  type Vec,
} from './projection'
export {
  cloudProjectAdapter,
  forkDemo,
  registerCloudProjectAdapter,
  type CloudForkInput,
  type CloudProjectAdapter,
  type ForkDestination,
  type ForkOutcome,
} from './fork'
