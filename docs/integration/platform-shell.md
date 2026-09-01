# Workstream 7 — Platform & account

Owns `src/platform/**` (except `src/platform/contracts.ts`, which is shared and
read-only) and `src/hexclave/**`.

The platform layer is the application shell: routing, the staged boot that
decides how much of the CAD kernel a route is allowed to download, the
persistent frame, the account product, and product analytics with operator
content masked.

---

## 1. Public exports

Everything below is exported from `src/platform` (`src/platform/index.ts`).
Nothing else in `src/platform/**` is public, and `src/platform/server/**` is
server-only — importing it from a client module fails
`src/platform/import-graph.test.ts`.

### Shell

| Export | Shape | Notes |
| --- | --- | --- |
| `AppShell` | `() => JSX.Element` | Router + account layer + boot gate + frame. Also the default export. |
| `PlatformShell` | `() => JSX.Element` | The shell without a router, for a host that supplies its own. |
| `ShellRoutes` | `() => JSX.Element` | Just the `<Routes>` table. |
| `RouteHost` | `({ route }) => JSX.Element` | One mounted surface: boot gate, auth gate, lazy load. |
| `AppFrame`, `FramedLayout` | components | The persistent thin frame and its layout route. |
| `installPlatformSurfaces()` | `() => void` | Registers the platform's own surfaces (currently `account`). Called on import; re-call after `resetRouteRegistry()` in tests. |

### Route registry

`registerRoute`, `isRouteRegistered`, `listRegisteredRoutes`,
`resetRouteRegistry`, `routeById`, `routeHasAppFrame`, `PLATFORM_ROUTES`,
`PRIMARY_NAV`, type `RouteLoader`.

### Boot

`bootTo`, `bootForRoute`, `peekBootStage`, `isBooting`, `resetBoot`,
`bootLevelRank`, `requireCatalogStage`, `requireEditorStage`,
`BootCancelledError`, `BootLevelError`, and the React side:
`BootStageProvider`, `useBootStage`, `useCatalogStage`, `useEditorStage`.
Types: `BootLevel`, `BootStage`, `BootStageNone`, `BootStageCatalog`,
`BootStageEditor`, `BootOptions`.

### Analytics

`usePlatformAnalytics`, `trackPlatformEvent`, `setPlatformAnalyticsSink`,
`drainPlatformAnalytics`, `peekPlatformAnalytics`, `platformAnalyticsStatus`,
`resetPlatformAnalytics`, `maskedContentProps`, `CAD_CONTENT_SELECTORS`,
`CAD_CONTENT_MASK_CLASS`, `CAD_CONTENT_ATTRIBUTE`,
`CAD_CONTENT_MASK_CLASS_PATTERN`, `buildAnalyticsOptions`,
`cadContentBlockSelector`, `analyticsMaskingCoverage`, `assertEventVocabulary`,
`PLATFORM_EVENT_VOCABULARY`, `PlatformAnalyticsVocabularyError`.

### Auth

`AccountMenu`, `AccountPage`, `AuthRoutes`, `SignInSurface`, `SignUpSurface`,
`RouteAuthGuard`, `AuthRequiredState`, `SessionExpiredState`, `RestrictedState`,
`useAccountAvailability`, `useAccountSession`, `AccountAvailabilityProvider`,
`useSignOut`, `useReturnTo`, `signInHref`, `signUpHref`, `safeReturnTo`,
`accountLabel`, `markDeliberateSignOut`, `resetSessionMemory`.

### States, a11y, connectivity, config, email content

`StatePanel`, `LoadingState`, `BootFailureState`, `ShellErrorState`,
`NotInstalledSurface`, `createNotInstalledSurface`, `MisconfiguredState`,
`OfflineNotice`; `useFocusTrap`, `focusableWithin`; `useOnlineStatus`,
`isOnline`; `resolvePlatformConfig`, `hexclaveUrlOptions`, `PLATFORM_PATHS`,
`PLATFORM_URL_DESTINATIONS`, `PROJECT_ID_ENV_VARS`, `ambientEnvironment`;
`renderPlatformEmail`, `escapeHtml`, `SERVER_EMAIL_MODULE` and the email types.

---

## 2. The route registry contract

The shell declares seven routes. It does **not** import any of their surfaces.
Each workstream attaches its own, once, before the shell mounts:

```ts
import { registerRoute } from './platform'

registerRoute('landing', () => import('./features/landing'))
```

