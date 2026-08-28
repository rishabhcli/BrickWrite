// The narrow export is important here. Convex evaluates auth.config.ts in a
// restricted configuration bundle; importing the React package root drags in
// runtime modules that are valid in functions but cannot be evaluated here.
import { getConvexProvidersConfig } from '@hexclave/react/convex-auth.config'

const projectId = process.env.HEXCLAVE_PROJECT_ID
if (!projectId) {
  throw new Error('HEXCLAVE_PROJECT_ID must be set on this Convex deployment before functions can be pushed.')
}

/**
 * Which token issuers this deployment trusts.
 *
 * Use Hexclave's integration helper rather than reproducing its issuer paths by
 * hand. The helper derives the normal, anonymous and restricted-user providers
 * from the deployment's project id, including their JWKS endpoints. Convex then
 * validates every request before exposing it through `ctx.auth`.
 *
 * `HEXCLAVE_PROJECT_ID` is a Convex deployment variable, never a checked-in
 * value. If it is absent deployment fails closed instead of accepting tokens
 * for an accidental project.
 */
export default {
  providers: getConvexProvidersConfig({
    projectId,
  }),
}
