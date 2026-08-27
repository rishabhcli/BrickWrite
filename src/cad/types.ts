export type Vec3 = readonly [number, number, number]
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

export interface Transform {
  /** LDraw units. LDraw is Y-down, so a part stacked on top has a smaller y. */
  position: Vec3
  /** Euler degrees about the LDraw X, Y and Z axes. */
  rotation: Vec3
}

/**
 * A normalized connection point compiled from the LDCad Shadow Library.
 * `pos`/`ori` are in the part's own LDraw coordinate frame.
 */
export interface ConnectionFeature {
  id: string
  family: ConnectionFamily
  gender: 'male' | 'female' | 'neutral'
  pos: Vec3
  /** Row-major 3×3 orientation; omitted when the frame is axis-aligned. */
  ori?: readonly number[]
  group?: string
  axial?: number
  slide?: boolean
  rotate?: boolean
  src: string
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
}

export interface ColorDefinition {
  code: number
  name: string
  hex: string
  edge: string
  /** 1 for opaque; LDraw ALPHA values below 255 render as transparent. */
  alpha: number
  finish: string
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

export interface ModelDocument {
  schemaVersion: 1
  id: string
  name: string
  revision: number
  catalogVersion: string
  createdAt: string
  updatedAt: string
  parts: Record<string, PartInstance>
  subassemblies: Record<string, Subassembly>
  steps: BuildStep[]
  notes: BuilderNote[]
  constraints: Constraint[]
}

export type CadOperation =
  | { type: 'part.add'; part: PartInstance }
  | { type: 'part.remove'; partId: string }
  | { type: 'part.transform'; partId: string; transform: Transform }
  | { type: 'part.recolor'; partId: string; color: number }
  | { type: 'part.protect'; partId: string; protected: boolean }
  | { type: 'part.assign-subassembly'; partId: string; subassemblyId: string }
  | { type: 'subassembly.add'; subassembly: Subassembly }
  | { type: 'note.add'; note: BuilderNote }
  | { type: 'note.respond'; noteId: string; response: string; resolved?: boolean }

export interface Transaction {
  id: string
  author: Actor
  label: string
  baseRevision: number
  resultRevision: number
  timestamp: string
  operations: CadOperation[]
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
}

export interface ValidationReport {
  revision: number
  partCount: number
  connectionCount: number
  collisions: CollisionIssue[]
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
    | 'CATALOG_NOT_LOADED'
    | 'COLOR_UNAVAILABLE'
    | 'COLLISION'
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
  limit?: number
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
