/**
 * The platform layer's published surface.
 *
 * Other workstreams import from here and from `./contracts`, never from a file
 * inside this directory. Two things in particular are the contract:
 * `registerRoute`, which is how a surface gets mounted, and the boot hooks,
 * which are how it reaches the CAD kernel its route declared.
 *
 * `./server/*` is deliberately absent. It is server-only and importing it from
 * a client module is a test failure, not a review comment.
 */

export { AppShell, AppShell as default, PlatformShell, RouteHost, ShellRoutes, installPlatformSurfaces } from './AppShell'
export { AppFrame, FramedLayout } from './AppFrame'

export {
  PLATFORM_ROUTES,
  PRIMARY_NAV,
  isRouteRegistered,
  listRegisteredRoutes,
  registerRoute,
  resetRouteRegistry,
  routeById,
  routeHasAppFrame,
  type RouteLoader,
} from './routes'

export {
  BOOT_MEASURE_PREFIX,
  BootCancelledError,
  BootLevelError,
  bootForRoute,
  bootLevelRank,
  bootPhaseMs,
  bootTimeline,
  bootTo,
  catalogLoaderSupportsNarrowedLoad,
  isBooting,
  peekBootStage,
  requireCatalogStage,
  requireEditorStage,
  resetBoot,
  searchIndexHandle,
  type BootLevel,
  type BootOptions,
  type BootPhase,
  type BootPhaseName,
  type BootStage,
  type BootStageCatalog,
  type BootStageEditor,
  type BootStageNone,
  type BootStageParts,
  type BootStageWithCatalog,
  type SearchIndexHandle,
} from './boot'
export {
  BootStageProvider,
  useBootStage,
  useCatalogStage,
  useEditorStage,
  useSearchIndex,
} from './boot-context'

export {
  PLATFORM_PATHS,
  PLATFORM_URL_DESTINATIONS,
  PROJECT_ID_ENV_VARS,
  ambientEnvironment,
  resolvePlatformConfig,
  type PlatformConfig,
  type PlatformUrlDestinations,
} from './config'
export { hexclaveUrlOptions } from '../hexclave/urls'

export {
  CAD_CONTENT_ATTRIBUTE,
  CAD_CONTENT_MASK_CLASS,
  CAD_CONTENT_MASK_CLASS_PATTERN,
  CAD_CONTENT_SELECTORS,
  PLATFORM_EVENT_VOCABULARY,
  PlatformAnalyticsVocabularyError,
  analyticsMaskingCoverage,
  assertEventVocabulary,
  buildAnalyticsOptions,
  cadContentBlockSelector,
  drainPlatformAnalytics,
  maskedContentProps,
  peekPlatformAnalytics,
  platformAnalyticsStatus,
  resetPlatformAnalytics,
  setPlatformAnalyticsSink,
  trackPlatformEvent,
  usePlatformAnalytics,
  type CadContentKind,
  type CadContentSelector,
  type PlatformAnalytics,
  type PlatformAnalyticsEvent,
  type PlatformAnalyticsSink,
  type RecordedPlatformEvent,
} from './analytics'

export {
  AccountAvailabilityProvider,
  accountLabel,
  markDeliberateSignOut,
  resetSessionMemory,
  useAccountAvailability,
  type AccountAvailability,
  type AccountSession,
  type RestrictionKind,
} from './auth/account'
export { useAccountSession } from './auth/accountSession'
export { AccountMenu } from './auth/AccountMenu'
/*
 * `AccountPage` is deliberately NOT re-exported.
 *
 * It is a route surface, reached through `registerRoute('account', …)` in
 * `installPlatformSurfaces()`. Naming it here would make it a static import of
 * this entry point, which drags Hexclave's whole `AccountSettings` tree into
 * the shell chunk and undoes the reason the route declares `boot: 'none'`.
 * Verified: the build reports INEFFECTIVE_DYNAMIC_IMPORT when it is exported.
 */
export { AuthRoutes, SignInSurface, SignUpSurface, safeReturnTo } from './auth/AuthRoutes'
export {
  AuthRequiredState,
  RestrictedState,
  RouteAuthGuard,
  SessionExpiredState,
  signInHref,
  signUpHref,
  useReturnTo,
  useSignOut,
} from './auth/guards'

export {
  BootFailureState,
  LoadingState,
  MisconfiguredState,
  NotInstalledSurface,
  OfflineNotice,
  ShellErrorState,
  StatePanel,
  createNotInstalledSurface,
} from './states'

export { focusableWithin, useFocusTrap } from './a11y'
export { isOnline, useOnlineStatus } from './connectivity'
export {
  hexclaveAuthorizationHeader,
  type AuthorizationHeaderSource,
} from '../hexclave/authorization'

export {
  SERVER_EMAIL_MODULE,
  escapeHtml,
  renderPlatformEmail,
  type EmailRecipients,
  type NotificationCategory,
  type PlatformEmail,
  type PlatformEmailRequest,
  type ProjectInvitationEmail,
  type PublicationNotificationEmail,
  type RenderedEmail,
} from './emails'

export {
  readNdjsonLines,
  type PartIntentMatch,
  type PartIntentResult,
  type RouteId,
  type RouteModule,
} from './contracts'
