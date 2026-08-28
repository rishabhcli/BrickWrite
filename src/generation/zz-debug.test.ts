import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBlankDocument } from '../cad/sample'
import { realizeGraph } from './realize'
import type { BuildGraph } from './graph'

describe('debug', () => {
  it('shows repair outcomes', () => {
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        { id: 'deck', kind: 'region', colour: 71, role: 'base', anchorLdu: [0, 0, 0], region: { shape: 'field', widthStuds: 8, depthStuds: 4, courses: 2, family: 'plate' } },
        { id: 'beamA', kind: 'part', colour: 4, role: 'frame', part: { query: 'brick 2 x 4', sizeStuds: [4, 3.5, 2] } },
        { id: 'beamB', kind: 'part', colour: 4, role: 'frame', part: { query: 'brick 2 x 4', sizeStuds: [4, 3.5, 2] } },
      ],
      edges: (['beamA', 'beamB'] as const).map((to, index) => ({
        id: `e_${to}`,
        from: 'deck',
        to,
        fromConnector: { family: 'stud' as const, pick: { kind: 'grid' as const, uStuds: index, vStuds: 0, level: 'top' as const } },
        toConnector: { family: 'anti-stud' as const, pick: { kind: 'grid' as const, uStuds: 0, vStuds: 0 } },
        family: 'stud' as const,
      })),
    }
    const result = realizeGraph(graph, createBlankDocument('D'), { seed: 3 })
    const lines = result.nodes.map((n) => `${n.nodeId} ${n.status} def=${n.definitionId ?? '-'} parts=${n.partIds.length} reason=${n.reason ?? '-'}`)
    for (const e of result.edges) {
      lines.push(`EDGE ${e.edgeId} ${e.status} kind=${e.repairKind ?? '-'} attempts=${e.attempts} log=${JSON.stringify((e.attemptLog ?? []).slice(0, 3))}`)
    }
    writeFileSync(String(process.env.SCRATCH) + '/dbg.txt', lines.join('\n'))
    expect(true).toBe(true)
  })
})
