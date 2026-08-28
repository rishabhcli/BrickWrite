import { describe, expect, it } from 'vitest'
import { IDENTITY_BASIS } from '../../cad/math'
import type { ConnectionEdge, ModelDocument, PartInstance } from '../../cad/types'
import {
  applyVisibility,
  connectedComponent,
  describeVisibility,
  hiddenPartIds,
  resolveSavedSelection,
  resolveSelection,
  SELECTION_MODES,
  visibilityActive,
} from './selection'

const part = (id: string, overrides: Partial<PartInstance> = {}): PartInstance => ({
  id,
  definitionId: '3001',
  color: 4,
  transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
  ...overrides,
})

const edge = (a: string, b: string): ConnectionEdge => ({
  id: `edge_${a}_${b}`,
  a: { partId: a, featureId: 'f1' },
  b: { partId: b, featureId: 'f2' },
  family: 'stud',
  joint: { kind: 'fixed' },
  createdAtRevision: 1,
  source: 'snap',
})

/**
 * A model made of two islands: red/blue/green in `hull`, and a detached yellow
 * pair in `deck`. Everything below reads only from evidence the document holds.
 */
const document: ModelDocument = {
  schemaVersion: 2,
  id: 'doc',
  name: 'Fixture',
  revision: 7,
  catalogVersion: 'fixture-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  parts: {
    red: part('red', { color: 4 }),
    blue: part('blue', { color: 1 }),
    green: part('green', { color: 2, definitionId: '3005' }),
    yellowA: part('yellowA', { color: 14, subassemblyId: 'deck' }),
    yellowB: part('yellowB', { color: 14, subassemblyId: 'deck', definitionId: '3005' }),
  },
  connections: {
    e1: edge('red', 'blue'),
    e2: edge('blue', 'green'),
    e3: edge('yellowA', 'yellowB'),
  },
  subassemblies: {
    hull: { id: 'hull', name: 'Hull', partIds: ['red', 'blue', 'green'], locked: false, accent: '#e79032' },
    deck: { id: 'deck', name: 'Deck', partIds: ['yellowA', 'yellowB'], locked: false, accent: '#83e7ee' },
  },
  steps: [{ id: 'step_1', index: 1, name: 'Everything', partIds: ['red', 'blue', 'green', 'yellowA', 'yellowB'] }],
  notes: [],
  constraints: [],
}

const context = (selection: string[], hidden: string[] = []) => ({
  document,
  selection,
  hidden: new Set(hidden),
})

describe('selection modes', () => {
  it('publishes the six documented modes plus inverse', () => {
    expect(SELECTION_MODES.map((mode) => mode.id)).toEqual([
      'part', 'colour', 'connected', 'subassembly', 'definition', 'visible', 'inverse',
    ])
  })

  it('selects by colour', () => {
    expect(resolveSelection('colour', context(['yellowA'])).sort()).toEqual(['yellowA', 'yellowB'])
  })

  it('walks the connection graph to the whole rigid island', () => {
    expect(resolveSelection('connected', context(['red'])).sort()).toEqual(['blue', 'green', 'red'])
  })

  it('does not cross into a disconnected island', () => {
    expect(resolveSelection('connected', context(['red']))).not.toContain('yellowA')
  })

  it('selects the whole subassembly', () => {
    expect(resolveSelection('subassembly', context(['yellowB'])).sort()).toEqual(['yellowA', 'yellowB'])
  })

  it('selects every instance of the same part number', () => {
    expect(resolveSelection('definition', context(['green'])).sort()).toEqual(['green', 'yellowB'])
  })

  it('inverts against the whole document', () => {
    expect(resolveSelection('inverse', context(['red', 'blue'])).sort()).toEqual(['green', 'yellowA', 'yellowB'])
  })

  it('selects only what is currently drawn', () => {
    expect(resolveSelection('visible', context([], ['red', 'blue'])).sort()).toEqual(['green', 'yellowA', 'yellowB'])
  })

  it('never silently clears the selection when a mode has no seed', () => {
    expect(resolveSelection('colour', context([]))).toEqual([])
    expect(resolveSelection('connected', context(['red', 'nonexistent'])).sort()).toEqual(['blue', 'green', 'red'])
  })

  it('ignores ids the document no longer holds', () => {
    expect(connectedComponent(document, ['gone'])).toEqual([])
  })
})

describe('saved selection sets', () => {
  it('reports how much of a stale set survives instead of quietly shrinking', () => {
    const saved = { id: 's1', name: 'Hull', partIds: ['red', 'blue', 'deleted'], revision: 3 }
    expect(resolveSavedSelection(document, saved)).toEqual({ present: ['red', 'blue'], missing: 1 })
  })
})

describe('visibility', () => {
  it('treats isolation as hiding everything else', () => {
    const hidden = hiddenPartIds(document, { hidden: new Set(), isolated: new Set(['red']), ghosted: new Set() })
    expect([...hidden].sort()).toEqual(['blue', 'green', 'yellowA', 'yellowB'])
  })

  it('combines explicit hides with isolation', () => {
    const hidden = hiddenPartIds(document, { hidden: new Set(['blue']), isolated: null, ghosted: new Set() })
    expect([...hidden]).toEqual(['blue'])
  })

  it('removes hidden parts from the rendered document without touching the stored one', () => {
    const rendered = applyVisibility(document, new Set(['red']))
    expect(Object.keys(rendered.parts).sort()).toEqual(['blue', 'green', 'yellowA', 'yellowB'])
    expect(Object.keys(document.parts)).toHaveLength(5)
    expect(rendered.revision).toBe(document.revision)
  })

  it('returns the same object when nothing is hidden, so the renderer does not rebuild', () => {
    expect(applyVisibility(document, new Set())).toBe(document)
  })

  it('says what visibility is currently doing', () => {
    expect(describeVisibility({ hidden: new Set(), isolated: new Set(['red']), ghosted: new Set() }, 5))
      .toBe('Isolated 1 of 5 parts')
    expect(describeVisibility({ hidden: new Set(['red', 'blue']), isolated: null, ghosted: new Set() }, 5))
      .toBe('2 parts hidden')
    expect(describeVisibility({ hidden: new Set(), isolated: null, ghosted: new Set() }, 5)).toBeNull()
  })

  it('knows when there is something to clear', () => {
    expect(visibilityActive({ hidden: new Set(), isolated: null, ghosted: new Set() })).toBe(false)
    expect(visibilityActive({ hidden: new Set(), isolated: null, ghosted: new Set(['red']) })).toBe(true)
  })
})
