import { appendFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'

const OUT = '/private/tmp/claude-501/-Users-m3-max-Documents-GitHub-BrickWrite/92332161-4cc2-4d45-a2d1-83f2badd1123/scratchpad/diag.txt'
let started = false
const log = (line: string) => {
  if (!started) { writeFileSync(OUT, ''); started = true }
  appendFileSync(OUT, line + '\n')
}
import { validateDocument } from '../cad/validation'
import { analyseRegion, createScope } from './analyse'
import { runRefinement } from './pipeline'
import { refinementFixtures } from './__fixtures__'
import { OBJECTIVES } from './objectives'

describe('diagnose', () => {
  it('reports fixture health', () => {
    for (const fixture of refinementFixtures()) {
      const report = validateDocument(fixture.document)
      const scope = createScope({
        partIds: fixture.scopePartIds,
        protectedPartIds: fixture.protectedPartIds,
        boundaryPartIds: fixture.boundaryPartIds,
        symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
      })
      const analysis = analyseRegion(fixture.document, scope)
      const kinds = [...new Set(analysis.issues.map((i) => i.kind))].join(',')
      log(
        `[${fixture.id}] parts=${report.partCount} conns=${report.connectionCount} comps=${report.componentCount}` +
          ` collisions=${report.collisions.length} virtual=${report.virtualColors.length} healthy=${report.healthy}` +
          ` scope=${fixture.scopePartIds.length} issues=[${kinds}]`,
      )
      if (report.collisions.length) log('   collisions:', report.collisions.map((c) => `${c.partA}/${c.partB}:${c.certainty}`).join(' '))
      if (report.virtualColors.length) log('   virtual:', JSON.stringify(report.virtualColors))
      if (report.disconnectedPartIds.length) log('   disconnected:', report.disconnectedPartIds.join(','))
    }
  })

  it('reports pipeline outcomes', () => {
    for (const fixture of refinementFixtures()) {
      const run = runRefinement(
        {
          version: 1,
          id: `req_${fixture.id}`,
          scopePartIds: fixture.scopePartIds,
          protectedPartIds: fixture.protectedPartIds,
          boundaryPartIds: fixture.boundaryPartIds,
          symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
          baseRevision: fixture.document.revision,
          instruction: fixture.instruction,
          seed: 7,
          ...(fixture.silhouetteToleranceFraction === undefined
            ? {}
            : { silhouetteToleranceFraction: fixture.silhouetteToleranceFraction }),
        },
        fixture.document,
      )
      const ranked = run.proposals.filter((p) => p.status === 'ranked')
      const target = fixture.targetObjective
      const best = ranked
        .slice()
        .sort((a, b) => (b.metrics.after[target] - b.metrics.before[target]) * (OBJECTIVES[target].direction === 'higher-is-better' ? 1 : -1) - (a.metrics.after[target] - a.metrics.before[target]) * (OBJECTIVES[target].direction === 'higher-is-better' ? 1 : -1))[0]
      log(
        `[${fixture.id}] target=${target} ranked=${ranked.length} rejected=${run.proposals.length - ranked.length}` +
          ` generated=${run.report.generated} evaluated=${run.report.evaluated} ms=${run.report.elapsedMs}` +
          ` strategies=${run.report.strategiesRun.join('/')}` +
          (best ? ` BEST ${best.strategy} ${target}: ${best.metrics.before[target].toFixed(3)} -> ${best.metrics.after[target].toFixed(3)}` : ' NO RANKED'),
      )
      if (!ranked.length) {
        for (const p of run.proposals.slice(0, 6)) log(`    rejected[${p.strategy}] ${p.rejection?.code}: ${p.rejection?.reason?.slice(0, 160)}`)
      }
    }
  })
})
