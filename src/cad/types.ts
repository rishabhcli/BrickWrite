export type { DocumentPatch, EntityMutation } from './patch'
export type { Mat3, RigidTransform, Vec3 } from './math'
export type { RigidTransform as Transform } from './math'

import type { Mat3, RigidTransform as Transform, Vec3 } from './math'
import type { DocumentPatch } from './patch'

export type Actor = 'human' | 'agent'
export type AutonomyMode = 'inspect' | 'propose' | 'build'
export type GeometryStatus = 'certified' | 'partial' | 'missing' | 'uncompiled'
export type ConnectionStatus = 'ldcad-authoritative' | 'missing'
export type IdentityConfidence = 'exact' | 'heuristic' | 'none'
export type ConnectionFamily =
  | 'stud'
  | 'anti-stud'
  | 'pin'
  | 'pin-hole'
  | 'axle'
  | 'axle-hole'
  | 'bar'
  | 'clip'
  | 'hinge'
  | 'ball'
  | 'socket'
  | 'generic'

/**
 * A normalized connection point compiled from the LDCad Shadow Library.
 * `pos`/`ori` are in the part's own LDraw coordinate frame.
 */
export interface ConnectionFeature {
  id: string
  family: ConnectionFamily
  gender: 'male' | 'female' | 'neutral'
  /** Connector origin in the part's own LDraw frame. */
  pos: Vec3
  /**
   * Row-major 3×3 connector orientation, omitted when it is the identity.
   * By LDCad convention the connector's axis is its frame's local +Y, which is
   * what lets the snap solver align two frames without inspecting geometry.
   */
  ori?: Mat3
  group?: string
  /** Axial extent in LDU, where the source declared one. */
  axial?: number
  slide?: boolean
  rotate?: boolean
  src: string
}

/**
 * Relative motion a mated connector pair still permits.
 *
 * Derived from the connector families and the compiled slide/rotate flags
 * rather than asserted, so a joint whose freedom is genuinely unknown says so
 * instead of being silently treated as rigid.
 */
export type JointFreedom =
  | { kind: 'fixed' }
  | {
      kind: 'revolute'
      /** Rotation axis in the shared connector frame. */
      axis: Vec3
      continuous: boolean
      /** Discrete step in degrees when `continuous` is false. */
      stepDegrees?: number
    }
  | {
      kind: 'prismatic'
      axis: Vec3
      minLdu: number
      maxLdu: number
    }
  | {
      kind: 'cylindrical'
      axis: Vec3
      minLdu: number
      maxLdu: number
      continuousRotation: boolean
    }
  | { kind: 'spherical' }
  | { kind: 'unknown' }

export interface ConnectionEndpoint {
  partId: string
  featureId: string
}

/**
 * A committed physical connection between two placed parts.
 *
 * Persisting these means the structural graph survives save, load and export
 * instead of being re-inferred from coincident points every time. Geometric
 * inference remains the fallback for imported models, where no edge was ever
 * recorded.
 */
export interface ConnectionEdge {
  id: string
  a: ConnectionEndpoint
  b: ConnectionEndpoint
  family: ConnectionFamily
  joint: JointFreedom
  createdAtRevision: number
  source: 'snap' | 'explicit-connect' | 'import-inferred'
}

export interface PartBoundsLdu {
  min: Vec3
  max: Vec3
}

export interface PartDimensions {
  /** Bounding size in LDraw units. */
  ldu: Vec3
  /** Convenience: [width in studs, height in plates, depth in studs]. */
  studs: Vec3
  bounds: PartBoundsLdu
  /**
   * Enclosed volume of the compiled surface, in LDU³.
   *
   * Measured by the compiler with the divergence theorem, which is what lets
   * mass — and therefore centre of mass, load share and tipping margin — be a
   * measurement rather than a bounding-box guess. Absent on records compiled
   * before volume was captured.
   */
  volumeLdu3?: number
}

export interface GeometryAsset {
  hash: string
  file: string
  bytes: number
  vertices: number
  triangles: number
  edgeSegments: number
  slices: number[]
}

/**
 * Palette preview, rendered offline from the same compiled geometry.
 *
 * Deliberately colour-independent: RGB carries shading and alpha carries
 * coverage, so one asset serves all 322 LDraw colours. The runtime masks a
 * coloured layer with the alpha and multiplies the shading over it.
 */
export interface ThumbnailAsset {
  hash: string
  file: string
  bytes: number
  size: number
}

/**
 * One compiled catalog part. Every field states where it came from, so the
 * application can distinguish "verified" from "unknown" instead of implying
 * uniform coverage across a 22,000-part library.
 */
export interface PartDefinition {
  canonicalId: string
  ldrawId: string
  name: string
  category: string
  kind: string
  helper: boolean
  identity: {
    rebrickableId: string | null
    baseRebrickableId: string | null
    identityConfidence: IdentityConfidence
    legoDesignIds: string[]
    legoElementIds: string[]
    bricklinkIds: string[]
  }
  /** LDraw colour codes with observed appearances in official sets. */
  availableColors: number[]
  /** Number of official set inventories the part appears in. */
  frequency: number
  dimensions: PartDimensions | null
  geometryStatus: GeometryStatus
  geometryAsset: GeometryAsset | null
  thumbnail: ThumbnailAsset | null
  connectionStatus: ConnectionStatus
  connectors: ConnectionFeature[]
  license: string
  provenance: {
    geometry: string
    connections: string | null
    catalog: string | null
    colors: string | null
  }
}

