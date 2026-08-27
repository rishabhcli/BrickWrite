/**
 * Types for the offline catalog compiler.
 *
 * The compiler runs under bare `node` in CI and at deploy time, so it stays
 * plain ESM; this declaration lets the test suite drive it in-process and assert
 * on its semantics rather than only checking that the CLI exits zero.
 */

export interface CompileCatalogOptions {
  /** Root of an LDraw library (contains `parts/`, `p/`, `LDConfig.ldr`). */
  ldraw: string
  /** Root of the LDCad Shadow Library. */
  shadow?: string
  /** Directory of Rebrickable bulk CSV exports. */
  rebrickable?: string
  /** Output root; receives `catalog/<version>/` and `assets/geometry/`. */
  out: string
  version?: string
  packSize?: number
  packExtra?: string[]
  quiet?: boolean
}

export interface CatalogCoverage {
  catalogIdentities: number
  byLdrawKind: Record<string, number>
  helperParts: number
  withRebrickableIdentity: number
  withHeuristicIdentity: number
  withCategory: number
  withColorEvidence: number
  withAuthoritativeConnections: number
  connectorTotal: number
  geometryCompiled: number
  geometryPartial: number
  geometryUncompiled: number
  unresolvedReferences: string[]
  unmatchedRebrickableColors: number
  renamedAliases: number
  identityAdoptedFromRename: number
  triangleTotal: number
  geometryBytes: number
  thumbnailsRendered: number
  thumbnailBytes: number
  ldrawLicenses: Record<string, number>
}

export interface CatalogManifestFile {
  path: string
  hash: string
  bytes: number
}

export interface CompiledCatalogManifest {
  schemaVersion: number
  catalogVersion: string
  generatedAt: string
  sources: Record<string, unknown>
  files: Record<string, CatalogManifestFile>
  counts: { parts: number; packParts: number; connectors: number; colors: number; aliases: number; thumbnails: number }
  coverage: CatalogCoverage
}

export declare function compileCatalog(options: CompileCatalogOptions): Promise<CompiledCatalogManifest>
