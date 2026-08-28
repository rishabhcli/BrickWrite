/* eslint-disable */
/**
 * STAND-IN FOR CONVEX CODEGEN — replace by running `npx convex dev`.
 *
 * The module map below is maintained by hand and must list every file under
 * `convex/` that exports Convex functions. `npx convex codegen` regenerates it
 * from the directory listing; until then, adding a function file means adding a
 * line here.
 *
 * The browser deliberately does not import this file. `src/cloud/functionRefs.ts`
 * builds its references with `makeFunctionReference`, so the client bundle never
 * pulls the server modules in. See `docs/integration/cloud-projects.md` for the
 * one-line swap that switches the client onto the real generated `api` once
 * codegen has run.
 */
import { anyApi } from 'convex/server'
import type { ApiFromModules, FilterApi, FunctionReference } from 'convex/server'

import type * as comments from '../comments'
import type * as invitations from '../invitations'
import type * as members from '../members'
import type * as presence from '../presence'
import type * as projects from '../projects'
import type * as transactions from '../transactions'
import type * as versions from '../versions'

declare const fullApi: ApiFromModules<{
  comments: typeof comments
  invitations: typeof invitations
  members: typeof members
  presence: typeof presence
  projects: typeof projects
  transactions: typeof transactions
  versions: typeof versions
}>

export const api = anyApi as unknown as FilterApi<
  typeof fullApi,
  FunctionReference<any, 'public'>
>
export const internal = anyApi as unknown as FilterApi<
  typeof fullApi,
  FunctionReference<any, 'internal'>
>
