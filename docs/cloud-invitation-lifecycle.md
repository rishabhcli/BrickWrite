# Reliable collaboration invitations

Humans using Members and authenticated agents using the cloud API share the
same invitation lifecycle. Email submission is now recoverable independently
of the access token: retrying delivery does not create another invitation,
change its role, or extend its 14-day lifetime.

## Delivery and recovery contract

`invitations:create` atomically writes the invitation and schedules an internal
delivery action. The action claims the current delivery generation in a mutation
before reading the address and token. Only one worker can claim a generation.
Completion must match both the generation and the still-pending invitation.
Revoked, accepted, expired, or deleted-project invitations cannot be claimed;
late completions cannot overwrite those states or a newer retry.

| Delivery status  | Meaning                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `pending`        | An attempt is scheduled, not submitted yet.                             |
| `sending`        | One worker has claimed the attempt.                                     |
| `queued`         | The provider accepted the request; **inbox delivery is unconfirmed**.   |
| `failed`         | Submission failed or timed out; delivery may still have occurred.       |
| `not-configured` | Required delivery configuration is absent or invalid.                   |
| `cancelled`      | The invitation became unavailable before completion could be recorded.  |
| `sent`           | Legacy status retained for compatibility, not new inbox-delivery proof. |

Owners can call `invitations:retryDelivery({ projectId, invitationId })`, also
available as `CloudBackend.retryInvitationDelivery` and
`ProjectStore.retryInvitationDelivery`. Members has the same **Retry delivery**
control. The response includes `deliveryAttempts`, a sanitized `deliveryReason`,
and an ISO `deliveryRetryAt` when retry is possible. Attempts count worker
claims, including configuration failures, not messages delivered.

- Retry is owner-only, project-scoped, and limited to pending, unexpired
  invitations that have not reached `queued` or legacy `sent`.
- A 30-second cooldown starts when an attempt is requested. A claimed worker
  has a 60-second lease. Stalled scheduled/claimed work can be explicitly
  retried after the respective deadline.
- Duplicate retries during a fresh pending/sending lease return the existing
  record without another job or audit event. A completed failure during its
  cooldown returns `INVALID_ARGUMENT` with `details.retryAt`.
- Members polls every five seconds while delivery or its cooldown can change,
  then stops when submission finishes or retry becomes available.
- Provider I/O has a 10-second deadline, aborts on timeout, and never follows
  redirects. There is no automatic provider retry or cross-provider fallback.
- A request carries `Idempotency-Key: brickwrite-invite:<id>:<generation>`.
  Provider enforcement of this header is **not assumed**. A retry creates a new
  generation and can send a duplicate email if the previous request succeeded
  remotely but its acknowledgement was lost. UI and API reasons say so.
- Revocation cannot recall an email already submitted or in flight. The token
  will still be rejected on acceptance. `cancelled` is not an inbox-recall claim.

`invitations:list` returns the newest 100 invitations; it is not a complete
historical export. Pending rows past their expiry are shown as expired without
rewriting history. Duplicate detection uses the project/email/status/expiry
index, so expired invitations no longer block replacement and other projects'
invitations cannot hide a duplicate.

## Retry-safe acceptance

Acceptance still requires a signed-in identity plus possession of the private
token; email is not an authorization key. A repeat request from the same
accepting identity succeeds only while the project is active and that identity
is still a member. It returns the **current** role, not the invitation's old
role. It does not write again, restore removed access, promote a demoted member,
or allow a different identity to reuse the token. This makes a lost acceptance
response recoverable for both browser and agent clients.

## Hexclave email, without a custom adapter

The default provider is Hexclave transactional email. The Convex deployment
needs its server-side `HEXCLAVE_PROJECT_ID`, `HEXCLAVE_SECRET_SERVER_KEY`, and
`INVITATION_LINK_ORIGIN`. The Emails app is already enabled in
`hexclave.config.ts`; production mail delivery also needs a working email
server/sender in that Hexclave environment. A provider refusal is reported as
`failed`, never as a successful send.

The adapter uses the installed `@hexclave/js` **1.0.108** email REST contract:

- `POST https://api.hexclave.com/api/v1/emails/send-email`
- Server authentication through the `x-hexclave-project-id`,
  `x-hexclave-access-type: server`, and `x-hexclave-secret-server-key` headers.
- `{ emails: [address], subject, html, theme_id: false }` sends to an arbitrary
  transactional recipient without creating a user account. Project names,
  roles, and links are HTML-escaped.
- Current and legacy Hexclave wrapped-error headers are checked even on HTTP
  200; response bodies and exception text are never persisted or returned.

This narrow REST adapter deliberately avoids the SDK's automatic network
retries and failover, which could resubmit an ambiguous email request without
the owner's decision. The contract is verified against the installed SDK's
`email/index.ts` and `shared/src/interface/server-interface.ts`; the general
[Hexclave email guide](https://docs.hexclave.com/guides/apps/emails/guide)
does not enumerate every recipient selector supported by that SDK version.

`HEXCLAVE_API_URL_SERVER` (or `HEXCLAVE_API_URL`) can select another trusted
Hexclave origin. HTTPS is required except for loopback development URLs. An
origin must not contain credentials, a path, a query, or a fragment. A remote
Convex deployment cannot reach a developer machine's loopback server.
`hexclave dev` injects local configuration into its wrapped process; that does
not configure a separate hosted Convex deployment.

### Existing custom email adapters

Existing `INVITATION_EMAIL_ENDPOINT` and `INVITATION_EMAIL_TOKEN` remain an
explicit override. If either is nonempty, both must be valid; a partial or
failed override never silently falls back to Hexclave. The adapter contract is
unchanged: a JSON POST with Bearer authentication and
`{ to, subject, projectName, role, invitationUrl }`. The Hexclave secret is never
forwarded to a custom adapter. Do not point this generic payload directly at
Hexclave's native API; leave the override unset to use the native adapter.

## Rollout and verification

Deploy Convex before the frontend: this adds `invitations:retryDelivery`,
optional delivery metadata, new delivery states, and the
`invitations.by_project_email_status_expiry` index. Existing rows need no
backfill or token rotation. The new worker accepts old scheduled arguments.
The retired `deliveryContext` query returns no token, and old unleased
completion writes are ignored. Already-running pre-deployment sends cannot be
recalled; stranded legacy work becomes retryable through the owner control.
Legacy stored provider error text is hidden from wire records.

Local verification uses actual Convex handlers and scheduler through
`convex-test`, mocked provider transport, and React integration tests:

```sh
npm test -- src/cloud/__tests__/invitation-lifecycle.integration.test.ts \
  src/cloud/__tests__/invitation-delivery.test.ts \
  src/cloud/__tests__/membersPanel.test.tsx
npm run test:cloud
npm run lint
npm run typecheck:convex
npm run typecheck:functions
```

Coverage includes duplicate/stale jobs, failed and timed-out delivery, cooldowns,
lease recovery, role changes, missing memberships, expiry boundaries, deleted
projects, legacy rollout, wrapped provider errors, safe HTML, and the owner UI.
No live invitation or external email is sent by these tests. Production
deployment, hosted provider acceptance, mailbox receipt, and signed-in browser
acceptance remain separate live-verification steps.
