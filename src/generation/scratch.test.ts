import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBlankDocument } from '../cad/sample'
import { compileBriefDeterministically } from './brief'
import { runPipeline, STRATEGIES } from './phases'
import { findCollisions, residentGeometryProvider } from '../cad/collision'
import { componentsOf } from './score'

describe('scratch', () => {
  it('builds something', async () => {
    const out: unknown[] = []
    const brief = compileBriefDeterministically('Build a small red house 12 x 10 studs, 10 studs tall, under 300 pieces')
    out.push('BRIEF ' + JSON.stringify(brief))
    for (const strategy of STRATEGIES) {
      const candidate = await runPipeline(brief, { seed: 1, strategy: strategy.id, base: createBlankDocument('Test') })
      out.push(`${strategy.id} parts=${candidate.metrics.partCount} collisions=${candidate.metrics.collisionCount} components=${candidate.metrics.componentCount} buildOrder=${candidate.metrics.buildOrderValid} hash=${candidate.structuralHash}`)
      out.push('  nodes: ' + candidate.realize.nodes.map(n => `${n.nodeId}:${n.status}${n.reason ? '(' + n.reason + ')' : ''}:${n.partIds.length}`).join(' | '))
      for (const n of candidate.realize.nodes) if (n.attemptLog) out.push('  LOG ' + n.nodeId + ':\n    ' + n.attemptLog.slice(0,4).join('\n    '))
      out.push('  edges: ' + candidate.realize.edges.map(e => `${e.edgeId}:${e.status}${e.reason ? '(' + e.reason + ')' : ''}`).join(' | '))
      out.push('  phases: ' + candidate.phases.map(p => `${p.phase}=${p.metrics.partCount}`).join(' '))
    }
    writeFileSync(process.env.SCRATCH + '/out.txt', out.map(v=>String(v)).join('\n'))
    expect(true).toBe(true)
  }, 120000)
})
