/**
 * Public surface of the gallery workstream.
 *
 * The page is a default export so the platform route registry can point at it
 * with a dynamic import (`registerRoute('gallery', () => import(...))`), which
 * is what keeps the gallery's bundle out of the editor.
 */
export { default as GalleryPage, type GalleryPageProps } from './GalleryPage'
export {
  forkAncestry,
  forkChildren,
  GALLERY_SORTS,
  resolveCollection,
  searchGallery,
  type GalleryFacet,
  type GalleryQuery,
  type GalleryResult,
  type GallerySort,
} from './curation'
export {
  applyModeration,
  isReportReason,
  moderationQueue,
  resolveReport,
  submitReport,
  type SubmitReportInput,
} from './moderation'
export { galleryEntryFrom } from '../share/gallery-projection'
export { REPORT_REASONS, type Collection, type GalleryEntry, type Report, type ReportReason } from '../share/types'
