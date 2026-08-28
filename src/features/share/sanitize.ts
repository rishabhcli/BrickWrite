/**
 * Boundary sanitisation.
 *
 * Every string in a publication came from somewhere hostile: a model title
 * typed by a stranger, a filename inside an imported `.ldr`, a comment, a tag
 * pasted from a URL. This module is the single place those strings are made
 * safe, and it does the work twice on purpose:
 *
 *   - **At ingest**, markup characters, control codes and bidirectional
 *     overrides are removed and lengths are capped, so a stored record can
 *     never contain a payload at all.
 *   - **At output**, `escapeHtml`/`escapeAttribute` escape whatever is left.
 *
 * One layer would be enough if it were perfect. Neither is, so both run — an
 * escape bug cannot be exploited by a record that carries no markup, and an
 * ingest bug cannot be exploited through an escaped sink.
 *
 * Every character class below is written with `\uXXXX` escapes rather than the
 * literal character. Some of these code points — U+2028 above all — are line
 * terminators in JavaScript source and cannot legally appear inside a regular
 * expression literal at all; the rest are invisible, which is exactly the
 * property that makes them worth stripping and makes them unreviewable in
 * source.
 */

export const LIMITS = {
  title: 120,
  description: 600,
  tag: 32,
  tags: 12,
  comment: 2000,
  filename: 96,
  authorName: 64,
  handle: 40,
  url: 512,
  slug: 96,
  label: 64,
  reportDetail: 1000,
  /** Hard ceiling on an inbound publication payload, before parsing. */
  payloadBytes: 8 * 1024 * 1024,
  /** Hard ceiling on parts in a published snapshot. */
  parts: 100_000,
} as const

/**
 * Characters removed outright rather than escaped.
 *
 *   - C0/C1 control codes: they corrupt logs, CSV and terminal output.
 *   - U+200B–U+200F, U+202A–U+202E, U+2066–U+2069: zero-width joiners and
 *     bidirectional overrides. This is the Trojan Source family — a title that
 *     renders as "Safe Model" while sorting and comparing as something else.
 *   - U+2028/U+2029: line and paragraph separators, which break a JavaScript
 *     string literal in an inline `<script>`.
 *   - U+FEFF: a stray byte-order mark mid-string.
 *   - `<`, `>` and `&`: markup can never survive ingest.
 */
const STRIPPED = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff<>&]/g
/** The same set, with newline spared so a description can keep paragraphs. */
const STRIPPED_KEEP_NEWLINE =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff<>&]/g
/** Every Unicode space separator, so exotic whitespace cannot pad a title. */
const WHITESPACE = /[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g
/** Control codes that must never appear in a filename, at any position. */
const FILENAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
/** Combining marks, dropped when folding an accented title into a slug stem. */
const COMBINING_MARKS = /[\u0300-\u036f]/g

/**
 * Normalises and de-fangs a free-text field.
 *
 * NFC first, so two visually identical titles compare equal and a decomposed
 * combining sequence cannot be used to slip past a length cap. Length is
 * counted in code points, not UTF-16 units, so an emoji costs one.
 */
export function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  // Bound the work before normalising: NFC on a 50 MB string is a denial of
  // service in its own right.
  const bounded = value.length > maxLength * 8 ? value.slice(0, maxLength * 8) : value
  const normalised = bounded.normalize('NFC').replace(STRIPPED, ' ').replace(WHITESPACE, ' ').trim()
  const points = [...normalised]
  if (points.length <= maxLength) return normalised
  // Trim at a word boundary when one is close, so a cap does not cut a word in
  // half for the sake of four characters.
  const cut = points.slice(0, maxLength).join('')
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > maxLength - 16 ? cut.slice(0, lastSpace) : cut).trim()
}

/** Multi-line text (descriptions, comments): paragraph breaks survive. */
export function sanitizeMultiline(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  const bounded = value.length > maxLength * 8 ? value.slice(0, maxLength * 8) : value
  const normalised = bounded
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(STRIPPED_KEEP_NEWLINE, ' ')
    // Three or more blank lines is layout abuse, not a paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
  const points = [...normalised]
  return points.length <= maxLength ? normalised : points.slice(0, maxLength).join('').trim()
}