`registerRoute(id, loader)` returns a detach function. Registering twice for the
same id replaces the first registration. An id with no registration renders the
"surface not installed in this build" state — a real, styled, `role="status"`
panel, not a crash.

The loader must resolve to `{ default: React.ComponentType }` and must be a
dynamic `import()`. A static import would defeat the point.

| id | path | `boot` | `requiresAuth` | frame | Owner |
| --- | --- | --- | --- | --- | --- |
| `landing` | `/` | `none` | — | yes | 10 |
| `explore` | `/explore` | `none` | — | yes | 10 |
| `editor` | `/editor` | `editor` | — | **no** | integrator (`src/App.tsx`) |
| `projects` | `/projects` | `catalog` | yes | yes | 8 |
| `account` | `/account` | `none` | yes | yes | 7 (already registered) |
| `share` | `/share/:slug` | `catalog` | — | yes | 9 |
| `gallery` | `/gallery` | `none` | — | yes | 10 |

### What `boot` buys you

| level | The shell has completed, before your surface mounts |
| --- | --- |
| `none` | Nothing. No CAD module has been imported. |
| `catalog` | `loadCompiledCatalog()` has resolved; `catalog` is installed. |
| `editor` | The above, plus `cad/engine` and `cad/session` imported, `session.start()` awaited, and `preloadDocumentGeometry()` done for the restored document. |

Read it with the narrowing hooks:

```tsx
import { useCatalogStage, useEditorStage } from '../platform'

function ExploreSurface() {
  const { catalog } = useCatalogStage()   // ok on boot: 'catalog' | 'editor'
  return <p>{catalog.placeableCount} placeable identities</p>
}

function EditorSurface() {
  const { engine, session } = useEditorStage() // throws BootLevelError below 'editor'
  …
}
```

**A surface cannot widen its own stage.** The level is read from
`PLATFORM_ROUTES` and passed to `bootForRoute`; the surface is never consulted,
and the stage object it receives structurally lacks the handles it did not
declare. If you need more, change the `boot` field in `src/platform/routes.ts`
and say why in the PR — that field is the thing keeping the renderer out of the
landing page.

### Marking CAD content

Any region that can hold a project name, a note, a prompt, chat text or the
project pane must carry the mask:

```tsx
import { maskedContentProps } from '../platform'

<span {...maskedContentProps('project-name')}>{project.name}</span>
```

New kinds go in `CAD_CONTENT_SELECTORS` in `src/platform/analytics.ts`;
`analytics.test.ts` fails if a kind is added there without being covered by the
shipped session-replay config.

**DOM contract, and it matters:** never make CAD content the accessible name of
an interactive element. A project row is a button labelled "Open project"
*containing* a masked `<span>` with the name — not a button whose text is the
name. Reason in §7.

### Emitting analytics

```tsx
const { track } = usePlatformAnalytics()
track({ name: 'route.viewed', route: 'explore', boot: 'catalog' })
```

The event union is closed and every string field is an enum validated at
runtime. `track()` throws `PlatformAnalyticsVocabularyError` on anything else,
which is what makes "no CAD content in telemetry" checkable rather than
aspirational. Add an event to the union **and** to
`PLATFORM_EVENT_VOCABULARY`; `analytics.test.ts` asserts the two stay in step.

---

## 3. Required integration edits

### `src/main.tsx` — replace the file with exactly this

```tsx
import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource-variable/manrope'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell, registerRoute } from './platform'
import './styles.css'

/**
 * Boot sequence.
 *
 * Every surface is registered here and loaded lazily. The shell owns what a
 * route may download before it paints — the compiled catalog, the CAD kernel
 * and the session are staged per route, not fetched universally. There is still
 * no procedural fallback catalog: a route that declared it needs one and cannot
 * get it says so and refuses to start. See docs/integration/platform-shell.md.
 */
registerRoute('editor', () => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
```

Other workstreams add one `registerRoute` line each, next to the editor's.

### `src/App.tsx` is the contribution root

The shell still awaits `loadCompiledCatalog()`, `session.start()` and
`preloadDocumentGeometry()` before mounting the editor. `src/App.tsx` itself is
no longer an unmodified leftover: it is the list of workbench contributions
(`AgentWorkbenchContribution`, `GeneratePanelContribution`,
`RefinePanelContribution`, `CloudProjectsContribution`). Adding a panel is one
lazy import and one array entry; the boot contract does not change.

