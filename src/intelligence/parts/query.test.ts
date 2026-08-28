import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalog } from '../../cad/catalog'
import { installRealCatalog } from './__fixtures__/real-catalog'
import { parseQuery, type QueryContext } from './query'

/**
 * The parser's job is to make its reading of a request inspectable. These tests
 * are written against the readings a builder would recognise as correct, and in
 * particular against the ones that used to be silently wrong: a bare number
 * being taken for a part id, a colour word disappearing, a word nobody
 * recognises quietly widening the search.
 */

let context: QueryContext

beforeAll(async () => {
  await installRealCatalog()
  context = {
    colors: catalog.colors(),
    categories: catalog.categories,
    resolveIdentity: (token) => catalog.describe(token)?.id ?? null,
    knowsTerm: (term) => ['brick', 'plate', 'tile', 'gear', 'windscreen', 'hinge', 'clip', 'bar', 'wedge'].includes(term),
  }
})

afterAll(() => undefined)

const parse = (text: string) => parseQuery(text, context)

describe('dimensions', () => {
  it('reads a footprint however it is spelled', () => {
    expect(parse('brick 2 x 4').dimensions.envelope).toEqual([2, 4])
    expect(parse('brick 2x4').dimensions.envelope).toEqual([2, 4])
    expect(parse('brick 2 by 4').dimensions.envelope).toEqual([2, 4])
    expect(parse('two by four brick').dimensions.envelope).toEqual([2, 4])
  })

  it('reads a three-number envelope, keeping the height in brick units', () => {
    expect(parse('a 1 x 2 x 5 brick').dimensions.envelope).toEqual([1, 2, 5])
  })

  it('reads a single extent and remembers the phrase that stated it', () => {
    const query = parse('a windscreen about six studs wide')
    expect(query.dimensions.footprintExtent).toBe(6)
    expect(query.dimensions.approximate).toBe(true)
    expect(query.dimensions.phrases.footprintExtent).toBe('6 studs wide')
  })

  it('converts a height given in bricks to plates', () => {
    expect(parse('a brick two bricks tall').dimensions.heightPlates).toBe(6)
    expect(parse('a plate three plates high').dimensions.heightPlates).toBe(3)
  })

  it('handles compound number words', () => {
    expect(parse('a sixteen by thirty two baseplate').dimensions.envelope).toEqual([16, 32])
  })

  it('does not mistake a counted quantity for a part number', () => {
    // LDraw part 3 is the Homemaker Drawer; "3 studs" is a distance.
    const query = parse('a plate that bridges a 3 stud gap')
    expect(query.ids).toEqual([])
    expect(query.relation).toEqual({ kind: 'bridge', gapStuds: 3 })
  })

  it('still resolves a short number when that is the whole request', () => {
    expect(parse('3').ids).toEqual(['3'])
  })
})

describe('colour and finish', () => {
  it('maps a named colour to its LDraw code', () => {
    const query = parse('a trans clear 1 x 1 plate')
    expect(query.color.names).toContain('Trans Clear')
    expect(query.color.codes.length).toBeGreaterThan(0)
  })

  it('maps a finish word to every colour that has that finish', () => {
    const transparent = parse('a transparent brick').color
    expect(transparent.finishes).toEqual(['transparent'])
    expect(transparent.codes.every((code) => catalog.color(code).alpha < 1)).toBe(true)

    const chrome = parse('a chrome sword').color
    expect(chrome.finishes).toEqual(['chrome'])
    expect(chrome.codes.every((code) => catalog.color(code).finish === 'chrome')).toBe(true)

    expect(parse('glow in the dark plate').color.finishes).toEqual(['glow'])
    expect(parse('pearl gold tile').color.finishes.length + parse('pearl gold tile').color.names.length).toBeGreaterThan(0)
  })
})

describe('connectors', () => {
  it('prefers the longer reading of a connector phrase', () => {
    expect(parse('a brick with a pin hole').connectors).toEqual(['pin-hole'])
    expect(parse('a technic pin').connectors).toEqual(['pin'])
    expect(parse('an axle hole').connectors).toEqual(['axle-hole'])
  })

  it('reads a negation as an exclusion, not a request', () => {
    const query = parse('a piece with an anti stud underneath and no stud on top')
    expect(query.connectors).toContain('anti-stud')
    expect(query.connectors).not.toContain('stud')
    expect(query.excludedConnectors).toContain('stud')
  })

  it('reads an axis direction', () => {
    expect(parse('a hinge whose axis points sideways').axisOrientation).toBe('horizontal')
    expect(parse('an upright hinge').axisOrientation).toBe('vertical')
    expect(parse('a hinge').axisOrientation).toBeNull()
  })
})

describe('relations', () => {
  it('reads a mirror request only when it names a part', () => {
    expect(parse('the mirrored counterpart of 41747').relation).toEqual({ kind: 'mirrored', target: '41747' })
    expect(parse('the other hand of 29119').relation).toEqual({ kind: 'mirrored', target: '29119' })
    expect(parse('a mirrored wedge').relation).toBeNull()
  })

  it('reads an interface request', () => {
    expect(parse('same connections as 3068b').relation).toEqual({ kind: 'interface', target: '3068b' })
  })

  it('reads variant direction, and keeps a bare modifier as a preference', () => {
    expect(parse('a plain unprinted version of 3069bp73').relation).toEqual({
      kind: 'base-variant',
      target: '3069bp73',
    })
    const bare = parse('a printed tile')
    expect(bare.relation).toBeNull()
    expect(bare.variantPreference).toBe('printed')
    // "sticker" is ordinary LDraw vocabulary, so it stays available to search.
    expect(parse('sticker sheet').contentTerms).toContain('sticker')
  })

  it('reads availability', () => {
    expect(parse('something cheaper and more common with the same connections as 3068b').availability).toBe('common')
    expect(parse('a rare tile').availability).toBe('rare')
  })
})

describe('unmatched terms', () => {
  it('reports a word the catalog has never used', () => {
    const query = parse('a flurbulator brick')
    expect(query.unmatchedTerms).toEqual(['flurbulator'])
    // It still reaches retrieval: the latent index is the thing that can cope
    // with a word this build has never indexed.
    expect(query.contentTerms).toContain('flurbulator')
  })

  it('reports nothing when every word is catalog vocabulary', () => {
    expect(parse('a brick with a clip').unmatchedTerms).toEqual([])
  })
})