export const sanitizeTitle = (value: unknown) => sanitizeText(value, LIMITS.title)
export const sanitizeDescription = (value: unknown) => sanitizeMultiline(value, LIMITS.description)
export const sanitizeComment = (value: unknown) => sanitizeMultiline(value, LIMITS.comment)
export const sanitizeLabel = (value: unknown) => sanitizeText(value, LIMITS.label)

/** Lowercase, single-word, punctuation-free tags. Empty results are dropped. */
export function sanitizeTag(value: unknown): string {
  return sanitizeText(value, LIMITS.tag)
    .toLowerCase()
    .replace(/[^a-z0-9 +#._-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, LIMITS.tag)
}

export function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    const tag = sanitizeTag(entry)
    if (tag) seen.add(tag)
    if (seen.size >= LIMITS.tags) break
  }
  return [...seen].sort()
}

/**
 * Reduces a filename to a leaf name that cannot escape a directory.
 *
 * Path traversal is handled by discarding every separator and taking the last
 * segment, rather than by rewriting `..` — rewriting invites the classic
 * `....//` bypass, where the replacement rebuilds the sequence it removed.
 * Windows separators, control codes, drive letters and leading dots all go, and
 * a reserved DOS device name is prefixed rather than trusted.
 */
export function sanitizeFilename(value: unknown, fallback = 'model'): string {
  const raw = typeof value === 'string' ? value.normalize('NFC') : ''
  const leaf = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = leaf
    .replace(FILENAME_CONTROL, '')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/[^A-Za-z0-9._ -]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, LIMITS.filename)
  if (!cleaned) return fallback
  // CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are device names on Windows; a
  // download named after one is a broken file at best.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return `file-${cleaned}`
  return cleaned
}

/**
 * Accepts only absolute http(s) URLs.
 *
 * `javascript:`, `data:`, `vbscript:` and protocol-relative `//host` forms are
 * rejected rather than repaired, because every repair heuristic has a bypass.
 */
export function sanitizeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > LIMITS.url) return null
  // A control character or whitespace inside a URL is how a scheme gets hidden
  // from a naive parser: `java\nscript:alert(1)`.
  if (/[\u0000-\u0020\u007f\u00a0\u2028\u2029]/.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (!parsed.hostname) return null
  return parsed.toString().slice(0, LIMITS.url)
}

/** HTML text-node escaping. Applied even to strings that passed ingest. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Attribute-value escaping.
 *
 * Identical to `escapeHtml` plus backtick and equals, which matter inside
 * unquoted attributes in older parsers. Newlines become spaces so a value can
 * never break out of a `<meta content="...">`.
 */
export function escapeAttribute(value: string): string {
  return escapeHtml(value.replace(/[\r\n]+/g, ' '))
    .replace(/`/g, '&#96;')
    .replace(/=/g, '&#61;')
}

/** Escaping for a `<script type="application/ld+json">` payload. */
export function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Turns a title into a URL-safe stem.
 *
 * The stem is decoration: it makes a link legible, and it is always combined
 * with a random suffix by `mintSlug`, so it carries no security weight and an
 * empty stem is fine.
 */
export function slugStem(value: unknown): string {
  return sanitizeText(value, LIMITS.slug)
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** A slug as it may appear in a URL path segment. Rejects anything else. */
export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,95}$/.test(value) && !value.includes('--')
}

/**
 * Guards a payload before it is parsed.
 *
 * Size is checked on bytes, not on `JSON.parse` output, because the parse is
 * itself the expensive step an oversized body is trying to buy.
 */
export function guardPayloadSize(byteLength: number, limit: number = LIMITS.payloadBytes): void {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new Error('Payload length is not a finite byte count.')
  }
  if (byteLength > limit) {
    throw new Error(`Payload is ${byteLength} bytes, over the ${limit}-byte limit.`)
  }
}

/**
 * Removes an unlisted token from any URL before it is logged or reported.
 *
 * The token lives in `?t=`; a request log, an analytics event or an error
 * message that echoed the full URL would hand out a working link. Every path
 * that leaves a request handler runs a URL through this first.
 */
export function redactShareUrl(value: string): string {
  try {
    const url = new URL(value, 'https://redacted.invalid')
    if (!url.searchParams.has('t')) return value
    url.searchParams.set('t', 'redacted')
    return /^https?:/i.test(value) ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  } catch {
    return value.replace(/([?&]t=)[^&#]*/gi, '$1redacted')
  }
}
