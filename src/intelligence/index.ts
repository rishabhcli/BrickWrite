/**
 * Part intelligence: the published surface.
 *
 * Nothing in this module reads an index, opens a socket or touches the catalog
 * at import time. The corpus is fetched on the first question, and the
 * four-megabyte latent index only on the first *semantic* question, so a route
 * that merely imports this file pays nothing for it.
 *
 * Only the API other workstreams are meant to call is re-exported here. The
 * scoring internals stay reachable for tests through their own modules, because
 * a signal weight that becomes part of the public surface becomes impossible to
 * change without breaking a caller who had no business depending on it.
 */

export {
  resolvePartIntent,
  resolvePartIntentSync,
  warmPartIntelligence,
  residentPartIntelligence,
  resetPartIntelligence,
  type PartIntelligence,
  type ResolveOptions,
} from './parts/resolve'

export { parseQuery, type PartQuery, type QueryContext, type RelationIntent } from './parts/query'

export {
  loadPartCorpus,
  CorpusUnavailableError,
  type CorpusDocument,
  type CorpusLoadOptions,
  type PartCorpus,
} from './parts/corpus'

export {
  loadSemanticIndex,
  residentSemanticIndex,
  residentSemanticManifest,
  resetSemanticIndex,
  SemanticIndexError,
  type SemanticIndexManifest,
  type SemanticLoadOptions,
} from './parts/semantic'

export {
  RelationIndex,
  connectorSimilarity,
  type BridgeCandidate,
  type InterfaceMatch,
  type MirrorRelation,
} from './parts/relations'

export { LexicalIndex, type IdentityKind } from './parts/lexical'

export { calibrateConfidence, type RankedCandidate, type SignalDetail } from './parts/rank'

export {
  GeometryAssetProvider,
  catalogGeometryDescriptors,
  type GeometryAssetProviderOptions,
  type GeometryAssetResult,
  type GeometryDescriptor,
  type GeometryDescriptorSource,
  type GeometryUnavailableCause,
} from './assets/geometryProvider'

// ---------------------------------------------------------------------------
// In-editor surface
// ---------------------------------------------------------------------------
//
// The resolver above answers a sentence; this is how a person asks one. The
// contribution is a zero-prop component that registers itself into the
// workbench's `panel-left` slot, so `src/App.tsx` lists it and nothing else in
// the editor changes. Importing it fetches nothing — the corpus and the latent
// index are still paid for by the first query. See "In-editor surface" in
// docs/integration/part-intelligence.md.

export { PartSearchContribution } from './ui/contribution'
export {
  FindPartsPanel,
  type FindPartsPanelProps,
  type PartResolver,
  type PartSearchApi,
} from './ui/FindPartsPanel'
