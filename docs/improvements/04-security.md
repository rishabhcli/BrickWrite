# Security and privacy

Ten findings from a defensive review of the deployed application, ordered most
severe first. Severity is about consequence if reached, not likelihood.

**Verified by hand:** findings 1 and 2. `authorizeWrite`
(`functions/_lib/env.ts:71-81`) is a single deployment-wide bearer with no
per-caller identity; `viewerIsOwner` appears only in `src/features/share/access.ts:52,78`
and one test, never populated in production; `verifyPublicationIntegrity` is
exported from `src/features/share/index.ts:24` and called by nothing.

**One calibration on finding 1.** `SHARE_PUBLISH_TOKEN` is a server-side secret,
not a credential a normal user holds, so this is not "anyone on the internet can
revoke your publication". The accurate reading is that **no ownership model
exists at all** — which is a blocker the moment more than one person publishes,
and the reason it leads this list.

---

## 1. Add per-owner authorisation to every publication write

**Severity:** Critical
**Evidence:** `functions/publications/[[route]].ts:59-139,147-151`; `functions/_lib/env.ts:12-31,71-81`; `src/features/share/access.ts:78-92`; `functions/_lib/resolve.ts:36-40`; `docs/integration/share-studio.md:218-232`
**Why it matters:** `POST /publications`, `/revoke`, `/access`, `/tokens`, `/tokens/:id/revoke` and `GET /tokens` are gated only by `authorizeWrite`. `mustFind()` resolves a publication by slug and mutates it without comparing against any caller identity, and `AccessDecision.viewerIsOwner` is never populated by any caller — ownership is unimplemented end to end. Any principal satisfying the one shared bearer can flip any publication to `public`, mint unlisted links against it, or withdraw it, regardless of who published it.
**Change:** Require a verified Hexclave session on these routes (reuse the verifier pattern in `server/security/auth.ts`), persist an owner subject on the `Publication` record, and compare it inside `mustFind` before any `store.put` / `store.updateMetadata` / `store.putToken`. Wire `resolveAccess({ viewerIsOwner })` from the same session in `functions/_lib/resolve.ts`. Retire `SHARE_PUBLISH_TOKEN` once the session gate lands, or scope it to server-to-server tooling on a separate route.
**Effort:** L    **Risk:** Existing publications carry no owner field, so a migration or grandfather rule is needed or they become unmanageable; `tools/e2e/share.mjs` and `functions/_dev/*` authenticate with the bearer and need a session fixture.

## 2. Re-derive and re-verify a publication server-side instead of storing the submitted record

**Severity:** High
**Evidence:** `functions/publications/[[route]].ts:181-215`; `src/features/share/publish.ts:95-137,198-200`; `src/features/share/sanitize.ts:1-24`; `src/features/share/serialize.ts:19-47`
**Why it matters:** The route validates card hashes and part count, then persists the caller's entire `Publication` JSON. It never calls `createPublication`, `serializePublishedDocument` or `verifyPublicationIntegrity`. Every field — `title`, `description`, `tags`, `author`, `license`, `capabilities`, `visibility`, `revokedAt`, `moderation`, `summary.validation.healthy`, `steps[].name` — is accepted as submitted. The two-layer defence `sanitize.ts` documents ("at ingest, and again at output") is really one layer, because ingest runs in the browser; only output escaping in `page.ts` remains, and `contentHash` no longer attests to anything.
**Change:** In `publish()`, run the submitted document back through `serializePublishedDocument` + `summarisePublication`, recompute `contentHash` and reject on mismatch, re-apply `sanitizeTitle`/`sanitizeDescription`/`sanitizeTags`/`normaliseAuthor`, force `revokedAt: null` and `moderation: null`, and derive `capabilities` via `resolveCapabilities` rather than trusting the body. Call `verifyPublicationIntegrity` on read in `KvPublicationStore.getBySlug`.
**Effort:** M    **Risk:** Records already in KV may fail the recomputed hash on read.

## 3. Replace the KV read-modify-write rate limiter with an atomic counter

