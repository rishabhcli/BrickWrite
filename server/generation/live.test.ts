// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from '../../src/cad/catalog.ts'
import fixture from '../../src/cad/__fixtures__/catalog.fixture.json' with { type: 'json' }
import { findCollisions, residentGeometryProvider } from '../../src/cad/collision.ts'
import { computeBuildOrder, verifyBuildOrder } from '../../src/cad/instructions.ts'
import { createBlankDocument } from '../../src/cad/sample.ts'
import { analyseStatics } from '../../src/cad/statics.ts'
import { compileBriefDeterministically } from '../../src/generation/brief.ts'
import { GenerationEngine } from '../../src/generation/engine.ts'
import { createGenerationProvider } from '../../src/generation/provider.ts'
import { componentsOf } from '../../src/generation/score.ts'
import { configFromEnv } from './anthropic.ts'
import { createGenerationServer } from './serve.ts'

/**
 * The live smoke test.
 *
 * Skipped unless explicitly enabled with `BRICKWRIGHT_LIVE_TESTS=1` and an
 * `ANTHROPIC_API_KEY`. A developer shell may legitimately carry a key for the
 * application, but an ordinary `npm test` must remain hermetic and free. When
 * enabled this is end to end — a real key, a real model, the real route, the
 * real kernel — and it asserts that a model-proposed decomposition becomes an
 * assembly with no interpenetration, one connected body and a build order a
 * person could follow.
 *
 * It costs a handful of cents per run and is deliberately kept to two model
 * calls.
 */

const RUN_LIVE = process.env.BRICKWRIGHT_LIVE_TESTS === '1' && Boolean(process.env.ANTHROPIC_API_KEY?.trim())

// The kernel needs a catalog. The API process does not install one — it never
// places a part — so the test installs the same slice the browser suite uses.
if (RUN_LIVE && !catalog.loaded) catalog.install(fixture as unknown as CatalogPayload)

const report: string[] = []
const say = (line: string) => {
  report.push(line)
  process.stdout.write(`[live] ${line}\n`)
}

describe.skipIf(!RUN_LIVE)('live provider smoke test', () => {
  it('compiles a brief and generates a kernel-valid model through the real API', async () => {
    const config = configFromEnv()
    const server = await createGenerationServer({ providerConfig: config })
    say(`model=${config.model} route=${server.url}`)

    try {
      // -- /api/brief ------------------------------------------------------
      const briefResponse = await fetch(`${server.url}/api/brief`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Build a small red house 12 x 10 studs, 10 studs tall, under 300 pieces, with doors that open',
        }),
      })
      expect(briefResponse.status).toBe(200)
      const briefEvents = (await briefResponse.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const briefResult = briefEvents.at(-1)!
      expect(briefResult.type, JSON.stringify(briefResult)).toBe('result')

      const brief = briefResult.value as {
        version: number
        subject: string
        envelopeStuds: number[] | null
        partBudget: number | null
        palette: number[]
        functions: string[]
        evidence: Record<string, string>
        conflicts: unknown[]
      }
      expect(brief.version).toBe(1)
      expect(brief.subject.length).toBeGreaterThan(0)
      expect(Object.keys(brief.evidence).length).toBeGreaterThan(0)
      say(
        `brief subject=${JSON.stringify(brief.subject)} envelope=${JSON.stringify(brief.envelopeStuds)} `
          + `budget=${brief.partBudget} palette=${JSON.stringify(brief.palette)} functions=${JSON.stringify(brief.functions)}`,
      )
      say(`brief usage=${JSON.stringify(briefResult.usage)} attempts=${briefResult.attempts}`)

      // -- /api/generate, driving the whole pipeline -------------------------
      const provider = createGenerationProvider({ baseUrl: server.url, model: config.model })
      const engine = new GenerationEngine({ provider })
      const compiled = compileBriefDeterministically(
        'Build a light bluish grey observation tower 12 x 10 studs, 12 studs tall, under 300 pieces',
      )

      const run = await engine.generate(compiled, { base: createBlankDocument('Live smoke'), seed: 3, count: 1 })
      const candidate = run.candidates[0] ?? run.rejected[0]?.candidate
      expect(candidate, 'the run produced no candidate at all').toBeTruthy()

      const collisions = findCollisions(candidate!.document, { provide: residentGeometryProvider })
      const components = componentsOf(candidate!.document)
      const order = computeBuildOrder(candidate!.document)
      const verdict = verifyBuildOrder(candidate!.document, order.steps)
      const statics = analyseStatics(candidate!.document)

      say(`massing boxes proposed by the model: ${JSON.stringify(candidate!.boxes)}`)
      say(
        `candidate strategy=${candidate!.strategy} parts=${candidate!.metrics.partCount} `
          + `distinct=${candidate!.metrics.distinctElements} collisions=${collisions.length} `
          + `components=${components.length} buildOrderValid=${verdict.valid} steps=${order.steps.length}`,
      )
      say(
        `mass=${statics.mass.grams.toFixed(1)}g supportMargin=${statics.support?.marginLdu.toFixed(2) ?? 'n/a'}ldu `
          + `overloaded=${statics.overloaded.length} extent=${candidate!.metrics.extentStuds.map((v) => v.toFixed(1)).join(' x ')} studs`,
      )
      say(`gates=${run.rejected.length ? JSON.stringify(run.rejected[0].failures) : 'all passed'}`)
      say(`provenance=${JSON.stringify(run.provenance)}`)

      expect(collisions).toEqual([])
      expect(verdict.valid).toBe(true)
      expect(candidate!.metrics.partCount).toBeGreaterThan(20)
      expect(components.length).toBeGreaterThan(0)
      expect(statics.mass.grams).toBeGreaterThan(0)
      expect(run.candidates.length).toBe(1)
    } finally {
      await server.close()
      process.stdout.write(`[live] ---- transcript ----\n${report.join('\n')}\n`)
    }
  }, 180_000)
})

describe.skipIf(RUN_LIVE)('live provider smoke test (skipped)', () => {
  it('is skipped unless live tests are explicitly enabled with a credential', () => {
    expect(RUN_LIVE).toBe(false)
  })
})
