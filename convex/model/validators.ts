import { v } from 'convex/values'

/**
 * Argument validators shared by more than one function file.
 *
 * Convex validates arguments at the deployment boundary, so these are the last
 * line before untrusted input reaches a handler. They are kept here rather than
 * inlined twice, because two copies of a payload shape drift and the copy that
 * drifts is always the one on the mutation.
 */

export const vec3 = v.object({ x: v.number(), y: v.number(), z: v.number() })

export const snapshotUpload = v.object({
  revision: v.number(),
  chunks: v.array(v.string()),
  checksum: v.string(),
  bytes: v.number(),
  schemaVersion: v.number(),
  catalogVersion: v.string(),
})

export const visibility = v.union(
  v.literal('private'),
  v.literal('unlisted'),
  v.literal('public'),
)

export const assignableRole = v.union(
  v.literal('editor'),
  v.literal('commenter'),
  v.literal('viewer'),
)

export const commentAnchor = v.object({
  partId: v.string(),
  revision: v.number(),
  poseChecksum: v.string(),
  pointLdu: v.optional(vec3),
})
