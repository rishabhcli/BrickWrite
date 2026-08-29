/**
 * The shape of the curated demo manifest.
 *
 * Written by `tools/build-demos.mjs`, which is also the only thing that decides
 * what goes in it: every entry here cleared collision, connectivity, stability,
 * catalog and build-order validation before it was published. Nothing at
 * runtime may add to this table, because nothing at runtime can run those gates.
 */

/** An immutable published file, bound to the bytes it was generated from. */
export interface DemoAsset {
  url: string
  bytes: number
  sha256: string
  contentType: 'application/json' | 'image/png'
}

export interface DemoAssets {
  /** The canonical `ModelDocument` snapshot. */
  document: DemoAsset
  /** The earlier candidate the refinement pass replaced. */
  rough: DemoAsset
  /** Envelope preview geometry — what the landing page and explorer draw. */
  preview: DemoAsset
  roughPreview: DemoAsset
  thumbnail: DemoAsset
  social: DemoAsset
}

export interface DemoStaticsSummary {
  massGrams: number
  massLabel: string
  measuredParts: number
  unmeasuredParts: number
  /** Fraction of parts whose mass could be measured. 1 means all of them. */
  coverage: number
  supportLabel: string
  /** Distance from the centre of mass to the edge of the support polygon. */
  tippingMarginLdu: number | null
  restingParts: number
  stable: boolean
  overloadedGroups: number
  /** Parts carried in tension rather than compression. */
  unsupportedParts: number
  massBasis: string
  clutchGramsPerStud: number
}

export interface DemoValidationSummary {
  revision: number
  partCount: number
  connectionCount: number
  collisionCount: number
  unverifiedCollisions: number
  componentCount: number
  disconnectedPartCount: number
  virtualColorCount: number
  weakAttachmentCount: number
  healthy: boolean
  boundsLdu: { min: number[]; max: number[]; size: number[] }
  footprintStuds: number[]
  heightPlates: number
  steps: number
  buildOrderVerified: boolean
  buildOrderWarnings: string[]
  statics: DemoStaticsSummary
}

/** What the refinement pass measurably changed between the two candidates. */
export interface DemoRefinementDelta {
  partsAdded: number
  connectionsAdded: number
  componentsBefore: number
  componentsAfter: number
  loosePartsBefore: number
  loosePartsAfter: number
  collisionsBefore: number
  collisionsAfter: number
  unsupportedBefore: number
  unsupportedAfter: number
  stableBefore: boolean
  stableAfter: boolean
  massBeforeGrams: number
  massAfterGrams: number
  stepsBefore: number
  stepsAfter: number
}

/** Camera preset for the interactive envelope view, in degrees. */
export interface DemoCamera {
  yaw: number
  pitch: number
  zoom: number
}

/**
 * The request the demo answers, in the structured form the generators consume.
 *
 * Present on the hero demo only. It is the brief a person would type and the
 * fields a deterministic compiler read out of it — not a model transcript.
 */
export interface DemoBrief {
  prompt: string
  /** Target envelope in studs; null on an axis the brief did not constrain. */
  envelopeStuds: (number | null)[]
  palette: string[]
  functions: string[]
}

export interface DemoProvenance {
  generator: string
  kernel: string
  catalogVersion: string
  catalogManifestGeneratedAt: string
  catalogPartsHash: string
  renderer: string
  authoredAt: string
}

export interface DemoBillLine {
  definitionId: string
  name: string
  count: number
}

/** Curated scale facts that the demo compiler independently checks. */
export interface DemoShowcase {
  /** Distinct campus buildings or landmarks represented by the model. */
  landmarkCount: number
  /** Selectable character elements in the canonical document. */
  characterCount: number
  /** Individually editable pieces used to draw the site plan. */
  siteFinishParts: number
}

export interface DemoEntry {
  id: string
  title: string
  discipline: string
  tagline: string
  summary: string
  techniques: string[]
  /** Optional scale facts for collection-defining builds. */
  showcase: DemoShowcase | null
  /** What the earlier candidate got wrong, in one sentence. */
  refinement: string
  hero: boolean
  brief: DemoBrief | null
  camera: DemoCamera
  documentId: string
  roughDocumentId: string
  schemaVersion: number
  catalogVersion: string
  authoredAt: string
  assets: DemoAssets
  validation: DemoValidationSummary
  roughValidation: DemoValidationSummary
  delta: DemoRefinementDelta
  bill: DemoBillLine[]
  distinctParts: number
  planWarnings: string[]
  /** Parts the gate permits to hang in tension, and why. */
  tensionAllowance: number
  tensionReason: string | null
  provenance: DemoProvenance
}

export interface DemoManifest {
  schemaVersion: number
  catalogVersion: string
  generatedBy: string
  authoredAt: string
  /** The gates every entry cleared, in the words the build uses. */
  gates: string[]
  demos: DemoEntry[]
}

// ---------------------------------------------------------------------------
// Preview geometry
// ---------------------------------------------------------------------------

export interface DemoPreviewDefinition {
  id: string
  name: string
  category: string
  /** Measured envelope in studs: [width, height in plates, depth]. */
  studs: number[] | null
  connectors: number
  frequency: number
}

export interface DemoPreviewColor {
  code: number
  name: string
  hex: string
  edge: string
  /** 1 for opaque; LDraw transparent colours are below 1. */
  alpha: number
}

export interface DemoPreviewSubassembly {
  id: string
  name: string
  accent: string
  locked: boolean
}

export interface DemoPreviewStep {
  index: number
  name: string
  partCount: number
}

/**
 * One part, as `[minX, minY, minZ, maxX, maxY, maxZ, definition, colour, step,
 * subassembly, studLayout]`.
 *
 * The box is the part's measured LDraw envelope at its exact document
 * transform, and it is exact rather than approximate because every demo is
 * authored on axis-aligned rotations — `tools/build-demos.mjs` refuses to
 * publish one that is not.
 */
export type DemoPreviewPart = number[]

export interface DemoPreview {
  id: string
  name: string
  revision: number
  catalogVersion: string
  boundsLdu: { min: number[]; max: number[] }
  definitions: DemoPreviewDefinition[]
  colors: DemoPreviewColor[]
  subassemblies: DemoPreviewSubassembly[]
  steps: DemoPreviewStep[]
  /** Normalised stud positions on a box's top face, as flat `[u,v,…]` runs. */
  studLayouts: number[][]
  partIds: string[]
  parts: DemoPreviewPart[]
}
