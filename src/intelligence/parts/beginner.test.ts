import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalog } from '../../cad/catalog'
import { installDiskFetch, installRealCatalog, type DiskFetch } from './__fixtures__/real-catalog'
import { withinOneEdit } from './lexical'
import { parseQuery } from './query'
import { SIGNAL_PENALTIES, SIGNAL_WEIGHTS } from './rank'
import { resetPartIntelligence, residentPartIntelligence, resolvePartIntent, warmPartIntelligence } from './resolve'
import { resetSemanticIndex } from './semantic'
import type { PartIntentResult } from '../../platform/contracts'

/**
 * The search box a seven-year-old uses.
 *
 * Every other suite here asks whether the resolver is *correct*. This one asks
 * whether it is usable by somebody who does not know the catalog exists, which
 * is a different question with different failure modes: a child types "windo",
 * "roof bit", "flat piece" and "clear", not "Slope Brick 45 2 x 2", and each of
 * those used to return a confident answer to something else entirely - a
 * Windowscreen used by one part in the library, a Fabuland roof support, a
 * printed flag, a starched fabric cape.
 *
 * The queries below are the measured cases, and the assertion for each is the
 * thing that was wrong rather than the exact identity that is now first: pinning
 * a part number would test the catalog build, where naming the *kind* of part
 * tests the reading of the request. Latencies are printed for the record.
 *
 * Nothing here relaxes an honesty guarantee, and two of the tests exist to prove
 * that: a reinterpretation is stated rather than silent, and a word this build
 * has genuinely never seen still cannot be corrected into a match.
 */

let disk: DiskFetch
const results = new Map<string, PartIntentResult>()
const latencies = new Map<string, number>()

const QUERIES = [
  'red brick', 'windo', 'roof bit', 'flat piece', 'long thin one', 'wheel', 'door',
  '1x2', 'clear', 'sloped', 'brik', 'plaet', 'antena', 'wheal', 'big flat thing',
  'tiny brick', 'bendy bit', 'round thing', 'flat 1x2', 'four by two brick',
  'stick', 'green plate',
]

beforeAll(async () => {
  await installRealCatalog()
  disk = installDiskFetch()
  resetPartIntelligence()
  resetSemanticIndex()
  await warmPartIntelligence()
  await resolvePartIntent('warm up', { limit: 3 })
  for (const query of QUERIES) {
    const started = performance.now()
    results.set(query, await resolvePartIntent(query, { limit: 5 }))
    latencies.set(query, performance.now() - started)
  }
}, 180_000)

afterAll(() => disk.restore())

const top = (query: string) => results.get(query)!.matches[0]
const nameOf = (id: string) => catalog.describe(id)?.name ?? id
const topName = (query: string) => nameOf(top(query).canonicalId)
const names = (query: string) => results.get(query)!.matches.map((match) => nameOf(match.canonicalId))

describe('a beginner\'s vocabulary', () => {
  it('reads a colloquial shape word as the catalog\'s own', () => {
    // "roof" names 73 LDraw parts, every one of them a Fabuland roof support, a
    // train battery cover or a vehicle-roof hinge. The sloped brick a child
    // means is filed under "Slope"/"Sloped", and used to be unreachable.
    expect(topName('roof bit')).toMatch(/Slope/i)
    // "flat" appears only as a modifier - "Flat Front", "Flat Back" - so a flat
    // piece used to answer with a printed flag and a window front.
    expect(topName('flat piece')).toMatch(/^(Plate|Tile)\b/)
    expect(topName('flat 1x2')).toMatch(/^(Plate|Tile)\b/)
    // "bendy" appears in no catalog name at all; before the reading table it
    // was a dead word that returned printed minifigure torsos.
    expect(names('bendy bit').some((name) => /Flexible|Hose/i.test(name))).toBe(true)
    expect(names('stick').some((name) => /^Bar\b/.test(name))).toBe(true)
  })

  it('says which word it read, instead of quietly substituting one', () => {
    const query = parseQuery('roof bit', {
      colors: catalog.colors(),
      categories: catalog.categories,
      readTerm: (term) => residentPartIntelligence()!.lexical.interpret(term),
    })
    expect(query.readings).toEqual([{ typed: 'roof', reads: ['sloped', 'slope'] }])
    expect(top('roof bit').explanation).toContain('read "roof" as sloped')
    // And it is not reported as a condition that could not be met, because it
    // was met - by a word the catalog spells differently.
    expect(results.get('roof bit')!.interpretation.unmatchedTerms).not.toContain('roof')
  })

  it('drops the filler a beginner uses instead of a shape word', () => {
    // "one" is the only number word that is also the commonest English pronoun.
    // Folded to a digit everywhere, "the long thin one" became a search that
    // included LDraw part 1, the Homemaker Drawer.
    const context = { colors: catalog.colors(), categories: catalog.categories }
    expect(parseQuery('long thin one', context).contentTerms).toEqual(['long', 'thin'])
    expect(parseQuery('roof bit', context).contentTerms).toEqual(['roof'])
    // The measurement readings have to survive, or "one stud wide" breaks.
    expect(parseQuery('one by two brick', context).dimensions.envelope).toEqual([1, 2])
    expect(parseQuery('two by one brick', context).dimensions.envelope).toEqual([2, 1])
    expect(parseQuery('one stud wide', context).dimensions.footprintExtent).toBe(1)
    expect(parseQuery('a 1 x 2 plate', context).dimensions.envelope).toEqual([1, 2])
  })
})

