/**
 * Creates an opaque, collision-resistant identifier with a readable namespace.
 *
 * IDs end up in transaction logs, WebMCP payloads and exported metadata, so
 * time-plus-Math.random is not an acceptable uniqueness boundary. Modern
 * browsers and the supported Node runtime both provide `crypto.randomUUID()`.
 */
export function createId(prefix: string): string {
  const namespace = prefix.trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^[-_]+|[-_]+$/g, '')
  if (!namespace) throw new Error('An id namespace is required.')
  return `${namespace}_${crypto.randomUUID()}`
}