`src/styles.css` is unmodified as far as the platform is concerned; the
platform's CSS lives in `src/platform/platform.css` and every class is `pf-`
prefixed so it cannot collide with the editor cockpit's `.app-shell` / `.topbar`.

`vite.config.ts` needs no change. The existing `rendering`, `react`, `hexclave`,
`contracts` and `ui` chunk groups are still correct.

### Dev-server rewrite (deployment, not code)

The shell is a client-side router, so `/editor`, `/gallery` and `/share/:slug`
must all serve `index.html`. `vite dev` and `vite preview` already do this.
Static hosting needs an SPA fallback rule — see the launch checklist.

---

## 4. Environment variables

| Variable | Where | Required for | Notes |
| --- | --- | --- | --- |
| `HEXCLAVE_PROJECT_ID` | dev (injected) | accounts, analytics, email | `hexclave dev` injects it; also injects `VITE_HEXCLAVE_PROJECT_ID` for Vite. |
| `VITE_HEXCLAVE_PROJECT_ID` | browser build | accounts | The only form that survives into a production bundle. Set it in the deployment environment. |
| `HEXCLAVE_SECRET_SERVER_KEY` | server / CI only | email delivery, config push | **Never** exposed to the browser. Read only by `src/platform/server/emails.server.ts`. |

`resolvePlatformConfig()` checks, in the SDK's own precedence order:
`HEXCLAVE_PROJECT_ID`, `NEXT_PUBLIC_HEXCLAVE_PROJECT_ID`,
`VITE_HEXCLAVE_PROJECT_ID`, `STACK_PROJECT_ID`, `NEXT_PUBLIC_STACK_PROJECT_ID`,
`VITE_STACK_PROJECT_ID`. When all are absent it returns `misconfigured` with
that list, the account controls switch to "local only", and **the CAD editor
boots and works normally**. That is a supported way to run Brickwright, not a
failure.

---

## 5. Hexclave URL configuration

`src/hexclave/client.ts` passes `hexclaveUrlOptions()`:

```ts
{
  default: { type: 'hosted' },
  signIn:  { type: 'custom', url: '/auth/sign-in',  version: getPagePrompt('signIn').latestVersion },
  signUp:  { type: 'custom', url: '/auth/sign-up',  version: … },
  accountSettings: { type: 'custom', url: '/account', version: … },
  home: '/', afterSignIn: '/projects', afterSignUp: '/projects', afterSignOut: '/',
}
```

Sign-in, sign-up and account settings are Brickwright routes rendered with
Hexclave's own `AuthPage` and `AccountSettings` components, so they keep the
application's chrome while the method list stays driven by `hexclave.config.ts`
(password, OTP, passkey, Google, GitHub). Everything else — email verification,
password reset, forgot password, OAuth and magic-link callbacks, MFA,
onboarding, team invitations — stays `hosted`. Confirmed with Hexclave that the
OAuth callback always terminates on Hexclave's API host, so a custom sign-in
page does not require custom callback routes.

The `version` numbers are read from `getPagePrompt()` at runtime rather than
hardcoded, so an SDK upgrade cannot leave a stale claim behind.

---

## 6. Analytics and session replay

`src/hexclave/client.ts` passes `buildAnalyticsOptions()`:

```ts
{
  enabled: true,
  replays: {
    enabled: true,
    maskAllInputs: true,
    blockClass: /(?:^|\s)pf-private(?:-[a-z0-9-]+)?(?:\s|$)/,
    blockSelector: '.pf-private, [data-brickwright-content="project-name"], …',
  },
}
```

`CAD_CONTENT_SELECTORS` is the single registry: project name, project notes,
project pane, design prompt, agent chat input, agent chat transcript, part
search query, share caption. `analytics.test.ts` asserts every row is covered by
the shipped `blockSelector`, that the mask class matches the `blockClass`
pattern, and that the selectors actually match the DOM they claim to.

---

## 7. Verified SDK limitation — read before adding a clickable project name

Verified against `@hexclave/react@1.0.108` by reading the shipped source:

* `blockClass`, `blockSelector` and `maskAllInputs` are consumed **only** by the
  session-replay recorder
  (`dist/esm/lib/hexclave-app/apps/implementations/session-replay.js`).
* The automatic product-event tracker in the sibling `event-tracker.js` captures
  `$page-view` and `$click`. For `$click` it records
  `text: target.textContent` (200 chars) and an `elements_chain` carrying each
  ancestor's text (80 chars each) plus `id`, `name`, `aria-label`,
  `placeholder` and `title`. **It consults no masking option.**