**Severity:** High
**Evidence:** `functions/api/[[route]].ts:12-14,34-46,74-82`; `wrangler.toml:14-16`; `vercel.json:6-10`
**Why it matters:** This is the only spend control in front of the model provider key. `withinRateLimit` does `kv.get` → compare → `kv.put`, which is not atomic; Cloudflare KV is eventually consistent and throttles repeated writes to one key, so concurrent requests observe the same stale count and the 20/60s ceiling does not hold. Line 43 also fails open — an unparseable stored value skips the refusal entirely. The bucket is keyed on the raw `Authorization` header, which the edge never verifies, so it cannot express a per-account quota. Each admitted call can run for `maxDuration: 300`.
**Change:** Move the counter to a Durable Object or Cloudflare's Rate Limiting binding so increment-and-test is atomic; treat an unreadable counter as over-limit rather than under; add a longer-window ceiling alongside the per-minute one. Once identity is verified upstream, key on the account subject and keep IP as the anonymous fallback.
**Effort:** M    **Risk:** A Durable Object adds a hop and cold start to every paid call; failing closed will refuse traffic during KV/DO incidents that previously passed.

## 4. Add a Content-Security-Policy and frame protection to the application shell

**Severity:** High
**Evidence:** `public/_headers:1-4`; `vercel.json:36-52`; `index.html:1-21`; contrast `src/features/share/page.ts:93-106,190-191`
**Why it matters:** The server-rendered share and embed pages carry a strict per-response nonce CSP, `X-Frame-Options: DENY` and a `Cross-Origin-Resource-Policy`. The SPA — where the session, project management, publish, role changes and delete all live — carries only `nosniff`, `Referrer-Policy` and `Permissions-Policy`. No CSP, so any script-execution defect in the bundle has no second line of containment; no `frame-ancestors`, so the authenticated console can be framed by any origin; no HSTS or COOP.
**Change:** Add to both `public/_headers` (`/*`) and `vercel.json` (`/(.*)`): a CSP with `default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self' <convex> <hexclave>; img-src 'self' data: blob:; worker-src 'self' blob:`, plus `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin`. Roll out in `Report-Only` first.
**Effort:** M    **Risk:** Three.js/R3F worker paths and the Hexclave SDK often need `blob:` and may need `wasm-unsafe-eval`; `frame-ancestors 'none'` must not apply to `/embed/*`, which the Function sets deliberately.

## 5. Reject anonymous and restricted identities in Convex, and bound per-account writes

**Severity:** High
**Evidence:** `convex/auth.config.ts:23-27` (resolves to a second `projects-anonymous-users` issuer with `include_anonymous=true`); `convex/model/auth.ts:35-44`; contrast `server/security/auth.ts:96-111`; `convex/projects.ts:103-196`
**Why it matters:** The deployment trusts two issuers, one minting tokens for anonymous users. `readIdentity` returns a `CloudIdentity` for any valid token and never inspects an anonymous or restricted claim, so every mutation reachable through `authoriseProject` treats an anonymous session as a full principal. The paid API route explicitly refuses both (401/403); the database layer does not. **The two gates disagree.** Additionally `projects.create` and `saveCheckpoint` have per-payload ceilings but no per-account project count, byte budget or write rate limit.
**Change:** Have `readIdentity` read the anonymity/restriction claims and return `UNAUTHENTICATED` for both on every mutation; allow anonymous explicitly for `project.read` only if wanted. Drop the anonymous provider from `auth.config.ts` if unused. Add a per-subject project count and stored-byte budget in `projects.create` and `model/snapshots.ts:writeSnapshot`.
**Effort:** M    **Risk:** If onboarding relies on an anonymous session to create a first cloud project, that path breaks.

## 6. Bind an invitation to the address it was sent to

**Severity:** Medium
**Evidence:** `convex/invitations.ts:22-28,30,141-213`; `convex/schema.ts:206-232`
**Why it matters:** `accept` matches on `token` alone and inserts a `members` row for `identity.subject`, with no check that it belongs to the invited address. A forwarded invite, shared mailbox or mail archive transfers project access to an unintended account, and `auditEvents` records only the role — the redactor strips the address at `model/redaction.ts:34` — so the trail cannot show the wrong person joined. The 14-day TTL is long for a bearer credential in email.
**Change:** Store the invited address as a normalised hash and compare it in `accept` against a verified email claim before inserting membership. Shorten `INVITATION_TTL_MS` to 48–72 hours. If no verified claim is available, record the accepting subject and surface a "joined via link" state for the owner to confirm.
**Effort:** M    **Risk:** Users accepting from a different address than invited (common) get blocked and need a re-invite.

## 7. Stop exposing member rosters and live presence to non-members of public projects