/** Compact record covering every catalog identity, including uncompiled parts. */
/**
 * How much this build actually knows about an identity.
 *
 *   placeable   compiled geometry and connectors — it can be built with
 *   modelled    LDraw models it, so shape and connections are known, but this
 *               build carries no compiled mesh for it
 *   catalogued  the wider LEGO catalogue records that it exists, with a name,
 *               a category and set-appearance evidence, and nothing more
 *
 * The distinction is the whole point of publishing all three: "we have never
 * heard of that part" and "that part exists and we cannot build with it" are
 * different answers, and an operator or an agent needs to be told which one.
 */
export type CatalogTier = 'placeable' | 'modelled' | 'catalogued'

export interface CatalogSearchRecord {
  id: string
  name: string
  category: string
  /** Null when the part has no compiled geometry, so no measured dimensions. */
  dimensions: Vec3 | null
  frequency: number
  connectorFamilies: ConnectionFamily[]
  geometryAvailable: boolean
  connectionsAvailable: boolean
  helper: boolean
  tier: CatalogTier
  /** Base design this identity decorates, for a printed or mould variant. */
  variantOf?: string
  /** Material, when the catalogue records something other than plastic. */
  material?: string
}

export interface ColorDefinition {
  code: number
  name: string
  hex: string
  edge: string
  /** 1 for opaque; LDraw ALPHA values below 255 render as transparent. */
  alpha: number
  finish: string
  /** BrickLink colour id, when the compiler found a mapping. */
  bricklinkId?: number
}

export interface PartInstance {
  id: string
  definitionId: string
  color: number
  transform: Transform
  subassemblyId: string
  stepId: string
  provenance: Actor
  protected: boolean
  createdByTransaction?: string
}

export interface Subassembly {
  id: string
  name: string
  partIds: string[]
  locked: boolean
  accent: string
}

export interface BuildStep {
  id: string
  index: number
  name: string
  partIds: string[]
}

export interface BuilderNote {
  id: string
  anchorPartIds: string[]
  text: string
  status: 'open' | 'resolved'
  author: Actor
  revisionCreated: number
  response?: string
}

export interface Constraint {
  id: string
  kind: 'dimensions' | 'palette' | 'piece-count' | 'symmetry' | 'locked-region'
  label: string
  value: unknown
  hard: boolean
}

/**
 * A named sub-build captured once and stamped wherever it is needed.
 *
 * A real modular building reuses a bay, a balcony or a window unit a dozen
 * times; authoring each copy separately is both slow and the reason repeated
 * detail drifts out of alignment. Parts are stored in the module's own frame —
 * origin at its minimum corner on its base plane — so a stamp is a translation
 * and a quarter turn, never a re-derivation.
 */
export interface ModuleDefinition {
  id: string
  name: string
  parts: Array<{
    definitionId: string
    color: number
    /** Pose relative to the module origin, in LDU. */
    transform: Transform
  }>
  /** Footprint and height in LDU, measured when the module was captured. */
  sizeLdu: Vec3
  createdAtRevision: number
  author: Actor
}

export interface ModelDocument {
  /** 2 introduced matrix transforms and persistent connection edges. */
  schemaVersion: 2
  id: string
  name: string
  revision: number
  catalogVersion: string
  createdAt: string
  updatedAt: string
  parts: Record<string, PartInstance>
  connections: Record<string, ConnectionEdge>
  subassemblies: Record<string, Subassembly>
  steps: BuildStep[]
  notes: BuilderNote[]
  constraints: Constraint[]
  /**
   * Reusable sub-builds. Optional so that a document written before modules
   * existed still loads: absence means "none captured", not "unreadable".
   */
  modules?: ModuleDefinition[]
}

export type CadOperation =
  | { type: 'document.rename'; name: string }
  | { type: 'part.add'; part: PartInstance }
  | { type: 'part.remove'; partId: string }
  | { type: 'part.transform'; partId: string; transform: Transform }
  | { type: 'part.recolor'; partId: string; color: number }
  | { type: 'part.protect'; partId: string; protected: boolean }
  | { type: 'part.assign-subassembly'; partId: string; subassemblyId: string }
  | { type: 'subassembly.add'; subassembly: Subassembly }
  | { type: 'subassembly.rename'; subassemblyId: string; name: string }
  | { type: 'note.add'; note: BuilderNote }
  | { type: 'note.respond'; noteId: string; response: string; resolved?: boolean }
  | { type: 'subassembly.lock'; subassemblyId: string; locked: boolean }
  | { type: 'constraint.set'; constraint: Constraint }
  | { type: 'constraint.remove'; constraintId: string }
  | { type: 'module.define'; module: ModuleDefinition }
  | { type: 'module.remove'; moduleId: string }
  /**
   * Replaces the build sequence and reassigns every part to its new step.
   * Steps and part membership have to move together or the document would
   * describe a sequence that does not match the parts it orders.
   */
  | { type: 'steps.replace'; steps: BuildStep[] }

