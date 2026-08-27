import { describe, expect, it } from 'vitest'
import { getPartBounds } from './geometry'
import { computeBuildOrder, verifyBuildOrder } from './instructions'
import { IDENTITY_BASIS } from './math'
import { createEmptyDocument, createShowcaseDocument } from './sample'
import { deriveConnectionEdges } from './snapping'
import type { ModelDocument, PartInstance } from './types'

const part = (id: string, definitionId: string, position: [number, number, number], subassemblyId = 'hull'): PartInstance => ({
  id,
  definitionId,
  color: 71,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId,
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

/** Fresh document with a derived connection graph, as the kernel produces. */
const withParts = (parts: PartInstance[]): ModelDocument => {
  const base = createEmptyDocument()
  const document: ModelDocument = {
    ...base,
    parts: Object.fromEntries(parts.map((item) => [item.id, item])),
    subassemblies: Object.fromEntries(
      Object.entries(base.subassemblies).map(([id, value]) => [
        id,
        { ...value, partIds: parts.filter((item) => item.subassemblyId === id).map((item) => item.id) },
      ]),
    ),
  }
  return { ...document, connections: deriveConnectionEdges(document, 1, 'import-inferred') }
}

describe('build order', () => {
  it('never introduces a part that cannot attach to earlier structure', () => {
    // A tower built top-down in document order; the generator must reorder it.
    const tower = withParts([
      part('top', '3001', [0, -96, 0]),
      part('upper', '3001', [0, -72, 0]),
      part('mid', '3001', [0, -48, 0]),
      part('lower', '3001', [0, -24, 0]),
      part('base', '3001', [0, 0, 0]),
    ])
    const result = computeBuildOrder(tower, { maxPartsPerStep: 1 })
    expect(result.steps.map((step) => step.partIds[0])).toEqual(['base', 'lower', 'mid', 'upper', 'top'])
    expect(verifyBuildOrder(tower, result.steps).valid).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it('builds bottom-up, because LDraw is Y-down and reachability follows gravity', () => {
    const tower = withParts([
      part('base', '3001', [0, 0, 0]),
      part('lower', '3001', [0, -24, 0]),
      part('mid', '3001', [0, -48, 0]),
    ])
    const first = computeBuildOrder(tower, { maxPartsPerStep: 1 }).steps[0]
    const bottoms = Object.values(tower.parts).map((item) => getPartBounds(item).max[1])
    // The first part placed is the lowest one in the model.
    expect(getPartBounds(tower.parts[first.partIds[0]]).max[1]).toBe(Math.max(...bottoms))
  })

  it('reports a separately-built island rather than implying continuous construction', () => {
    const twoTowers = withParts([
      part('a1', '3001', [0, 0, 0]),
      part('a2', '3001', [0, -24, 0]),
      part('b1', '3001', [400, 0, 0]),
      part('b2', '3001', [400, -24, 0]),
    ])
    const result = computeBuildOrder(twoTowers, { maxPartsPerStep: 4 })
    expect(result.unsupportedPartIds).toHaveLength(1)
    expect(result.warnings.map((warning) => warning.code)).toContain('NEW_ISLAND')
    // The new island starts its own step.
    const islandPart = result.unsupportedPartIds[0]
    const owningStep = result.steps.find((step) => step.partIds.includes(islandPart))!
    expect(owningStep.partIds[0]).toBe(islandPart)
  })

  it('flags a part with no connection at all', () => {
    const floating = withParts([part('base', '3001', [0, 0, 0]), part('orphan', '3005', [500, -500, 500])])
    const result = computeBuildOrder(floating)
    expect(result.warnings.map((warning) => warning.code)).toContain('UNCONNECTED_PART')
  })

  it('respects the per-step budget', () => {
    const wall = withParts(
      Array.from({ length: 20 }, (_, index) =>
        part(`p${index}`, '3024', [(index % 5) * 20, -Math.floor(index / 5) * 8, 0]),
      ),
    )
    const result = computeBuildOrder(wall, { maxPartsPerStep: 3 })
    expect(result.steps.every((step) => step.partIds.length <= 3)).toBe(true)
    expect(result.steps.flatMap((step) => step.partIds)).toHaveLength(20)
  })

  it('keeps a subassembly contiguous when asked', () => {
    const mixed = withParts([
      part('c1', '3001', [0, 0, 0], 'chassis'),
      part('c2', '3001', [0, -24, 0], 'chassis'),
      part('h1', '3001', [0, -48, 0], 'hull'),
      part('h2', '3001', [0, -72, 0], 'hull'),
    ])
    const grouped = computeBuildOrder(mixed, { maxPartsPerStep: 4, groupBySubassembly: true })
    for (const step of grouped.steps) {
      const owners = new Set(step.partIds.map((id) => mixed.parts[id].subassemblyId))
      expect(owners.size).toBe(1)
    }
  })

  it('assigns every part exactly once', () => {
    const result = computeBuildOrder(createShowcaseDocument())
    const assigned = result.steps.flatMap((step) => step.partIds)
    expect(new Set(assigned).size).toBe(assigned.length)
    expect(assigned).toHaveLength(Object.keys(createShowcaseDocument().parts).length)
  })

  it('produces a verifiable sequence for the showcase', () => {
    const document = createShowcaseDocument()
    const result = computeBuildOrder(document)
    const check = verifyBuildOrder(document, result.steps)
    expect(check.violations).toEqual([])
    expect(result.steps.length).toBeGreaterThan(2)
  })

  it('is deterministic', () => {
    const document = createShowcaseDocument()
    const a = computeBuildOrder(document)
    const b = computeBuildOrder(document)
    expect(a.steps.map((step) => step.partIds.join(','))).toEqual(b.steps.map((step) => step.partIds.join(',')))
  })

  it('catches a hand-reordered sequence that breaks reachability', () => {
    const tower = withParts([
      part('base', '3001', [0, 0, 0]),
      part('lower', '3001', [0, -24, 0]),
      part('mid', '3001', [0, -48, 0]),
    ])
    // Deliberately wrong: the top brick is introduced before anything supports it.
    const broken = [
      { id: 'step_1', index: 1, name: 'Bad', partIds: ['base'] },
      { id: 'step_2', index: 2, name: 'Bad', partIds: ['mid'] },
      { id: 'step_3', index: 3, name: 'Bad', partIds: ['lower'] },
    ]
    const check = verifyBuildOrder(tower, broken)
    expect(check.valid).toBe(false)
    expect(check.violations).toEqual([{ stepIndex: 2, partId: 'mid' }])
  })

  it('accepts parts that attach to a sibling within the same step', () => {
    const tower = withParts([part('base', '3001', [0, 0, 0]), part('lower', '3001', [0, -24, 0])])
    const single = [{ id: 'step_1', index: 1, name: 'Both', partIds: ['base', 'lower'] }]
    expect(verifyBuildOrder(tower, single).valid).toBe(true)
  })
})
