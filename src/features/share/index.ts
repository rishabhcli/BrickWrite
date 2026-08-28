/**
 * Publish & share — the public surface of workstream 9.
 *
 * Everything another workstream may import is named here. Nothing outside this
 * file's exports is a supported entry point, and nothing here imports another
 * feature directory: the dependencies are the CAD kernel (`src/cad/*`),
 * `src/platform/contracts.ts`, and this directory.
 *
 * The routes are registered rather than imported, so the application shell
 * decides when the share and gallery bundles load. See
 * `docs/integration/share-studio.md`.
 */

// -- publishing --------------------------------------------------------------
export {
  createPublication,
  deepFreeze,
  DEFAULT_LICENSE,
  mintSlug,
  normaliseAuthor,
  publicationBytes,
  revokePublication,
  updatePublicationAccess,
  verifyPublicationIntegrity,
  type PublishRequest,
} from './publish'
export {
  collectStrings,
  publishedDocumentBytes,
  publishedDocumentHash,
  serializePublishedDocument,
  summarisePublication,
} from './serialize'
export { documentFromPublished, describeFork, forkPublication, type ForkOptions, type ForkResult } from './fork'

// -- access ------------------------------------------------------------------
export { isPubliclyListable, requireCapability, resolveAccess, type AccessDecision, type AccessRequest } from './access'
export {
  baseCapabilities,
  describeTokenFailure,
  intersectCapabilities,
  isExpired,
  mintShareToken,
  parseShareToken,
  revokeToken,
  TOKEN_ID_BYTES,
  TOKEN_SECRET_BYTES,
  verifyShareToken,
  type MintedToken,
  type MintTokenInput,
} from './tokens'

// -- rendering ---------------------------------------------------------------
export {
  renderBuildSequence,
  renderCard,
  renderFrame,
  renderPreview,
  renderTurntable,
  type AnimationOptions,
  type CardRenderInput,
  type RenderedCard,
} from './render/cards'
export {
  CARD_GEOMETRY,
  CARD_PRESET_IDS,
  cloneSettings,
  DEFAULT_STUDIO_PRESET,
  normaliseSettings,
  OG_CARD,
  STUDIO_PRESET_IDS,
  STUDIO_PRESETS,
  type BackgroundSettings,
  type CameraSettings,
  type CardGeometry,
  type FramingSettings,
  type ShareStudioSettings,
  type StudioPresetId,
  type ToneSettings,
  type WatermarkSettings,
} from './render/presets'
export { buildScene, cameraBasis, frameForCard, type GeometryResolver, type ShareMesh } from './render/scene'
export { encodeApng, encodePng, readChunkTypes, readPngHeader, zlibDeflate } from './render/png'

// -- server-rendered pages (also used by functions/**) -----------------------
export {
  baseSecurityHeaders,
  canonicalUrlFor,
  cardUrlFor,
  embedSnippet,
  embedUrlFor,
  metaDescription,
  renderEmbedPage,
  renderRefusalPage,
  renderSharePage,
  type PageOptions,
  type RenderedPage,
} from './page'

// -- storage seam ------------------------------------------------------------
export type { KvNamespace, PublicationStore, StoredCard } from './backend/adapter'
export { KvPublicationStore } from './backend/kv-store'
export { MemoryKv } from './backend/memory-kv'
export {
  CONVEX_SHARE_FUNCTIONS,
  CONVEX_SHARE_TABLES,
  publicationFromRow,
  publicationToRow,
  tokenFromRow,
  tokenToRow,
  type CollectionRow,
  type PublicationRow,
  type ReportRow,
  type ShareTokenRow,
} from './backend/schema'

// -- utilities ---------------------------------------------------------------
export {
  canonicalBytes,
  canonicalJson,
  constantTimeEqual,
  constantTimeEqualHex,
  contentHash,
  randomBytes,
  sha256Hex,
} from './canonical'
export {
  escapeAttribute,
  escapeHtml,
  guardPayloadSize,
  isValidSlug,
  LIMITS,
  redactShareUrl,
  sanitizeComment,
  sanitizeDescription,
  sanitizeFilename,
  sanitizeTags,
  sanitizeTitle,
  sanitizeUrl,
} from './sanitize'
export { galleryEntryFrom } from './gallery-projection'

// -- types -------------------------------------------------------------------
export {
  CAPABILITY_KEYS,
  DEFAULT_CAPABILITIES,
  NO_CAPABILITIES,
  PUBLICATION_SCHEMA_VERSION,
  REPORT_REASONS,
  ShareError,
  type AnimationPresetId,
  type CapabilityKey,
  type CardPresetId,
  type Collection,
  type ForkProvenance,
  type GalleryEntry,
  type ModerationState,
  type Publication,
  type PublicationAuthor,
  type PublicationCard,
  type PublicationSummary,
  type PublicationValidation,
  type PublishedDocument,
  type PublishedPart,
  type Report,
  type ReportReason,
  type ShareCapabilities,
  type ShareErrorCode,
  type ShareTokenRecord,
  type TokenFailureReason,
  type TokenVerification,
  type Visibility,
} from './types'

// -- React surfaces ----------------------------------------------------------
export { ShareStudio, type ShareStudioProps } from './studio/ShareStudio'
export { useStudioSettings, type StudioSettingsAction, type StudioSettingsState } from './studio/useStudioSettings'
export { SharedViewer, bomForPublication, type SharedViewerProps } from './viewer/SharedViewer'
export { ShareBar, type ShareBarProps } from './viewer/ShareBar'
export { ModelCanvas, type ModelCanvasProps } from './viewer/ModelCanvas'
export {
  clearGeometryCache,
  loadPublicationGeometry,
  residentGeometry,
  type GeometryProgress,
} from './viewer/geometry'
export {
  describeStep,
  INITIAL_VIEWER_STATE,
  stepSelection,
  viewerReducer,
  type ViewerAction,
  type ViewerState,
} from './viewer/state'

/**
 * Registers the read-only viewer at `/share/:slug`.
 *
 * The Cloudflare Function at `functions/share/[slug].ts` already answers that
 * address for a cold navigation; this registration is what upgrades an in-app
 * navigation to the interactive viewer. Both read the same publication.
 */
export function registerShareRoute(
  registerRoute: (id: 'share', loader: () => Promise<{ default: React.ComponentType }>) => () => void,
) {
  return registerRoute('share', async () => ({ default: (await import('./viewer/SharePage')).default }))
}
