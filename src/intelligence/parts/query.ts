import { parseDimensionToken, tokenize } from '../../cad/catalog'
import type { ColorDefinition, ConnectionFamily } from '../../cad/types'

/**
 * Turns a sentence a builder would actually say into a structured query.
 *
 * The design rule here is that nothing is allowed to disappear. A resolver that
 * quietly drops the words it does not understand produces a confident answer to
 * a question nobody asked - "a 40-stud transparent gear" comes back as a gear,
 * and the person is left to notice for themselves that it is neither 40 studs
 * nor transparent. So every word is either consumed into a slot, recognised as
 * a stop word, known to the catalog's own vocabulary, or reported in
 * `unmatchedTerms`; and every constraint carries the phrase that produced it,
 * so the resolver can name the one condition it could not meet rather than
 * reporting a vague failure.
 */

export type FinishIntent =
  | 'transparent'
  | 'chrome'
  | 'pearlescent'
  | 'glitter'
  | 'speckle'
  | 'metal'
  | 'rubber'
  | 'fabric'
  | 'glow'

/** Which constraint a phrase produced, so an unmet one can be named exactly. */
export interface DimensionPhrases {
  envelope: string | null
  footprintExtent: string | null
  heightPlates: string | null
}

export interface DimensionIntent {
  /**
   * Full footprint from "2x4", or envelope from "1x2x5".
   *
   * Compared order-insensitively across the footprint. LDraw writes the third
   * number in brick heights, not plates, which is why it is kept separate from
   * `heightPlates` rather than converted here.
   */
  envelope: number[] | null
  /** One footprint extent, from "six studs wide" or a bare "40-stud". */
  footprintExtent: number | null
  /** Height in plates, from "three plates tall" or "two bricks high". */
  heightPlates: number | null
  /** "about", "roughly", "~" - widens the tolerance band rather than failing. */
  approximate: boolean
  phrases: DimensionPhrases
  /** Every phrase above, flattened, for display. */
  evidence: string[]
}

export interface ColorIntent {
  /** LDraw colour codes the request implies, from the loaded colour table. */
  codes: number[]
  /** Named colours that matched, e.g. "trans clear". */
  names: string[]
  finishes: FinishIntent[]
  evidence: string[]
}

export type RelationIntent =
  | { kind: 'mirrored'; target: string }
  | { kind: 'printed-variant'; target: string }
  | { kind: 'base-variant'; target: string }
  | { kind: 'interface'; target: string }
  | { kind: 'bridge'; gapStuds: number }

/**
 * Which way a connector's axis has to point.
 *
 * A hinge whose axis is horizontal swings like a door; one whose axis is
 * vertical spins like a turntable. Both are called hinges, and the difference
 * is only recoverable from the compiled connector orientation.
 */
export type AxisIntent = 'horizontal' | 'vertical'

export interface PartQuery {
  raw: string
  /** Every word, after dimension folding and hyphen splitting. */
  words: string[]
  /** Words left to drive lexical and semantic retrieval. */
  contentTerms: string[]
  /** Canonical ids the query named outright. */
  ids: string[]
  /** The raw tokens that resolved to those ids, so a caller can recover which register matched. */
  idTokens: string[]
  dimensions: DimensionIntent
  color: ColorIntent
  connectors: ConnectionFamily[]
  axisOrientation: AxisIntent | null
  categories: string[]
  relation: RelationIntent | null
  /** Whether the request wants a decorated part, a plain one, or does not care. */
  variantPreference: 'printed' | 'plain' | 'any'
  /** "cheaper and more common" vs "rare"; biases the frequency signal. */
  availability: 'common' | 'rare' | 'any'
  /** Terms the parser could not interpret and the catalog has never seen. */
  unmatchedTerms: string[]
}

export interface QueryContext {
  colors: readonly ColorDefinition[]
  /** Catalog category names, so "windscreen" can reach "Windscreens and Fuselage". */
  categories: readonly string[]
  /** Resolves a token to a canonical id when the catalog knows the number. */
  resolveIdentity?: (token: string) => string | null
  /** True when the lexical vocabulary contains the term at all. */
  knowsTerm?: (term: string) => boolean
}

