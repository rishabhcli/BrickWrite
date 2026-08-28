# Publish & share — workstream 9

Share Studio, immutable publications, unlisted links, crawlable share pages,
the read-only viewer, embeds and the public gallery.

Owns `src/features/share/**`, `src/features/gallery/**`, `functions/**`,
`tools/e2e/share.mjs` and this file. Imports only the CAD kernel (`src/cad/*`),
`src/platform/*` and its own directory.

---

## 1. What this workstream guarantees

| Guarantee | Where it is enforced | Where it is proved |
| --- | --- | --- |
| A publication captures an **exact revision** and never changes | `serialize.ts` builds a fresh structure from primitives; `publish.ts` deep-freezes it; `backend/kv-store.ts` refuses a second write to a slug and refuses any `updateMetadata` that moves `contentHash`, `revision` or `id` | `publish.test.ts` — publish at N, apply five mutations to the very object that was published, assert the bytes are identical |
| Nothing private reaches a publication | `serialize.ts` is an **allowlist**, not a copy-with-deletions | `publish.test.ts` — a fixture carrying a private note, an agent prompt, a transaction id, a signed URL, protected parts and the private project id; every marker is asserted absent |
| Unlisted links are unguessable, revocable and fail closed | `tokens.ts` (256-bit secret, SHA-256 stored, constant-time compare) + `access.ts` (one gate, ordered checks) | `tokens.test.ts` — wrong / revoked / expired / wrong-publication / malformed all denied; revoked is byte-identical to forged |
| The share page is crawlable without JavaScript | `functions/share/[slug].ts` renders finished HTML at the edge | `page.test.ts` (template) + `tools/e2e/share.mjs` (real HTTP `fetch`, no browser) |
| `og:image` is a real render of the published revision | Cards are rendered by `src/cad/raster.ts` at publish time from the captured snapshot, stored under the SHA-256 of their own bytes | `render/cards.test.ts` + the acceptance run, which fetches `og:image` and checks the PNG header is 1200×630 |
| The same revision + preset ⇒ byte-identical output | Pure pipeline; own deflate/PNG encoder in `render/png.ts` (no zlib, no canvas) | `render/cards.test.ts` — two renders, and a render from an independently rebuilt snapshot |
| The public viewer cannot mutate the canonical project | `viewer/**` imports no engine, session, command bus or repository; the reducer has no mutating action | `viewer/viewer.test.tsx` — reads the module sources and asserts it |

---

## 2. Public exports

`src/features/share/index.ts` and `src/features/gallery/index.ts` are the only
supported entry points.

### Publishing

```ts
import { createPublication, forkPublication, revokePublication } from '@/features/share'

const publication = await createPublication({
  document,                 // ModelDocument — captured, not referenced
  validation,               // ValidationReport | null; null publishes "not validated"
  visibility: 'unlisted',   // 'private' | 'unlisted' | 'public'
  capabilities: { view: true, comment: false, fork: true, download: false, embed: false },
  title, description, tags, author,   // all sanitised; author may be null
  cards,                    // PublicationCard[] rendered from this same snapshot
})
```

`createPublication` is `async` because the content hash goes through WebCrypto.
The returned object is deeply frozen.

### Rendering

```ts
import { renderCard, renderTurntable, renderBuildSequence, STUDIO_PRESETS, CARD_PRESET_IDS } from '@/features/share'

const card = renderCard({ document: published, geometry, palette, settings: STUDIO_PRESETS.studio }, 'opengraph')
// card.bytes is a PNG; renderTurntable / renderBuildSequence return APNG
```

`geometry` is `(definitionId) => { positions, indices, slices } | null`.
In the browser use `loadPublicationGeometry` + `residentGeometry` from
`viewer/geometry`; in Node decode the committed `.bwmesh` assets directly.

### React surfaces

| Export | Purpose |
| --- | --- |
| `ShareStudio` | The authoring surface. Props: `document`, `geometry`, `validation`, `author`, `onPublish`. |
| `SharedViewer` | The read-only viewer. Props: `publication`, `capabilities`, `geometry`, `onFork`. |
| `ShareBar` | Web Share / clipboard / selectable-link affordances. |
| `GalleryPage` | The public gallery (default export of `src/features/gallery`). |

### Route registration — **integrator action**

`src/platform/routes.ts` already declares `share` at `/share/:slug` (boot
`catalog`) and `gallery` at `/gallery` (boot `none`). Both resolve through
`registerRoute`, so the integrator adds two calls wherever the other surfaces
are registered:

