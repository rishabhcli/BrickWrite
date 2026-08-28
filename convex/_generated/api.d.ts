/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as comments from "../comments.js";
import type * as invitations from "../invitations.js";
import type * as members from "../members.js";
import type * as model_audit from "../model/audit.js";
import type * as model_auth from "../model/auth.js";
import type * as model_capabilities from "../model/capabilities.js";
import type * as model_checksum from "../model/checksum.js";
import type * as model_limits from "../model/limits.js";
import type * as model_protocol from "../model/protocol.js";
import type * as model_records from "../model/records.js";
import type * as model_redaction from "../model/redaction.js";
import type * as model_snapshots from "../model/snapshots.js";
import type * as model_validators from "../model/validators.js";
import type * as presence from "../presence.js";
import type * as projects from "../projects.js";
import type * as transactions from "../transactions.js";
import type * as versions from "../versions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  comments: typeof comments;
  invitations: typeof invitations;
  members: typeof members;
  "model/audit": typeof model_audit;
  "model/auth": typeof model_auth;
  "model/capabilities": typeof model_capabilities;
  "model/checksum": typeof model_checksum;
  "model/limits": typeof model_limits;
  "model/protocol": typeof model_protocol;
  "model/records": typeof model_records;
  "model/redaction": typeof model_redaction;
  "model/snapshots": typeof model_snapshots;
  "model/validators": typeof model_validators;
  presence: typeof presence;
  projects: typeof projects;
  transactions: typeof transactions;
  versions: typeof versions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