/**
 * Words that carry no retrieval signal on their own.
 *
 * Kept small on purpose: "round", "flat" and "small" look like filler but are
 * real LDraw vocabulary, and removing them would cost more than they save.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'is', 'are', 'be', 'it',
  'and', 'or', 'with', 'that', 'which', 'whose', 'this', 'these', 'those',
  'some', 'something', 'anything', 'thing', 'any', 'me', 'my', 'i', 'you',
  'want', 'need', 'find', 'show', 'get', 'give', 'looking', 'look', 'please',
  'part', 'parts', 'piece', 'pieces', 'element', 'elements', 'lego', 'brickwright',
  'can', 'could', 'would', 'do', 'does', 'how', 'have', 'has', 'there', 'what',
  'like', 'as', 'so', 'its', 'their', 'from', 'by', 'about', 'between', 'version',
])

/**
 * Number words, folded to digits before tokenizing.
 *
 * Doing it up front rather than at scoring time is what makes "one by two" and
 * "1 x 2" the same request: the dimension folding in `tokenize` only recognises
 * digits, so the words have to become digits before it runs.
 */
const NUMBER_WORDS: Array<[string, string]> = [
  ['twenty four', '24'], ['twenty', '20'], ['sixteen', '16'], ['fifteen', '15'],
  ['fourteen', '14'], ['thirteen', '13'], ['twelve', '12'], ['eleven', '11'],
  ['thirty', '30'], ['forty', '40'], ['fifty', '50'], ['sixty', '60'],
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'],
  ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10'],
]

const APPROXIMATE_WORDS = new Set(['about', 'around', 'roughly', 'approximately', 'circa', 'nearly', 'almost', 'ish'])
const FOOTPRINT_AXIS_WORDS = new Set(['wide', 'width', 'long', 'length', 'across', 'deep', 'depth', 'square'])
const HEIGHT_AXIS_WORDS = new Set(['tall', 'high', 'height', 'thick'])

/**
 * Words that turn the number in front of them into a measurement.
 *
 * Without this list "a 3-stud gap" resolves 3 to LDraw part 3, the Homemaker
 * Drawer, and the request quietly becomes a lookup for a piece of doll's house
 * furniture. A digit followed by a unit is a quantity, never a part number.
 */
const UNIT_WORDS = /^(?:studs?|plates?|bricks?|wide|width|long|length|tall|high|height|deep|depth|across|square|thick)$/

/**
 * Connector vocabulary. Multi-word entries are matched first, because "pin
 * hole" and "pin" are different interfaces and the longer reading is always the
 * intended one.
 */
const CONNECTOR_PHRASES: Array<{ words: string[]; families: ConnectionFamily[] }> = [
  { words: ['anti', 'stud'], families: ['anti-stud'] },
  { words: ['antistud'], families: ['anti-stud'] },
  { words: ['pin', 'hole'], families: ['pin-hole'] },
  { words: ['pin', 'holes'], families: ['pin-hole'] },
  { words: ['pinhole'], families: ['pin-hole'] },
  { words: ['axle', 'hole'], families: ['axle-hole'] },
  { words: ['axle', 'holes'], families: ['axle-hole'] },
  { words: ['axlehole'], families: ['axle-hole'] },
  { words: ['cross', 'hole'], families: ['axle-hole'] },
  { words: ['ball', 'joint'], families: ['ball', 'socket'] },
  { words: ['click', 'hinge'], families: ['hinge'] },
  { words: ['hinge'], families: ['hinge'] },
  { words: ['hinges'], families: ['hinge'] },
  { words: ['clip'], families: ['clip'] },
  { words: ['clips'], families: ['clip'] },
  { words: ['bar'], families: ['bar'] },
  { words: ['bars'], families: ['bar'] },
  { words: ['pin'], families: ['pin'] },
  { words: ['pins'], families: ['pin'] },
  { words: ['axle'], families: ['axle'] },
  { words: ['axles'], families: ['axle'] },
  { words: ['socket'], families: ['socket'] },
  { words: ['sockets'], families: ['socket'] },
  { words: ['ball'], families: ['ball'] },
  { words: ['stud'], families: ['stud'] },
  { words: ['studs'], families: ['stud'] },
  { words: ['tube'], families: ['anti-stud'] },
  { words: ['tubes'], families: ['anti-stud'] },
]

