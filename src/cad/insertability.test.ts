import { describe, expect, it } from 'vitest'
import { findBlockedInsertions } from './instructions'
import { verifyBuildOrder } from './instructions'
import { IDENTITY_BASIS } from './math'
import { createBlankDocument } from './sample'
import type { BuildStep, ModelDocument, PartInstance } from './types'

/**
 * The gap between "verified" and "buildable".
 *
 * `verifyBuildOrder` answers a graph question: does every part attach to
 * something placed earlier. A sequence can satisfy that completely and still be
 * impossible to build — the finding's example is an interior mechanism sequenced
 * after the shell that encloses it, and the builder discovers it holding a piece
 * with nowhere to put it.
 *
 * These tests build exactly that shape and require the graph check to *pass*
 * while the insertion check *fails*, because a warning that only fires when
 * something else already failed would add nothing.
 */

const part = (id: string, position: [number, number, number], definitionId = '3005'): PartInstance => ({
  id,
  definitionId,
  color: 72,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

const doc = (parts: PartInstance[], connections: Array<[string, string]> = []): ModelDocument => {
  const base = createBlankDocument('Insertability')
  return {
    ...base,
    parts: Object.fromEntries(parts.map((entry) => [entry.id, entry])),
    connections: Object.fromEntries(
      connections.map(([a, b], index) => [
        `c${index}`,
        {
          id: `c${index}`,
          a: { partId: a, featureId: 'f0' },
          b: { partId: b, featureId: 'f1' },
          family: 'stud' as const,
          freedom: { kind: 'fixed' as const },
          source: 'derived' as const,
        },
      ]),
    ),
    subassemblies: { ...base.subassemblies, hull: { ...base.subassemblies.hull, partIds: parts.map((p) => p.id) } },
  }
}

const step = (index: number, partIds: string[]): BuildStep => ({
  id: `step_${index}`,
  index,
  name: `Step ${index}`,
  partIds,
})

describe('insertion direction', () => {
  it('reports a part walled in on every side by earlier steps', () => {
    // A 1×1 well: four walls and a floor placed first, the core last. Every
    // approach except straight down is blocked, and down is blocked by the floor.
    const parts = [
      part('floor', [0, 0, 0]),
      part('west', [-20, -24, 0]),
      part('east', [20, -24, 0]),
      part('north', [0, -24, -20]),
      part('south', [0, -24, 20]),
      part('lid', [0, -48, 0]),
      part('core', [0, -24, 0]),
    ]
    // The core attaches to the floor, so the graph check is satisfied.
    const document = doc(parts, [['core', 'floor'], ['west', 'floor'], ['east', 'floor'], ['north', 'floor'], ['south', 'floor'], ['lid', 'west']])
    const steps = [step(1, ['floor']), step(2, ['west', 'east', 'north', 'south']), step(3, ['lid']), step(4, ['core'])]

    // The distinction that matters: connectivity is fine.
    expect(verifyBuildOrder(document, steps).valid).toBe(true)

    const blocked = findBlockedInsertions(document, steps)
    expect(blocked.map((entry) => entry.partId)).toEqual(['core'])
    expect(blocked[0].stepIndex).toBe(4)
    expect(blocked[0].blockedBy.length).toBeGreaterThan(0)
  })

  it('accepts the same well when the core goes in before the lid', () => {
    // The repair the warning is meant to prompt: place the core, then close it.
    // Straight up is now open, so nothing is reported.
    const parts = [
      part('floor', [0, 0, 0]),
      part('west', [-20, -24, 0]),
      part('east', [20, -24, 0]),
      part('north', [0, -24, -20]),
      part('south', [0, -24, 20]),
      part('lid', [0, -48, 0]),
      part('core', [0, -24, 0]),
    ]
    const document = doc(parts, [['core', 'floor'], ['west', 'floor'], ['east', 'floor'], ['north', 'floor'], ['south', 'floor'], ['lid', 'west']])
    const steps = [step(1, ['floor']), step(2, ['west', 'east', 'north', 'south']), step(3, ['core']), step(4, ['lid'])]
    expect(findBlockedInsertions(document, steps)).toEqual([])
  })

  it('says nothing about an ordinary stack', () => {
    const parts = Array.from({ length: 6 }, (_, index) => part(`p${index}`, [0, -24 * index, 0]))
    const document = doc(parts, parts.slice(1).map((entry, index) => [entry.id, `p${index}`] as [string, string]))
    const steps = parts.map((entry, index) => step(index + 1, [entry.id]))
    expect(findBlockedInsertions(document, steps)).toEqual([])
  })

  it('does not accuse parts that arrive in the same step', () => {
    // Two halves of one enclosure placed together are one pair of hands; their
    // mutual order is not this function's business.
    const parts = [part('a', [0, 0, 0]), part('b', [20, 0, 0]), part('c', [-20, 0, 0])]
    const document = doc(parts, [['b', 'a'], ['c', 'a']])
    expect(findBlockedInsertions(document, [step(1, ['a', 'b', 'c'])])).toEqual([])
  })

  it('ignores a part with no compiled geometry rather than guessing', () => {
    const parts = [part('floor', [0, 0, 0]), part('ghost', [0, -24, 0], 'not-a-real-part')]
    const document = doc(parts, [['ghost', 'floor']])
    expect(findBlockedInsertions(document, [step(1, ['floor']), step(2, ['ghost'])])).toEqual([])
  })
})
