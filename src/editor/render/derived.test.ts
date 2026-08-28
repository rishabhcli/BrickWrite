import { describe, expect, it } from 'vitest'
import { computeDerived, DerivedRunner, graphOf, type DerivedGraph } from './derived'

const chain = (length: number): DerivedGraph => ({
  partIds: Array.from({ length }, (_, index) => `p${index}`),
  edges: Array.from({ length: length - 1 }, (_, index) => [`p${index}`, `p${index + 1}`]).flat(),
})

describe('derived graph computation', () => {
  it('measures hop distance along the connection graph', () => {
    const result = computeDerived({ id: 1, graph: chain(6), seedPartIds: ['p0'], hops: 2 })
    expect(result.withinHops).toEqual(['p0', 'p1', 'p2'])
    expect(result.distances).toEqual([0, 1, 2])
  })

  it('labels connected components', () => {
    const graph: DerivedGraph = { partIds: ['a', 'b', 'c', 'd'], edges: ['a', 'b', 'c', 'd'] }
    const result = computeDerived({ id: 1, graph, seedPartIds: [], hops: 0 })
    expect(result.componentCount).toBe(2)
    expect(result.components[0]).toBe(result.components[1])
    expect(result.components[0]).not.toBe(result.components[2])
  })

  it('ignores edges naming parts that are not in the document', () => {
    const graph: DerivedGraph = { partIds: ['a'], edges: ['a', 'ghost'] }
    expect(computeDerived({ id: 1, graph, seedPartIds: ['a'], hops: 3 }).withinHops).toEqual(['a'])
  })

  it('returns nothing for an empty seed rather than everything', () => {
    expect(computeDerived({ id: 1, graph: chain(4), seedPartIds: [], hops: 4 }).withinHops).toEqual([])
  })

  it('carries the request id back, so responses can be matched', () => {
    expect(computeDerived({ id: 77, graph: chain(2), seedPartIds: ['p0'], hops: 1 }).id).toBe(77)
  })
})

describe('the runner', () => {
  it('falls back to the same function when no worker exists', async () => {
    // The fallback is not a degraded path: it is the same code on the same
    // input, which is why the two can never disagree.
    const runner = new DerivedRunner(false)
    const result = await runner.run(chain(5), ['p0'], 1)
    expect(runner.mode).toBe('synchronous')
    expect(result.withinHops).toEqual(['p0', 'p1'])
    runner.dispose()
  })

  it('produces the same answer whichever side it ran on', async () => {
    const runner = new DerivedRunner(false)
    const graph = chain(40)
    const direct = computeDerived({ id: 1, graph, seedPartIds: ['p10'], hops: 4 })
    const viaRunner = await runner.run(graph, ['p10'], 4)
    expect(viaRunner.withinHops).toEqual(direct.withinHops)
    runner.dispose()
  })
})

describe('the transferable projection', () => {
  it('carries only ids and endpoints, never geometry', () => {
    const graph = graphOf({
      parts: { a: { huge: new Array(1000) }, b: {} },
      connections: { e1: { a: { partId: 'a' }, b: { partId: 'b' } } },
    })
    expect(graph.partIds).toEqual(['a', 'b'])
    expect(graph.edges).toEqual(['a', 'b'])
    expect(JSON.stringify(graph).length).toBeLessThan(120)
  })
})
