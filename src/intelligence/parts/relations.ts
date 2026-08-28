import { STUD_LDU } from '../../cad/catalog'
import type { ConnectorProfile, CorpusDocument, PartCorpus } from './corpus'

/**
 * Relationships the catalog implies but never states.
 *
 * None of these are authored anywhere: LDraw records that 41747 is "Brick
 * Wedged, Curved 6 x 2 Right, Inner Ridges" and that 41748 is the same name
 * with "Left", and it is left to the reader to notice they are the same part in
 * two hands. The same is true of printed variants, of parts that mate with the
 * same things, and of which plate is long enough to reach across a hole. All
 * four are derived here from measurements and naming conventions, and each is
 * checked against geometry wherever geometry exists, so a coincidence of
 * wording cannot pass as a fact.
 */

export interface MirrorRelation {
  id: string
  /** How the pairing was established, so an explanation can be specific. */
  evidence: 'geometry' | 'envelope' | 'name'
  /** True when the two numbers are consecutive, as LDraw usually mints them. */
  consecutiveIds: boolean
}

export interface InterfaceMatch {
  id: string
  /** 1 means identical connector multisets; the threshold for "compatible" is 0.75. */
  similarity: number
}

export interface BridgeCandidate {
  id: string
  /** Footprint studs along the spanning axis. */
  spanStuds: number
  /** Measured distance between the outermost opposing anti-studs, in studs. */
  antiStudSeparation: number | null
}

/** Below this the two parts do not mate with the same things in the same way. */
const INTERFACE_THRESHOLD = 0.75

/**
 * LDraw's decoration suffixes.
 *
 * `p` is a printed pattern and `d` a sticker; both are appended to the number
 * of the part being decorated, which is what makes "3069bp73 decorates 3069b"
 * recoverable without a variant table. The suffix body is short by convention,
 * and the base is only accepted when the catalog actually contains it, so a
 * part that merely happens to end in a `p` is not mistaken for a variant.
 */
const DECORATION_SUFFIX = /^(.+?)(?:p|d|ps|pr|pb)[0-9a-z]{1,4}$/

const LEFT_WORD = /(^|[^a-z])left([^a-z]|$)/
const RIGHT_WORD = /(^|[^a-z])right([^a-z]|$)/
const HANDEDNESS_GLOBAL = /(^|[^a-z])(left|right)([^a-z]|$)/g

/** Name with its handedness removed, so the two hands share one key. */
function handKey(document: CorpusDocument): string | null {
  const name = document.name.toLowerCase()
  if (!LEFT_WORD.test(name) && !RIGHT_WORD.test(name)) return null
  const stripped = name.replace(HANDEDNESS_GLOBAL, '$1hand$3').replace(/\s+/g, ' ').trim()
  return `${document.category} ${stripped}`
}

function hand(document: CorpusDocument): 'left' | 'right' | null {
  const name = document.name.toLowerCase()
  const left = LEFT_WORD.test(name)
  const right = RIGHT_WORD.test(name)
  // A name that says both is describing two features, not one handed part.
  if (left === right) return null
  return left ? 'left' : 'right'
}

const close = (a: number, b: number, tolerance = 0.06) => Math.abs(a - b) <= tolerance

/**
 * True when one part's measured box is the other's reflected through x.
 *
 * LDraw mirrors handed parts across the x axis, so the reflected box has its x
 * extremes swapped and negated while y and z are untouched. Checking this is
 * what separates a real counterpart from two unrelated parts whose names happen
 * to differ by one word.
 */
function mirroredBounds(a: CorpusDocument, b: CorpusDocument): boolean {
  if (!a.boundsLdu || !b.boundsLdu) return false
  const tolerance = 0.5
  return (
    close(a.boundsLdu.min[0], -b.boundsLdu.max[0], tolerance) &&
    close(a.boundsLdu.max[0], -b.boundsLdu.min[0], tolerance) &&
    close(a.boundsLdu.min[1], b.boundsLdu.min[1], tolerance) &&
    close(a.boundsLdu.max[1], b.boundsLdu.max[1], tolerance) &&
    close(a.boundsLdu.min[2], b.boundsLdu.min[2], tolerance) &&
    close(a.boundsLdu.max[2], b.boundsLdu.max[2], tolerance)
  )
}

