/**
 * Outbound message hygiene for the API process.
 *
 * Anything this module returns can reach a browser and, through the transcript,
 * the model's own context. A leaked bearer token would be carried onward; a
 * stack trace names files on the host and says nothing a caller can act on.
 *
 * This is deliberately a self-contained copy of the redaction policy in
 * `src/webmcp/contract.ts` rather than an import: the API process must not
 * depend on the browser module graph, and a shared file that pulled the CAD
 * kernel into Node would defeat the point of running this in its own process.
 * `sanitize.test.ts` asserts the two implementations still agree.
 */

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, '[REDACTED_KEY]'],
  [/\b(api[_-]?key|token|password|passwd|secret|cookie|authorization)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*[?&](sig|signature|token|key)=[^\s"'&]+/gi, '[REDACTED_SIGNED_URL]'],
  [/data:[^;,\s]+;base64,[A-Za-z0-9+/=]{64,}/g, '[REDACTED_DATA_URL]'],
  [/\/(?:Users|home|var|private|tmp)\/[^\s"')]+/g, '[path]'],
  [/[A-Za-z0-9+/]{200,}={0,2}/g, '[REDACTED_BLOB]'],
]

export const MAX_ERROR_MESSAGE_LENGTH = 2048

/** Strips credentials, signed URLs, host paths and blobs from an outbound message. */
export function sanitizeMessage(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value ?? '')
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_ERROR_MESSAGE_LENGTH ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : text
}

/**
 * Removes the configured key from a message even when it is not in a pattern
 * the table above recognises.
 *
 * Upstream SDK errors occasionally echo a request header verbatim. The key is
 * the one secret this process holds, so it is removed by exact match as a last
 * line of defence rather than trusted to a regular expression.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text
  return text.split(secret).join('[REDACTED_KEY]')
}