```ts
import { registerShareRoute } from './features/share'
import { registerGalleryRoute } from './features/gallery'

registerShareRoute(registerRoute)
registerGalleryRoute(registerRoute)
```

`/share/:slug` is served by the Cloudflare Function on a cold navigation and by
the React viewer on an in-app navigation. Both read the same publication; only
the Function is reachable without JavaScript. `boot: 'catalog'` is required —
the viewer resolves geometry through `catalog.get()`.

---

## 3. Cloudflare Pages Functions

Deployed from `functions/`. Files beginning with `_` are not routed.

| Route | File | Method | Notes |
| --- | --- | --- | --- |
| `/share/:slug` | `share/[slug].ts` | GET | Server-rendered HTML. `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, nonce'd inline style + script. |
| `/share/:slug/card/:preset.png` | `share/[slug]/[[rest]].ts` | GET | PNG from storage. ETag = content hash; `immutable` for public, `private` for unlisted. Honours `If-None-Match`. |
| `/share/:slug/view.json` | same | GET | Publication + granted capabilities, for the interactive viewer. |
| `/share/:slug/summary.json` | same | GET | Metadata without the snapshot. |
| `/share/:slug/model.json` | same | GET | Canonical bytes as an attachment. Requires the `download` capability. |
| `/embed/:slug` | `embed/[slug].ts` | GET | Requires the `embed` capability. CSP `frame-ancestors` from `SHARE_EMBED_ANCESTORS`, default `https:`. No `X-Frame-Options`. `noindex`. |
| `/publications` | `publications/[[route]].ts` | GET | Public gallery feed, paged by cursor. |
| `/publications` | same | POST | Publish. Bearer. Verifies each uploaded card against its recorded SHA-256. |
| `/publications/:slug/access` | same | POST | Visibility / capabilities. Bearer. Never touches the snapshot. |
| `/publications/:slug/revoke` | same | POST | Bearer. Sets `revokedAt`; the record survives. |
| `/publications/:slug/tokens` | same | GET/POST | Bearer. POST returns the secret **once**; GET never returns `secretHash`. |
| `/publications/:slug/tokens/:id/revoke` | same | POST | Bearer. |
| `/publications/:slug/report` | same | POST | Moderation report. |
| everything under `functions/` | `_middleware.ts` | — | Header floor: `nosniff`, `Referrer-Policy`. Never overwrites a handler's header. |

Unlisted access is `?t=<id>.<secret>`. The token is read once, never logged, and
`redactShareUrl` runs on any URL that leaves a handler.

### Local runner

Cloudflare Pages Functions cannot be served by Vite, so a small runner
reproduces the routing and invokes the *same modules* through Vite's SSR
pipeline:

```bash
node functions/_dev/server.mjs --port 5199 --data .share-dev
node functions/_dev/server.mjs --port 5178 --data .share-e2e --proxy http://127.0.0.1:4174
node functions/_dev/publish-fixture.mjs --server http://127.0.0.1:5199 --author "Your Name"
```

`--proxy` forwards non-function requests to an already-running application, so
`tools/e2e/run-all.mjs` still boots exactly one app server.

Storage locally is `functions/_lib/file-kv.ts` — a real filesystem-backed
namespace, so a publication survives a restart. `MemoryKv` exists only as a test
double and is documented as such in its own file.

---

## 4. Schema fragments and merge instructions — **for the cloud workstream**

This workstream does not write `convex/**`. The fragments below are exported as
strings from `src/features/share/backend/schema.ts` so they can be pasted
verbatim and asserted by `backend/store.test.ts`.

### Step 1 — tables

Paste `CONVEX_SHARE_TABLES` into the object passed to `defineSchema` in
`convex/schema.ts`. Four tables: `publications`, `shareTokens`,
`publicationReports`, `publicationCollections`.

```ts
publications: defineTable({
  schemaVersion: v.number(),
  publicationId: v.string(),
  slug: v.string(),
  ownerId: v.optional(v.id('users')),
  projectId: v.optional(v.string()),
  visibility: v.union(v.literal('private'), v.literal('unlisted'), v.literal('public')),
  capabilities: v.object({ view: v.boolean(), comment: v.boolean(), fork: v.boolean(), download: v.boolean(), embed: v.boolean() }),
  title: v.string(), description: v.string(), tags: v.array(v.string()),
  author: v.union(v.null(), v.object({ displayName: v.string(), handle: v.union(v.string(), v.null()), url: v.union(v.string(), v.null()) })),
  license: v.string(), publishedAt: v.string(), revision: v.number(), contentHash: v.string(),
  snapshot: v.any(),   // exactly what serializePublishedDocument produced
  summary: v.any(),
  cards: v.array(v.object({ preset: v.string(), width: v.number(), height: v.number(), contentType: v.literal('image/png'), sha256: v.string(), byteLength: v.number(), frames: v.number(), alt: v.string() })),
  fork: v.union(v.null(), v.any()),
  revokedAt: v.union(v.string(), v.null()),
  moderation: v.union(v.null(), v.object({ status: v.string(), reason: v.string(), decidedAt: v.string() })),
})
  .index('by_slug', ['slug'])
  .index('by_publication_id', ['publicationId'])
  .index('by_owner', ['ownerId'])
  .index('by_visibility_published', ['visibility', 'publishedAt']),

shareTokens: defineTable({
  tokenId: v.string(), publicationId: v.string(), slug: v.string(),
  secretHash: v.string(),          // SHA-256 hex. NEVER the secret.
  scope: v.object({ view: v.boolean(), comment: v.boolean(), fork: v.boolean(), download: v.boolean(), embed: v.boolean() }),
  label: v.string(), createdAt: v.string(),
  expiresAt: v.union(v.string(), v.null()),
  revokedAt: v.union(v.string(), v.null()),
})
  .index('by_token_id', ['tokenId'])
  .index('by_publication', ['publicationId']),
```

`publicationReports` and `publicationCollections` are in the same constant.

**Invariants the cloud implementation must preserve:**

1. **`snapshot`, `revision` and `contentHash` are insert-only.** Patching any of
   them breaks every link that was already shared. `updateMetadata` must compare
   all three and throw. This is the headline gate of the workstream.
2. **`shareTokens.secretHash` is a digest.** If a field named `secret` ever
   appears, the merge is wrong; `backend/store.test.ts` asserts against it.
3. **`by_token_id` must be a point read.** A scan makes verification time depend
   on how many tokens exist, which is observable.
4. **Card *bytes* do not belong in Convex.** They are up to a megabyte each and
   immutable — keep them in R2 or KV keyed by `sha256`, exactly as
   `PublicationStore.putCard/getCard` does.

### Step 2 — functions

`CONVEX_SHARE_FUNCTIONS` lists the thirteen functions and the authorisation
each needs. The full list is in `backend/schema.ts`; the shape is
`publish / updateAccess / revoke / getBySlug / getById / listPublic /
mintToken / getToken / listTokens / revokeToken / submitReport / listReports /
setModeration`.

### Step 3 — the adapter

Implement `PublicationStore` (`backend/adapter.ts`) over those functions. It is
five point reads, four writes and one paged listing. `publicationToRow` /
`publicationFromRow` / `tokenToRow` / `tokenFromRow` already do the mapping and
their round trip is asserted.

Then hand it to the Pages Functions in place of `storeFor(env)`.

### Step 4 — authorisation

**This is the thing this workstream could not do.** It has no session layer, so
every write endpoint is currently gated on a shared bearer secret
(`SHARE_PUBLISH_TOKEN`, compared in constant time over SHA-256). Replace it:

- `publish`, `updateAccess`, `revoke`, `mintToken`, `revokeToken`, `listTokens`
  → the authenticated owner of `projectId`.
- `listReports`, `setModeration` → a moderator role.
- Reads stay anonymous; `resolveAccess` already governs them.

Set `AccessRequest.viewerIsOwner` from the session once it exists — the gate
already handles it, and there is a test for the owner path.

---

## 5. Environment and deployment

| Binding | Required | Purpose |
| --- | --- | --- |
| `SHARE_KV` | yes | KV namespace: publications, cards, tokens, reports, collections. Without it every route returns 503 with an operator-facing message. |
| `SHARE_PUBLISH_TOKEN` | yes, until sessions land | Bearer for writes. **Unset means writes are closed**, not open. |
| `SHARE_ORIGIN` | recommended | Canonical origin, e.g. `https://brickwrite.tech`. When unset the request's own origin is used — fine for preview deployments, wrong for production, because a canonical tag must not follow an arbitrary `Host` header. |
| `SHARE_EMBED_ANCESTORS` | no | Space-separated origins allowed to frame an embed. Empty means any `https:`. |

Deployment steps:

1. `wrangler kv namespace create BRICKWRIGHT_SHARE` (and a `--preview` one).
2. Bind it as `SHARE_KV` on the Pages project, for production and preview.
3. Add `SHARE_PUBLISH_TOKEN` and `SHARE_ORIGIN` as encrypted environment
   variables.
4. `functions/` deploys automatically with `pages deploy dist` — the existing
   `.github/workflows/ci.yml` job needs no change; Pages picks the directory up
   from the repository root.
5. Nothing else. There is no build step for the functions and no extra
   dependency: the PNG encoder, the deflate and the rasteriser are all in-repo.

---

## 6. Design decisions worth knowing

**Rotating the model, not the camera.** `src/cad/raster.ts` projects along one
fixed direction, which is what makes a printed booklet stable page to page.
Rather than fork it, the studio applies the inverse rotation to the scene
(`render/scene.ts`). The image is identical and there is still exactly one
tested rasteriser.

**"Lighting" controls are tone controls.** The key light is fixed in document
space, so orbiting moves the model under it like a turntable in a lit studio —
which is correct and desirable. What the studio *cannot* do is move the lamp, so
the controls are named exposure, contrast and shadow lift, and they run on the
rendered buffer. They are not a relight and do not claim to be.

**Own PNG/APNG encoder.** `canvas.toDataURL` depends on the browser's PNG
writer and `zlib.deflateSync` on the zlib build. Neither gives byte-identical
output across environments, so `render/png.ts` implements fixed-Huffman DEFLATE
and adaptive PNG filtering directly. Costs a few percent of ratio against zlib
level 9; buys the determinism gate. Round-tripped against Node's zlib in
`render/png.test.ts`.

**Cards are rendered at publish time, in the client.** The compiled geometry is
already resident there, and rendering at the edge would mean shipping the
catalog into a Worker. The upload is verified against the recorded SHA-256, so a
tampered card is rejected rather than served.

**`view.json` is not gated on `download`.** Anything rendered can be extracted;
pretending the geometry is secret while drawing it on screen would be theatre.
`download` governs whether a *file is offered* — a licensing and attribution
decision, not a confidentiality one.

**No invented metrics.** `GalleryEntry` has no view count, like count or
trending score, and `gallery.test.tsx` asserts the field list. An empty gallery
renders an empty gallery and says why.

---

## 7. What is not proved

Stated plainly, because an unproved claim is worse than an absent one.

1. **No deployment has run.** Every route is exercised against the local Pages
   runner, which loads the same modules through Vite's SSR pipeline and
   reproduces Cloudflare's path routing. It is not Cloudflare. The bindings, the
   `_`-prefix routing convention and KV's real consistency behaviour are
   untested against the platform.
2. **KV is eventually consistent.** `put` is create-only and checks for an
   existing slug first, which is a read-then-write race. With 60 bits of slug
   suffix a collision is not a practical concern, but the check is not atomic and
   Convex should use a unique index instead.
3. **`frame-ancestors` is the only embed protection.** `X-Frame-Options` has no
   allowlist form, so it is deliberately absent from the embed response. A
   browser too old for CSP `frame-ancestors` gets no framing protection on
   `/embed/:slug`. It still gets `DENY` on the share page.
4. **The timing test is statistical.** `constantTimeEqual` is asserted
   structurally (it examines every byte) and statistically (median of nine
   interleaved passes, 20 000 iterations each, ratio banded 0.5–2.0). That
   catches a short-circuiting comparison. It does not prove the absence of a
   microarchitectural side channel, and JavaScript cannot.
5. **Rate limiting does not exist.** Nothing throttles publish, token minting or
   reports beyond the bearer secret and the payload cap. That belongs with the
   session layer.
6. **Moderation has no interface.** `applyModeration`, `moderationQueue` and
   `resolveReport` are implemented and tested; there is no moderator screen, and
   `listReports`/`setModeration` are gated on the same stopgap bearer as
   everything else.
7. **Comments are a capability, not a feature.** `comment` is carried through
   visibility, tokens and the access gate, and it gates nothing yet because no
   comment surface has been built. `sanitizeComment` and the length limits are
   in place for when it is.
8. **The gallery feed is unpaged in the UI beyond "Load more".** Search, sort
   and faceting run client-side over the loaded pages, which is honest for a
   gallery of tens and wrong for a gallery of thousands.
