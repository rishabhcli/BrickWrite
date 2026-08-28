/**
 * Which token issuer this deployment trusts.
 *
 * Convex validates the JWT on every request against the issuer's JWKS and
 * exposes the result as `ctx.auth.getUserIdentity()`. Nothing in this
 * deployment mints or verifies a token itself; Hexclave is the identity plane
 * and Convex is the data plane.
 *
 * Both values are deployment environment variables, set with
 * `npx convex env set`, never checked in — the same project running against a
 * staging Hexclave project must not accept production tokens:
 *
 *   HEXCLAVE_JWKS_ISSUER   the issuer URL published in the access token's `iss`
 *   HEXCLAVE_PROJECT_ID    the audience, i.e. the Hexclave project id
 *
 * `docs/integration/cloud-projects.md` records how to read both off the running
 * Hexclave project. With them unset the deployment accepts no identity at all,
 * so every function answers `UNAUTHENTICATED` — a closed door rather than an
 * open one.
 */
export default {
  providers: [
    {
      domain: process.env.HEXCLAVE_JWKS_ISSUER,
      applicationID: process.env.HEXCLAVE_PROJECT_ID,
    },
  ],
}