/** Finish words, and the predicate that decides which LDraw codes they mean. */
const FINISH_PHRASES: Array<{ words: string[]; finish: FinishIntent }> = [
  { words: ['see', 'through'], finish: 'transparent' },
  { words: ['glow', 'in', 'the', 'dark'], finish: 'glow' },
  { words: ['glow'], finish: 'glow' },
  { words: ['glowing'], finish: 'glow' },
  { words: ['transparent'], finish: 'transparent' },
  { words: ['translucent'], finish: 'transparent' },
  { words: ['trans'], finish: 'transparent' },
  { words: ['clear'], finish: 'transparent' },
  { words: ['chrome'], finish: 'chrome' },
  { words: ['chromed'], finish: 'chrome' },
  { words: ['pearl'], finish: 'pearlescent' },
  { words: ['pearlescent'], finish: 'pearlescent' },
  { words: ['glitter'], finish: 'glitter' },
  { words: ['glittery'], finish: 'glitter' },
  { words: ['speckle'], finish: 'speckle' },
  { words: ['speckled'], finish: 'speckle' },
  { words: ['metallic'], finish: 'metal' },
  { words: ['rubber'], finish: 'rubber' },
  { words: ['rubbery'], finish: 'rubber' },
  { words: ['fabric'], finish: 'fabric' },
  { words: ['cloth'], finish: 'fabric' },
]

function finishMatches(color: ColorDefinition, finish: FinishIntent): boolean {
  switch (finish) {
    case 'transparent':
      return color.alpha < 1
    case 'glow':
      return /glow/i.test(color.name)
    case 'metal':
      return color.finish === 'metal' || /metallic/i.test(color.name)
    default:
      return color.finish === finish
  }
}

const COMMON_WORDS = new Set(['common', 'cheap', 'cheaper', 'ordinary', 'everyday', 'popular', 'plentiful', 'available', 'widespread'])
const RARE_WORDS = new Set(['rare', 'obscure', 'uncommon', 'unusual', 'scarce', 'exotic'])
const MIRROR_WORDS = new Set(['mirror', 'mirrored', 'handed', 'hand', 'hands', 'counterpart', 'opposite', 'reversed', 'reverse', 'flipped'])
const PRINTED_WORDS = new Set(['printed', 'print', 'patterned', 'decorated', 'sticker', 'stickered'])
const PLAIN_WORDS = new Set(['plain', 'unprinted', 'blank', 'undecorated', 'unpatterned', 'base', 'original'])
const BRIDGE_WORDS = new Set(['bridge', 'bridges', 'bridging', 'span', 'spans', 'spanning', 'gap'])
const INTERFACE_WORDS = new Set(['connections', 'connectors', 'interface', 'interchangeable', 'mates'])
const HORIZONTAL_WORDS = new Set(['sideways', 'horizontal', 'horizontally', 'lateral', 'laterally', 'sidewards'])
const VERTICAL_WORDS = new Set(['vertical', 'vertically', 'upright', 'upwards'])

/**
 * Normalises the raw request before tokenizing.
 *
 * "2 by 4", "two by four" and "2 x 4" are one request; "3-stud" is the same as
 * "3 stud". Hyphens inside a part number ("2651c01-f1") survive because they are
 * only split later, and only for tokens the catalog does not recognise.
 */
function preNormalize(text: string): string {
  let normalized = text
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[?!.,;:"'`()[\]]/g, ' ')
    .replace(/~/g, ' about ')
    .replace(/\s+/g, ' ')
  for (const [word, digits] of NUMBER_WORDS) {
    normalized = normalized.replace(new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, 'g'), `$1${digits}$2`)
  }
  return normalized
    .replace(/(\d)\s*by\s*(?=\d)/g, '$1x')
    .replace(/(\d)-(?=[a-z])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Matches `phrase` starting at `index`, returning its length or 0. */
function phraseAt(words: string[], index: number, phrase: string[]): number {
  if (index + phrase.length > words.length) return 0
  for (let offset = 0; offset < phrase.length; offset += 1) {
    if (words[index + offset] !== phrase[offset]) return 0
  }
  return phrase.length
}

function numberAt(words: string[], index: number): number | null {
  const word = words[index]
  if (word === undefined) return null
  return /^\d+(?:\.\d+)?$/.test(word) ? Number(word) : null
}

/** Lowercased colour names, longest first, so "trans clear" beats "clear". */
function colorPhrases(colors: readonly ColorDefinition[]): Array<{ words: string[]; code: number; name: string }> {
  return colors
    .map((color) => ({ words: color.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), code: color.code, name: color.name }))
    .filter((entry) => entry.words.length > 0)
    .sort((a, b) => b.words.length - a.words.length || a.code - b.code)
}

/**
 * Category words, so "windscreen" reaches "Windscreens and Fuselage".
 *
 * Only content words are indexed; "and", "or" and the like appear in half the
 * category names and would make every query match every facet.
 */
function categoryIndex(categories: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const category of categories) {
    for (const raw of category.toLowerCase().split(/[^a-z0-9]+/)) {
      const word = raw.replace(/s$/, '')
      if (!word || word.length < 3 || STOP_WORDS.has(word)) continue
      const bucket = index.get(word)
      if (bucket) bucket.push(category)
      else index.set(word, [category])
    }
  }
  return index
}

