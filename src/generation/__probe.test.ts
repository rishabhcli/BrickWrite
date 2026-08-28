import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBlankDocument } from '../cad/sample'
import { compileBriefDeterministically } from './brief'
import { GenerationEngine } from './engine'
import { createTestModelProvider } from './testing'

describe('probe', () => {
  it('generates fast enough for a component test', async () => {
    const brief = compileBriefDeterministically('a small 8 x 4 stud red kiosk under 90 parts')
    const engine = new GenerationEngine({ provider: createTestModelProvider() })
    const started = Date.now()
    const phases: string[] = []
    const run = await engine.generate(brief, {
      base: createBlankDocument('probe'),
      count: 2,
      onPhase: (event, index) => phases.push(`${index}:${event.phase}:${event.metrics.partCount}`),
    })
    const out = [
      `elapsed ${Date.now() - started}`,
      `brief ${JSON.stringify(brief)}`,
      `accepted ${run.candidates.length} rejected ${run.rejected.length} distinct ${run.distinctHashes}`,
      `phases ${phases.join(', ')}`,
      `notes ${JSON.stringify(run.notes)}`,
      `metrics0 ${JSON.stringify(run.candidates[0]?.metrics ?? run.rejected[0]?.candidate.metrics)}`,
      `failures ${JSON.stringify(run.rejected.map((r) => r.failures))}`,
      `provenance ${JSON.stringify(run.provenance)}`,
    ]
    writeFileSync('/tmp/genprobe.txt', out.join('\n'))
    expect(run.candidates.length + run.rejected.length).toBeGreaterThan(0)
  }, 60_000)
})