* There is no public API for custom client events. The only send path,
  `sendAnalyticsEventBatch`, sits behind `hexclaveAppInternalsSymbol` and is
  marked `@internal`. Hexclave's own documentation assistant confirms this.
* `analytics.enabled` is all-or-nothing: setting it `false` disables session
  replay as well.

Consequences, both encoded in code:

1. The DOM contract in §2 is the mask for `$click`. `maskedContentProps()` marks
   the region; keeping content out of interactive elements' accessible names is
   what actually keeps it out of `elements_chain`.
2. `usePlatformAnalytics()` events are **buffered, not delivered** —
   `platformAnalyticsStatus()` returns `buffered-no-sink` until a deployment
   calls `setPlatformAnalyticsSink()`. It does not pretend otherwise.

`analytics.test.ts` pins the SDK behaviour: it asserts `event-tracker.js` still
reads `target.textContent` and still contains no `blockSelector`. When Hexclave
adds click masking that test fails, and the contract can be tightened.

---

## 8. Launch-readiness checklist

Everything here needs live production credentials or a console action and
therefore **has not been done**.

- [ ] **Trusted domains.** Add the production origin to the Hexclave project's
      trusted domains. Until then OAuth and cross-domain sign-in redirects are
      rejected. Also whitelist the redirect URLs `/auth/sign-in`,
      `/auth/sign-up`, `/projects` and `/`.
- [ ] **Production OAuth credentials.** `hexclave.config.ts` enables Google and
      GitHub, which work in development on Hexclave's shared development
      credentials. Production needs your own OAuth client ID and secret per
      provider, configured per environment (they deliberately are not in the
      config file).
- [ ] **Email delivery.** The `emails` app is installed and a theme is selected,
      but no sending domain has been verified and no message has ever been sent.
      Verify the domain, then exercise `sendPlatformEmail` from a server
      process.
- [ ] **Error monitoring.** `PlatformErrorBoundary` writes to `console.error`.
      Wire a reporter there before launch; there is no monitoring backend
      configured.
- [ ] **Hexclave production mode.** Take the project out of development mode,
      rotate `HEXCLAVE_SECRET_SERVER_KEY`, and confirm `devTool` does not render
      (it is `"auto"`, which hides itself in production, but confirm it).
- [ ] **Analytics sink.** Register a `setPlatformAnalyticsSink()` target, or
      accept that named events are buffered and dropped (§7).
- [ ] **SPA fallback.** Configure the static host to serve `index.html` for
      unknown paths, or `/gallery` and `/share/:slug` 404 on reload.
- [ ] **`VITE_HEXCLAVE_PROJECT_ID`** set in the production build environment.

---

## 9. NOT_COMPLETE

Things this workstream did not and could not prove, stated plainly.

1. **No live authentication was exercised.** No project ID is available to this
   process, so no real sign-in, sign-up, OAuth round-trip, passkey ceremony, OTP
   email or MFA challenge has been run. The auth surfaces are covered by tests
   against a mocked SDK, and the URL configuration is verified against the
   installed `.d.ts` and with Hexclave's documentation assistant — but "it
   compiles and the shapes are right" is not "a human signed in".
2. **No email has been sent.** `sendPlatformEmail` has never executed against
   the live project. Only rendering, the transport-unavailable path and the
   browser guard are tested.
3. **Custom analytics events are not delivered anywhere** (§7). They are
   buffered and reported as such.
4. **Session replay masking is verified by configuration, not by a recording.**
   No replay has been captured and inspected to confirm the blocked regions are
   blank in the player.
5. **`$click` text capture remains a real exposure** for any CAD content placed
   in an interactive element's accessible name (§7). The DOM contract mitigates
   it; nothing enforces it mechanically across other workstreams' code.
6. **Restricted-user states are tested against a mocked `isRestricted`.** No
   real restricted account has been created.
7. **Pre-existing, not introduced here:** when the project ID is absent the
   Hexclave SDK calls `window.alert()` while the client app fails to construct
   (jsdom logs `Not implemented: Window's alert() method`). This happens on the
   same code path `src/main.tsx` already took before this change. Worth deciding
   about before the browser smoke harness runs against an unconfigured build.
8. **Route paths beyond `/editor` have no surfaces yet.** Six of the seven
   routes render the "not installed" state in this build, by design.