export function parseQuery(raw: string, context: QueryContext): PartQuery {
  const normalized = preNormalize(raw)
  const rawTokens = tokenize(normalized)
  const resolveIdentity = context.resolveIdentity ?? (() => null)

  const words: string[] = []
  const ids: string[] = []
  const idTokens: string[] = []
  const dimensionEnvelopes: number[][] = []
  const envelopePhrases: string[] = []

  for (let position = 0; position < rawTokens.length; position += 1) {
    const token = rawTokens[position]
    // A bare one- or two-digit number is a count in every phrasing except a
    // lookup that consists of nothing else, and LDraw really does have parts
    // numbered 1, 2 and 3 - so both readings stay available, decided by context.
    const looksLikeQuantity =
      /^\d+(?:\.\d+)?$/.test(token) &&
      (UNIT_WORDS.test(rawTokens[position + 1] ?? '') || (token.length < 3 && rawTokens.length > 1))
    const identity = looksLikeQuantity ? null : resolveIdentity(token)
    if (identity) {
      ids.push(identity)
      idTokens.push(token)
      continue
    }
    const envelope = parseDimensionToken(token)
    if (envelope) {
      dimensionEnvelopes.push(envelope)
      envelopePhrases.push(envelope.join(' x '))
      continue
    }
    // Only now is it safe to break a hyphenated token apart: it is not a part
    // number and not a dimension, so "trans-clear" is two ordinary words.
    for (const piece of token.split(/[-/]+/)) {
      if (piece) words.push(piece)
    }
  }

  const consumed = new Array<boolean>(words.length).fill(false)
  const consume = (start: number, length: number) => {
    for (let i = start; i < start + length && i < consumed.length; i += 1) consumed[i] = true
  }

  const phrases: DimensionPhrases = {
    envelope: envelopePhrases[0] ?? null,
    footprintExtent: null,
    heightPlates: null,
  }
  const dimensions: DimensionIntent = {
    envelope: dimensionEnvelopes[0] ?? null,
    footprintExtent: null,
    heightPlates: null,
    approximate: false,
    phrases,
    evidence: [],
  }
  const color: ColorIntent = { codes: [], names: [], finishes: [], evidence: [] }
  const connectorFamilies = new Set<ConnectionFamily>()
  const categories = new Set<string>()
  let availability: PartQuery['availability'] = 'any'
  let axisOrientation: AxisIntent | null = null
  let relation: RelationIntent | null = null

  const palette = colorPhrases(context.colors)
  const categoryWords = categoryIndex(context.categories)
  const colorCodes = new Set<number>()

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    // A word already spent on a measurement is not also a connector request:
    // "3-stud gap" asks about a distance, not about studs on the part.
    if (consumed[index]) continue

    if (APPROXIMATE_WORDS.has(word)) {
      dimensions.approximate = true
      consume(index, 1)
      continue
    }
    if (HORIZONTAL_WORDS.has(word)) {
      axisOrientation = 'horizontal'
      consume(index, 1)
      continue
    }
    if (VERTICAL_WORDS.has(word)) {
      axisOrientation = 'vertical'
      consume(index, 1)
      continue
    }

    // "six studs wide" / "3 stud gap" / "40 stud"
    const count = numberAt(words, index)
    if (count !== null) {
      const next = words[index + 1] ?? ''
      const after = words[index + 2] ?? ''
      if (/^studs?$/.test(next)) {
        if (BRIDGE_WORDS.has(after) || BRIDGE_WORDS.has(words[index - 1] ?? '')) {
          relation = { kind: 'bridge', gapStuds: count }
          consume(index, BRIDGE_WORDS.has(after) ? 3 : 2)
        } else {
          dimensions.footprintExtent = count
          phrases.footprintExtent = FOOTPRINT_AXIS_WORDS.has(after) ? `${count} studs ${after}` : `${count} studs`
          consume(index, FOOTPRINT_AXIS_WORDS.has(after) ? 3 : 2)
        }
        continue
      }
      if (/^plates?$/.test(next) && HEIGHT_AXIS_WORDS.has(after)) {
        dimensions.heightPlates = count
        phrases.heightPlates = `${count} plates ${after}`
        consume(index, 3)
        continue
      }
      if (/^bricks?$/.test(next) && HEIGHT_AXIS_WORDS.has(after)) {
        // One brick is exactly three plates; the envelope is published in plates.
        dimensions.heightPlates = count * 3
        phrases.heightPlates = `${count} bricks ${after}`
        consume(index, 3)
        continue
      }
      if (FOOTPRINT_AXIS_WORDS.has(next)) {
        dimensions.footprintExtent = count
        phrases.footprintExtent = `${count} ${next}`
        consume(index, 2)
        continue
      }
    }

    let matchedPhrase = false

    for (const entry of palette) {
      const length = phraseAt(words, index, entry.words)
      if (!length) continue
      colorCodes.add(entry.code)
      color.names.push(entry.name)
      color.evidence.push(entry.words.join(' '))
      consume(index, length)
      index += length - 1
      matchedPhrase = true
      break
    }
    if (matchedPhrase) continue

    for (const entry of FINISH_PHRASES) {
      const length = phraseAt(words, index, entry.words)
      if (!length) continue
      if (!color.finishes.includes(entry.finish)) color.finishes.push(entry.finish)
      for (const definition of context.colors) {
        if (finishMatches(definition, entry.finish)) colorCodes.add(definition.code)
      }
      color.evidence.push(entry.words.join(' '))
      consume(index, length)
      index += length - 1
      matchedPhrase = true
      break
    }
    if (matchedPhrase) continue

    for (const entry of CONNECTOR_PHRASES) {
      const length = phraseAt(words, index, entry.words)
      if (!length) continue
      for (const family of entry.families) connectorFamilies.add(family)
      // Connector words are also real catalog vocabulary ("Brick with Clip"),
      // so they stay available to lexical retrieval instead of being consumed.
      matchedPhrase = true
      index += length - 1
      break
    }
    if (matchedPhrase) continue

    if (COMMON_WORDS.has(word)) {
      availability = 'common'
      consume(index, 1)
      continue
    }
    if (RARE_WORDS.has(word)) {
      availability = 'rare'
      consume(index, 1)
      continue
    }

    const facets = categoryWords.get(word.replace(/s$/, ''))
    if (facets) for (const facet of facets) categories.add(facet)
  }

  dimensions.evidence = [phrases.envelope, phrases.footprintExtent, phrases.heightPlates].filter(
    (phrase): phrase is string => phrase !== null,
  )

  // Relations are read over the whole word list rather than one word at a time,
  // because they are statements about the sentence: "the mirrored counterpart of
  // wedge 41747" only means something once both the modifier and the id are in
  // hand. Every relation therefore needs a target, and a bare "printed" or
  // "plain" becomes a preference instead.
  const hasAny = (candidates: Set<string>) => words.some((word) => candidates.has(word))
  const wantsPlain = hasAny(PLAIN_WORDS)
  const wantsPrinted = hasAny(PRINTED_WORDS)
  if (!relation && ids.length) {
    if (hasAny(MIRROR_WORDS) || ((words.includes('left') || words.includes('right')) && words.includes('hand'))) {
      relation = { kind: 'mirrored', target: ids[0] }
    } else if (hasAny(INTERFACE_WORDS) || words.includes('connects')) {
      relation = { kind: 'interface', target: ids[0] }
    } else if (wantsPlain) {
      relation = { kind: 'base-variant', target: ids[0] }
    } else if (wantsPrinted) {
      relation = { kind: 'printed-variant', target: ids[0] }
    }
  }
  const variantPreference: PartQuery['variantPreference'] = wantsPrinted ? 'printed' : wantsPlain ? 'plain' : 'any'

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (
      MIRROR_WORDS.has(word) ||
      INTERFACE_WORDS.has(word) ||
      PLAIN_WORDS.has(word) ||
      PRINTED_WORDS.has(word) ||
      BRIDGE_WORDS.has(word)
    ) {
      consume(index, 1)
    }
  }

  color.codes = Array.from(colorCodes).sort((a, b) => a - b)

  const contentTerms: string[] = []
  const unmatchedTerms: string[] = []
  const knowsTerm = context.knowsTerm ?? (() => true)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (STOP_WORDS.has(word)) continue
    if (consumed[index]) continue
    if (contentTerms.includes(word)) continue
    contentTerms.push(word)
    // A word the catalog has never used is still worth trying against the
    // latent index - character trigrams reach "Steering" from "steers" - but it
    // is reported all the same, because an unrecognised term must never widen
    // the result set silently.
    if (!knowsTerm(word) && !unmatchedTerms.includes(word)) unmatchedTerms.push(word)
  }

  return {
    raw,
    words,
    contentTerms,
    ids,
    idTokens,
    dimensions,
    color,
    connectors: Array.from(connectorFamilies),
    axisOrientation,
    categories: Array.from(categories),
    relation,
    variantPreference,
    availability,
    unmatchedTerms,
  }
}