describe('a misspelling', () => {
  it('answers the word that was meant, at a confidence that says so', () => {
    // Character trigrams in the latent index already found these parts; what
    // they could not do was tell the ranker that the request had been
    // understood, so "brik" answered Brick 2 x 4 at 6% confidence and reported
    // its own query word as a condition it could not meet.
    expect(top('brik').canonicalId).toBe('3001')
    expect(top('brik').confidence).toBeGreaterThan(0.25)
    expect(topName('plaet')).toMatch(/^Plate\b/)
    expect(topName('antena')).toMatch(/^Antenna\b/)
    expect(topName('wheal')).toMatch(/^Wheel\b/)
    for (const query of ['brik', 'plaet', 'antena', 'wheal']) {
      expect(results.get(query)!.interpretation.unmatchedTerms, query).not.toContain(query)
      expect(top(query).explanation, query).toContain(`read "${query}" as`)
    }
  })

  it('cannot manufacture a reading for a word that is not one', () => {
    // The honesty guarantee this whole module is built on. A correction is only
    // ever allowed to land on a word the catalog actually leans on, so an
    // invented word stays invented and stays reported.
    const lexical = residentPartIntelligence()!.lexical
    for (const invented of ['flurbulator', 'zorbulon', 'snorklewhacker', 'antigravity']) {
      expect(lexical.correctTerm(invented), invented).toBeNull()
      expect(lexical.interpret(invented), invented).toBeNull()
    }
    // Nor for a word too short to have a distinguishable neighbourhood: at
    // three characters, edit distance one is most of the dictionary.
    expect(lexical.correctTerm('bik')).toBeNull()
  })

  it('measures distance one the way a typo actually happens', () => {
    expect(withinOneEdit('brick', 'brick')).toBe(true)
    expect(withinOneEdit('brik', 'brick')).toBe(true) // omission
    expect(withinOneEdit('bricck', 'brick')).toBe(true) // doubled key
    expect(withinOneEdit('brack', 'brick')).toBe(true) // wrong key
    expect(withinOneEdit('plaet', 'plate')).toBe(true) // transposition
    expect(withinOneEdit('paelt', 'plate')).toBe(false) // two transpositions
    expect(withinOneEdit('brk', 'brick')).toBe(false) // two omissions
    expect(withinOneEdit('slope', 'sloped')).toBe(true)
  })
})

describe('a partly typed word', () => {
  it('reads the commonest continuation, not the rarest', () => {
    // Plain IDF rewards rarity, so "windo" reaching "windowscreen" - one part
    // in the whole library - scored nearly three times what reaching "window"
    // scored, and that single part outranked every window. Same shape for
    // "wheel" reaching "wheelchair" and "hand" reaching "handbag".
    expect(topName('windo')).toMatch(/^Window\b/)
    expect(topName('wheel')).toMatch(/^Wheel\b/)
    expect(topName('sloped')).toMatch(/Slope/i)
  })

  it('counts one query word once, however many ways it can be read', () => {
    const lexical = residentPartIntelligence()!.lexical
    const corpus = residentPartIntelligence()!.corpus
    const ranked = lexical.search(['wheel'], 40).hits.map((hit) => corpus.documents[hit.doc].name)
    // 24312 is "Equipment Medical Wheelchair with Clips for Wheels": it carries
    // both "wheelchair" and "wheels", and summing the two readings of one word
    // is what used to put it above every part actually named Wheel.
    const wheelchair = ranked.findIndex((name) => /Wheelchair/i.test(name))
    const wheel = ranked.findIndex((name) => /^Wheel\b/.test(name))
    expect(wheel).toBeGreaterThanOrEqual(0)
    expect(wheelchair === -1 || wheel < wheelchair).toBe(true)
  })
})