**Severity:** Medium
**Evidence:** `convex/model/capabilities.ts:93-94`; `convex/model/auth.ts:97-99`; `convex/members.ts:26-37`; `convex/presence.ts:43-121`; `convex/model/records.ts:80-88,124-137`
**Why it matters:** Any signed-in account inherits `viewer` on a `public` project, and `viewer` holds both `member.list` and `presence.publish`. `members.list` returns every member's subject, display name, role and `invitedBySubject`; `presence.list` returns every live collaborator's subject, camera target, cursor position, selection and follow relationship. **Publishing a model also publishes the team roster and a real-time feed of who is working on it and where they are looking.**
**Change:** Remove `member.list` from the `viewer` and `commenter` rows of `CAPABILITY_MATRIX`, or gate `members.list` on an explicit membership row. Restrict `presence.list`/`presence.publish` to explicit members. Consider returning an opaque handle instead of the raw subject.
**Effort:** S    **Risk:** Avatar rows on publicly shared projects go empty for non-members; `src/cloud/permissions.ts` mirrors the matrix and changes with it.

## 8. Move the unlisted-link secret out of the query string

**Severity:** Medium
**Evidence:** `functions/_lib/respond.ts:108-118`; `src/features/share/tokens.ts:11-32`; `src/features/share/sanitize.ts:259-275`
**Why it matters:** The token design is sound — 256-bit secret, hashed at rest, constant-time compare, uniform failure messages — but the secret travels as a URL query parameter. `redactShareUrl` only sanitises strings the application echoes; it cannot reach Cloudflare/Vercel access logs, browser history and session restore, or proxy URL logging, all of which retain a working link indefinitely.
**Change:** On first presentation of a valid `?t=`, set a `HttpOnly; Secure; SameSite=Lax` cookie scoped to the share path, redirect to the same path without the parameter, and read from the cookie thereafter. Keep `?t=` as bootstrap only. Add `Cache-Control: private, no-store` on token-authorised HTML.
**Effort:** M    **Risk:** Embeds in third-party frames need `SameSite=None; Secure`, which should be decided deliberately.

## 9. Bound the unbounded `.collect()` reads on project-scoped queries

**Severity:** Medium
**Evidence:** `convex/comments.ts:43,47,66`; `convex/invitations.ts:47,70`; `convex/members.ts:34,125`; `convex/presence.ts:118`; `convex/projects.ts:68,98`; `convex/versions.ts:107`; `convex/model/snapshots.ts:77-80`
**Why it matters:** `transactions.listSince` and `projects.auditTrail` cap reads with `.take(...)`, but twelve other queries collect a whole index range. Any member with `comment.create`, `version.create` or `branch.create` — an editor or commenter seat, not an owner — can grow those ranges past Convex's per-query read limit, at which point the comment thread, version list or project list stops loading for everyone and cannot recover from the client.
**Change:** Replace each `.collect()` with `.take(n)` at a documented ceiling and return a cursor where the list is open-ended. For `readSnapshot`, take `chunkCount + 1` and treat an over-read as corruption.
**Effort:** M    **Risk:** Callers in `src/cloud/` assume complete arrays; paginating changes those call sites.

## 10. Track the vulnerable transitive dependencies pinned by the Hexclave SDK

**Severity:** Medium
**Evidence:** `package.json:35-36,48`; `npm audit` reports 8 advisories (2 high, 6 low), all `fixAvailable: false`: `extract-zip <=2.0.1` (GHSA-jmr9-qjv8-65gv, CVSS 8.1) via `@hexclave/cli`, and `elliptic <=6.6.1` (GHSA-848j-6mx2-7j84) via `@hexclave/shared`, reaching production through `@hexclave/react`
**Why it matters:** Direct dependencies are current and the bundle is clean — no secret from `.env.local` appears in `dist/`, and there is no `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML` or `eval` outside test files. The residual exposure is entirely transitive and unfixable from this repo; `elliptic` ships to the browser via the `hexclave` chunk group in `vite.config.ts:49-52`.
**Change:** Add `npm audit --audit-level=high` to CI so a new advisory fails the build. Pin patched versions with an npm `overrides` block and verify the SDK still works; if that breaks it, open an upstream issue and record the accepted risk with a review date.
**Effort:** S    **Risk:** An `overrides` entry can break the SDK's crypto path in a way unit tests will not catch — needs a sign-in smoke test on a preview deployment.