function sameEnvelope(a: CorpusDocument, b: CorpusDocument): boolean {
  if (!a.studs || !b.studs) return false
  return close(a.studs[0], b.studs[0]) && close(a.studs[1], b.studs[1]) && close(a.studs[2], b.studs[2])
}

/** Numeric prefix of a part number, for the consecutive-id convention. */
function numericPrefix(id: string): number | null {
  const match = /^(\d+)/.exec(id)
  return match ? Number(match[1]) : null
}

/**
 * How alike two mating interfaces are.
 *
 * Compared as multisets of family and gender: a part with eight studs and eight
 * anti-studs connects to the world in a way a part with four of each does not,
 * so counts matter and a plain set intersection would call a 2 x 2 plate
 * interchangeable with a 2 x 4. The measure is the multiset Jaccard, which is 1
 * for identical interfaces and degrades in proportion to the counts that differ.
 */
export function connectorSimilarity(a: ConnectorProfile, b: ConnectorProfile): number {
  if (a.size === 0 && b.size === 0) return 0
  let shared = 0
  let union = 0
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(key) ?? 0
    const right = b.get(key) ?? 0
    shared += Math.min(left, right)
    union += Math.max(left, right)
  }
  return union === 0 ? 0 : shared / union
}

/** Geometry beats an envelope match, which beats a name match; ties go to consecutive numbers. */
function rankMirror(relation: MirrorRelation, document: CorpusDocument): number {
  const evidence = relation.evidence === 'geometry' ? 4 : relation.evidence === 'envelope' ? 2 : 0
  return evidence + (relation.consecutiveIds ? 1 : 0) + Math.min(document.frequency, 1000) / 100000
}

/** Longest footprint axis in studs, measured where possible and read off the name otherwise. */
export function footprintSpan(document: CorpusDocument): number | null {
  if (document.studs) return Math.max(document.studs[0], document.studs[2])
  if (document.nameStuds) return Math.max(...document.nameStuds.slice(0, 2))
  return null
}

/** Distance between the outermost anti-studs in studs, or null when uncompiled. */
export function antiStudSeparation(document: CorpusDocument): number | null {
  const positions = document.antiStudsLdu
  if (!positions || positions.length < 2) return null
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const position of positions) {
    minX = Math.min(minX, position[0])
    maxX = Math.max(maxX, position[0])
    minZ = Math.min(minZ, position[2])
    maxZ = Math.max(maxZ, position[2])
  }
  return Math.max(maxX - minX, maxZ - minZ) / STUD_LDU
}

export class RelationIndex {
  private constructor(
    private readonly corpus: PartCorpus,
    private readonly mirrors: Map<string, MirrorRelation>,
    private readonly variantBase: Map<string, string>,
    private readonly variantsByBase: Map<string, string[]>,
  ) {}

  static build(corpus: PartCorpus): RelationIndex {
    const mirrors = new Map<string, MirrorRelation>()
    const groups = new Map<string, CorpusDocument[]>()
    for (const document of corpus.documents) {
      const key = handKey(document)
      if (!key || !hand(document)) continue
      const bucket = groups.get(key)
      if (bucket) bucket.push(document)
      else groups.set(key, [document])
    }

    for (const bucket of groups.values()) {
      const lefts = bucket.filter((document) => hand(document) === 'left')
      const rights = bucket.filter((document) => hand(document) === 'right')
      if (!lefts.length || !rights.length) continue
      for (const source of bucket) {
        const candidates = hand(source) === 'left' ? rights : lefts
        let best: { document: CorpusDocument; relation: MirrorRelation } | null = null
        for (const candidate of candidates) {
          const sourceNumber = numericPrefix(source.id)
          const candidateNumber = numericPrefix(candidate.id)
          const consecutiveIds =
            sourceNumber !== null && candidateNumber !== null && Math.abs(sourceNumber - candidateNumber) === 1
          const evidence: MirrorRelation['evidence'] = mirroredBounds(source, candidate)
            ? 'geometry'
            : sameEnvelope(source, candidate)
              ? 'envelope'
              : 'name'
          const relation: MirrorRelation = { id: candidate.id, evidence, consecutiveIds }
          if (!best || rankMirror(relation, candidate) > rankMirror(best.relation, best.document)) {
            best = { document: candidate, relation }
          }
        }
        if (best) mirrors.set(source.id, best.relation)
      }
    }

    const variantBase = new Map<string, string>()
    const variantsByBase = new Map<string, string[]>()
    for (const document of corpus.documents) {
      let base = document.variantOf && corpus.byId.has(document.variantOf) ? document.variantOf : null
      if (!base) {
        const derived = DECORATION_SUFFIX.exec(document.id)?.[1]
        if (derived && derived !== document.id && corpus.byId.has(derived)) base = derived
      }
      if (!base || base === document.id) continue
      variantBase.set(document.id, base)
      const bucket = variantsByBase.get(base)
      if (bucket) bucket.push(document.id)
      else variantsByBase.set(base, [document.id])
    }
    for (const bucket of variantsByBase.values()) {
      bucket.sort(
        (a, b) => (corpus.byId.get(b)?.frequency ?? 0) - (corpus.byId.get(a)?.frequency ?? 0) || (a < b ? -1 : 1),
      )
    }

    return new RelationIndex(corpus, mirrors, variantBase, variantsByBase)
  }