export interface Transaction {
  id: string
  author: Actor
  label: string
  baseRevision: number
  resultRevision: number
  timestamp: string
  /** The stable operation vocabulary, retained for display and agent reporting. */
  operations: CadOperation[]
  /**
   * Storage-level forward and inverse mutations. Undo applies the inverse rather
   * than restoring a whole historical document, and the touched set drives
   * incremental revalidation.
   */
  patch: DocumentPatch
  affectedPartIds: string[]
  sourceTool?: string
  kind?: 'edit' | 'undo' | 'redo'
}

export interface Bounds {
  min: Vec3
  max: Vec3
  size: Vec3
}

export interface CollisionIssue {
  id: string
  partA: string
  partB: string
  overlapLdu: Vec3
  message: string
  /**
   * How the verdict was reached. `exact` and `clearance-subtracted` were
   * confirmed against triangle geometry; `unknown` means the geometry was not
   * resident and only bounding boxes were compared.
   */
  certainty: 'exact' | 'clearance-subtracted' | 'unknown'
  /** Document-space point on the offending contact, when geometry was available. */
  pointLdu?: Vec3
}

export interface ValidationReport {
  revision: number
  partCount: number
  connectionCount: number
  collisions: CollisionIssue[]
  /** Collisions whose verdict came from bounding boxes alone. */
  unverifiedCollisions: number
  componentCount: number
  disconnectedPartIds: string[]
  /**
   * Part/colour combinations with no observed official-set appearance. These
   * are legal to build and export; they are reported as "virtual", not illegal,
   * unless a hard palette constraint says otherwise.
   */
  virtualColors: Array<{ partId: string; definitionId: string; color: number; reason: 'unobserved' | 'no-evidence' }>
  bounds: Bounds
  constraints: Array<{ id: string; label: string; status: 'pass' | 'warning' | 'fail'; message: string }>
  healthy: boolean
}

export interface Proposal {
  id: string
  label: string
  author: Actor
  baseRevision: number
  createdAt: string
  operations: CadOperation[]
  previewDocument: ModelDocument
  validation: ValidationReport
  status: 'pending' | 'applied' | 'rejected'
}

export interface EngineErrorShape {
  code:
    | 'STALE_DOCUMENT'
    | 'PROTECTED_REGION'
    | 'PART_NOT_FOUND'
    | 'PART_DEFINITION_NOT_FOUND'
    | 'GEOMETRY_UNAVAILABLE'
    | 'NO_COMPATIBLE_CONNECTOR'
    | 'CONNECTOR_OCCUPIED'
    | 'CATALOG_NOT_LOADED'
    | 'COLOR_UNAVAILABLE'
    | 'COLLISION'
    | 'DISCONNECTED'
    | 'CONSTRAINT_VIOLATION'
    | 'PROPOSAL_NOT_FOUND'
    | 'PROPOSAL_STALE'
    | 'READ_ONLY_MODE'
    | 'INVALID_OPERATION'
  message: string
  repair: string
  details?: unknown
}

export type CommandResult<T = Transaction> =
  | { ok: true; value: T }
  | { ok: false; error: EngineErrorShape }

/** Stud-space envelope filter: width and depth in studs, height in plates. */
export interface StudEnvelope {
  width?: number
  height?: number
  depth?: number
}

export interface CatalogSearchQuery {
  text?: string
  category?: string
  minStuds?: StudEnvelope
  maxStuds?: StudEnvelope
  connectorTypes?: ConnectionFamily[]
  /** Only return parts with observed official-set appearances in these colours. */
  colors?: number[]
  /** Restrict to parts that can actually be placed (compiled geometry present). */
  requireGeometry?: boolean
  /** Include LDraw "~" helper parts, which are not meant for direct building. */
  includeHelpers?: boolean
  /**
   * Which knowledge tier to search. `placeable` is what a build command needs;
   * `all` is what "does this part exist?" needs. Defaults to every tier that is
   * loaded, so a search never silently narrows to what happens to be resident.
   */
  tier?: CatalogTier | 'all'
  limit?: number
  /** Result offset, so a caller can page through a large match set. */
  offset?: number
}

/** One page of catalog results, with the counts needed to page and to face. */
export interface CatalogSearchPage {
  records: CatalogSearchRecord[]
  /** Matches across every tier, not just the page or the requested tier. */
  total: number
  offset: number
  /** Matches per tier under the same filters, for facet counts. */
  tiers: Record<CatalogTier, number>
  /** True when the wider catalogue index is not resident, so `catalogued` is 0. */
  cataloguePending: boolean
}

export interface EngineSnapshot {
  document: ModelDocument
  transactions: Transaction[]
  proposals: Proposal[]
  canUndo: boolean
  canRedo: boolean
  autonomy: AutonomyMode
  validation: ValidationReport
  selection: string[]
}
