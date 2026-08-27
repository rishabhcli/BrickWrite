/**
 * Types for the offline LDraw geometry compiler.
 *
 * The compiler itself stays plain ESM so it can run under bare `node` in CI and
 * during deployment without a build step; this declaration lets the runtime test
 * suite import it and keep the packed container format honest at both ends.
 */

export declare const MESH_MAGIC: number
export declare const MAIN_COLOUR: 16
export declare const EDGE_COLOUR: 24

export type Vec3Tuple = [number, number, number]

export interface LDrawInstruction {
  /** LDraw line type: 1 sub-file, 2 edge, 3 triangle, 4 quad. */
  kind: 1 | 2 | 3 | 4
  colour: number
  values?: number[]
  offset?: Vec3Tuple
  matrix?: number[]
  ref?: string
  /** True when a `BFC INVERTNEXT` applied to this reference. */
  invert?: boolean
  /** Declared winding at this point in the file. */
  ccw?: boolean
}

export interface ParsedLDrawSource {
  instructions: LDrawInstruction[]
  certified: boolean
}

export declare function parseLDrawSource(source: string): ParsedLDrawSource

export interface ResolvedFile {
  text: string
  key: string
}

export type ReferenceResolver = (reference: string) => ResolvedFile | null

export interface CompileOptions {
  parseCache?: Map<string, ParsedLDrawSource | null>
  maxDepth?: number
}

export interface CompiledMeshStats {
  vertices: number
  triangles: number
  edgeSegments: number
  /** LDraw colour code per index-buffer slice; 16 means "instance colour". */
  slices: number[]
}

export interface CompiledMesh {
  buffer: Buffer
  /** SHA-256 of `buffer`, used as the immutable asset name. */
  hash: string
  bounds: { min: Vec3Tuple; max: Vec3Tuple }
  /** References the compiler could not resolve, reported rather than hidden. */
  missing: string[]
  stats: CompiledMeshStats
}

export declare function compileMesh(
  reference: string,
  resolve: ReferenceResolver,
  options?: CompileOptions,
): CompiledMesh | null

export interface IndexedGeometry {
  positions: number[]
  normals: number[]
  indices: number[]
  slices: Array<{ colour: number; start: number; count: number }>
}

export declare function buildIndexedGeometry(mesh: unknown): IndexedGeometry

export declare function flattenPart(
  rootRef: string,
  resolve: ReferenceResolver,
  options?: CompileOptions,
): { mesh: unknown; missing: string[] }

export declare function packMesh(
  geometry: IndexedGeometry,
  edges: number[],
  bounds: { min: Vec3Tuple; max: Vec3Tuple },
): Buffer