  get mirrorCount(): number {
    return this.mirrors.size
  }

  get variantCount(): number {
    return this.variantBase.size
  }

  /** The same part in the other hand, or null when the catalog records none. */
  mirrorOf(id: string): MirrorRelation | null {
    return this.mirrors.get(id) ?? null
  }

  /** The plain design a printed or stickered identity decorates. */
  baseOf(id: string): string | null {
    return this.variantBase.get(id) ?? null
  }

  /** Decorated identities that share this base design, most common first. */
  variantsOf(id: string): readonly string[] {
    return this.variantsByBase.get(id) ?? []
  }

  /**
   * Parts whose mating interface matches `id`'s within tolerance.
   *
   * Only the compiled pack has connectors, so this deliberately answers over
   * 900 parts rather than 23,000: claiming interface compatibility for a part
   * whose connectors were never compiled would be a guess dressed as a fact.
   */
  interfaceCompatible(id: string, limit = 24): InterfaceMatch[] {
    const source = this.corpus.byId.get(id)
    if (!source?.connectors || source.connectors.size === 0) return []
    const matches: InterfaceMatch[] = []
    for (const document of this.corpus.documents) {
      if (document.id === id || !document.connectors || document.connectors.size === 0) continue
      const similarity = connectorSimilarity(source.connectors, document.connectors)
      if (similarity >= INTERFACE_THRESHOLD) matches.push({ id: document.id, similarity })
    }
    matches.sort(
      (a, b) =>
        b.similarity - a.similarity ||
        (this.corpus.byId.get(b.id)?.frequency ?? 0) - (this.corpus.byId.get(a.id)?.frequency ?? 0) ||
        (a.id < b.id ? -1 : 1),
    )
    return matches.slice(0, limit)
  }

  /**
   * Parts long enough to reach across a hole of `gapStuds` studs.
   *
   * The arithmetic is the builder's, not an abstraction: a part bridging three
   * empty studs has to land on at least one stud on each side, so it needs a
   * footprint of gap + 2 and its outermost opposing anti-studs have to be at
   * least gap + 1 apart. Measured anti-stud positions decide it where the part
   * was compiled; where it was not, the footprint alone decides and the
   * separation is reported as unknown rather than invented.
   */
  gapBridging(gapStuds: number, limit = 40): BridgeCandidate[] {
    if (!Number.isFinite(gapStuds) || gapStuds < 1) return []
    const minimumSpan = gapStuds + 2
    const candidates: BridgeCandidate[] = []
    for (const document of this.corpus.documents) {
      if (document.helper) continue
      const span = footprintSpan(document)
      if (span === null || span < minimumSpan) continue
      const separation = antiStudSeparation(document)
      if (separation !== null && separation < gapStuds + 1) continue
      // With no compiled connectors the only evidence that the part can grip
      // both landings is the catalog's own connector-family list.
      if (separation === null && !document.families.includes('anti-stud')) continue
      candidates.push({ id: document.id, spanStuds: span, antiStudSeparation: separation })
    }
    // Ordered by real-world usage rather than by tightest fit. Every candidate
    // here already reaches, and a builder asking what bridges a gap wants the
    // plate they have in the drawer, not the most exactly-sized one in LDraw.
    candidates.sort(
      (a, b) =>
        (this.corpus.byId.get(b.id)?.frequency ?? 0) - (this.corpus.byId.get(a.id)?.frequency ?? 0) ||
        a.spanStuds - b.spanStuds ||
        (a.id < b.id ? -1 : 1),
    )
    return candidates.slice(0, limit)
  }
}