describe('a colour on its own', () => {
  it('is a question with an answer', () => {
    // A colour word carries no information about shape, so the latent index
    // answered "clear" with the parts whose *names* look most like the word: a
    // Ninjago bandana, a starched fabric cape, a set of minifigure air tanks.
    const result = results.get('clear')!
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.interpretation.colorName).toBe('transparent')
    expect(result.interpretation.unmatchedTerms).not.toContain('clear')

    const transparent = new Set(catalog.colors().filter((color) => color.alpha < 1).map((color) => color.code))
    for (const match of result.matches) {
      // Every answer is a part this build has *observed* in a see-through
      // colour, which is the only claim it is entitled to make.
      const definition = catalog.get(match.canonicalId)
      expect(definition, match.canonicalId).toBeDefined()
      expect(
        definition!.availableColors.some((code) => transparent.has(code)),
        `${match.canonicalId} ${nameOf(match.canonicalId)}`,
      ).toBe(true)
    }
  })

  it('still filters rather than decides when the request also names a shape', () => {
    expect(topName('red brick')).toMatch(/^Brick\b/)
    expect(topName('green plate')).toMatch(/^Plate\b/)
    // With a shape named, the latent index has something to work on and does.
    expect(results.get('red brick')!.matches.some((match) => match.signals.semantic > 0)).toBe(true)
  })
})

describe('a size word with no scale behind it', () => {
  it('is reported instead of retrieved', () => {
    // LDraw uses "big" in 19 names, all printed torsos and one curly wig, and
    // "giant" in 15, all wheel diameters. Left in the retrieval terms, "big
    // flat thing" answered with a Bionicle armour plate.
    expect(topName('big flat thing')).toMatch(/^(Plate|Tile)\b/)
    expect(results.get('big flat thing')!.interpretation.unmatchedTerms).toContain('big')
    expect(topName('tiny brick')).toMatch(/^Brick\b/)
    expect(results.get('tiny brick')!.interpretation.unmatchedTerms).toContain('tiny')
  })

  it('never lets a half-met size constraint pay better than none', () => {
    // The dimensional reward and the wrong-size penalty are charged against the
    // same denominator, so if the penalty is the smaller of the two, a request
    // that names one satisfiable and one impossible size nets a bonus for
    // having asked the impossible half.
    expect(SIGNAL_PENALTIES.wrongSize).toBeGreaterThan(SIGNAL_WEIGHTS.dimensional)
  })
})

describe('what it costs', () => {
  it('leaves no beginner request without an answer', () => {
    // Latencies are printed rather than asserted. The gate that measures this
    // resolver's speed is the 200-request percentile sweep in resolve.test.ts,
    // and a second wall-clock bound here would only add a check that goes red
    // when the machine is busy - which is a fact about the machine. The cost
    // claims worth protecting are structural, and they are the two that follow.
    console.log(
      `\nbeginner queries, warm:\n` +
        [...latencies.keys()]
          .map((query) => `  ${query.padEnd(20)} ${latencies.get(query)!.toFixed(1).padStart(6)} ms  ${topName(query)}`)
          .join('\n'),
    )
    for (const query of QUERIES) {
      expect(results.get(query)!.matches.length, query).toBeGreaterThan(0)
    }
  })

  it('is never handed to the latent index on its own', () => {
    // The same rule the footprint stage already follows: a colour is a filter on
    // the answer, not a source of answers. Folded into the latent query with no
    // shape beside it, "clear" retrieves the parts whose names read most like
    // the word, which is how the fabric cape got in - and it costs a full scan
    // of 22,941 vectors to produce it.
    for (const match of results.get('clear')!.matches) {
      expect(match.signals.semantic, `${match.canonicalId} ${nameOf(match.canonicalId)}`).toBe(0)
    }
    for (const match of results.get('1x2')!.matches) {
      expect(match.signals.semantic, match.canonicalId).toBe(0)
    }
  })

  it('only ever corrects onto vocabulary the catalog leans on', () => {
    // "wheelchair" is a real LDraw word used by exactly one part, and
    // "wheelchaif" is one edit from it. Correcting to a word that rare would be
    // a guess dressed as a reading - the next typo lands on a term used once
    // and the answer is unexplainable - so the correction refuses instead.
    const lexical = residentPartIntelligence()!.lexical
    expect(lexical.hasTerm('wheelchair')).toBe(true)
    expect(lexical.correctTerm('wheelchaif')).toBeNull()
    // The floor is a usage floor, not a length one: "antenna" is used by 18
    // parts, which is well inside it.
    expect(lexical.correctTerm('antena')).toBe('antenna')
  })
})
