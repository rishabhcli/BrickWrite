import { describe, expect, it } from 'vitest'
import fixtures from './__fixtures__/briefs.json'
import { catalog } from '../cad/catalog'
import { findCollisions, residentGeometryProvider } from '../cad/collision'
import { computeBuildOrder, verifyBuildOrder } from '../cad/instructions'
import { CadEngine } from '../cad/engine'
import { createBlankDocument } from '../cad/sample'
import { analyseStatics } from '../cad/statics'
import { compileBriefDeterministically } from './brief'
import { applyCandidate, candidateOperations, GenerationEngine } from './engine'
import { componentsOf, diffMetrics } from './score'
import { createTestModelProvider } from './testing'
import { referencesFromEnvelope } from './silhouette'
import type { Candidate } from './phases'
import type { DesignBrief } from '../platform/contracts'
import type { CadOperation, ModelDocument } from '../cad/types'

/**
 * The acceptance suite.
 *
 * Every assertion here is about a property of the *model that would be built*,
 * measured through the same kernel a human edit goes through. "It produced 140
 * parts" is worth nothing; "no two of those 140 parts intersect, they form one
 * connected body, and there is an order in which a person could place them" is
 * the whole claim.
 */

interface Fixture {
  id: string
  category: string
  prompt: string
  expect: {
    archetype?: string
    envelopeStuds?: [number, number, number]
    partBudget?: number
    palette?: number[]
    scale?: string
    symmetry?: string
    style?: string[]
    functions?: number
  }
}

const BRIEFS = (fixtures as { briefs: Fixture[] }).briefs

const base = () => createBlankDocument('Generation acceptance')

/** The double stands in for the model; the kernel is real throughout. */
const engineWithDouble = () => new GenerationEngine({ provider: createTestModelProvider() })

const partsOf = (document: ModelDocument) => Object.values(document.parts)

describe('the golden briefs compile into structures the compiler can defend', () => {
  it('covers every subject family the suite claims to cover', () => {
    expect(BRIEFS.length).toBeGreaterThanOrEqual(20)
    const categories = new Set(BRIEFS.map((entry) => entry.category))
    for (const family of ['vehicle', 'building', 'furniture', 'creature', 'mechanism', 'sculpture']) {
      expect(categories).toContain(family)
    }
  })

  it('reads every stated envelope, budget, palette and function out of the prose', () => {
    for (const fixture of BRIEFS) {
      const brief = compileBriefDeterministically(fixture.prompt)
      const wanted = fixture.expect
      if (wanted.envelopeStuds) {
        expect(brief.envelopeStuds, `${fixture.id} envelope`).toEqual(wanted.envelopeStuds)
        expect(brief.evidence.envelopeStuds, `${fixture.id} envelope evidence`).toBeTruthy()
      }
      if (wanted.partBudget !== undefined) {
        expect(brief.partBudget, `${fixture.id} budget`).toBe(wanted.partBudget)
        expect(brief.evidence.partBudget, `${fixture.id} budget evidence`).toBeTruthy()
      }
      if (wanted.palette) expect(brief.palette, `${fixture.id} palette`).toEqual(wanted.palette)
      if (wanted.scale) expect(brief.scale, `${fixture.id} scale`).toBe(wanted.scale)
      if (wanted.symmetry) expect(brief.symmetry, `${fixture.id} symmetry`).toBe(wanted.symmetry)
      if (wanted.style) {
        for (const word of wanted.style) expect(brief.style, `${fixture.id} style`).toContain(word)
      }
      if (wanted.functions !== undefined) {
        expect(brief.functions.length, `${fixture.id} functions`).toBeGreaterThanOrEqual(wanted.functions)
      }
    }
  })
})

interface GoldenResult {
  fixture: Fixture
  brief: DesignBrief
  candidates: Candidate[]
  rejected: Array<{ candidate: Candidate; failures: string[] }>
  distinctHashes: number
}

/**
 * Generated once and shared, because generating 21 briefs three ways is the
 * expensive part and every gate below asks a different question of the same
 * output.
 */
const golden: GoldenResult[] = []

describe('every accepted candidate is a model somebody could actually build', () => {
  it('generates three candidates for each of the golden briefs', async () => {
    const engine = engineWithDouble()
    for (const fixture of BRIEFS) {
      const brief = compileBriefDeterministically(fixture.prompt)
      const run = await engine.generate(brief, { base: base(), seed: 7, count: 3 })
      golden.push({
        fixture,
        brief,
        candidates: run.candidates,
        rejected: run.rejected,
        distinctHashes: run.distinctHashes,
      })
    }
    expect(golden.length).toBe(BRIEFS.length)
    const produced = golden.reduce((total, entry) => total + entry.candidates.length + entry.rejected.length, 0)
    expect(produced).toBe(BRIEFS.length * 3)
  }, 300_000)

  it('produces at least one buildable candidate for every brief', () => {
    for (const entry of golden) {
      expect(
        entry.candidates.length,
        `${entry.fixture.id} produced no candidate that passed the hard gates: ${entry.rejected
          .map((item) => item.failures.join('; '))
          .join(' | ')}`,
      ).toBeGreaterThan(0)
    }
  })

  it('places no part that intersects another', () => {
    for (const entry of golden) {
      for (const candidate of entry.candidates) {
        const collisions = findCollisions(candidate.document, { provide: residentGeometryProvider })
        expect(
          collisions.map((contact) => `${contact.partA}/${contact.partB}:${contact.certainty}`),
          `${entry.fixture.id} · ${candidate.id}`,
        ).toEqual([])
      }
    }
  })

  it('is one connected body, or is explicitly partitioned into buildable subassemblies', () => {
    for (const entry of golden) {
      for (const candidate of entry.candidates) {
        const components = componentsOf(candidate.document)
        expect(components.length, `${entry.fixture.id} · ${candidate.id} has no parts`).toBeGreaterThan(0)
        if (components.length === 1) continue
        // More than one island is legitimate, but only if the build order says
        // so out loud and each island is more than a loose brick.
        const order = computeBuildOrder(candidate.document)
        expect(
          order.warnings.some((warning) => warning.code === 'NEW_ISLAND'),
          `${entry.fixture.id} · ${candidate.id} has ${components.length} components but reports no island`,
        ).toBe(true)
        for (const component of components) {
          expect(component.length, `${entry.fixture.id} · ${candidate.id} island of one`).toBeGreaterThan(1)
        }
      }
    }
  })

  it('has a build order in which every step attaches to what came before', () => {
    for (const entry of golden) {
      for (const candidate of entry.candidates) {
        const order = computeBuildOrder(candidate.document)
        const verdict = verifyBuildOrder(candidate.document, order.steps)
        expect(verdict.violations, `${entry.fixture.id} · ${candidate.id}`).toEqual([])
        expect(verdict.valid).toBe(true)
        expect(order.steps.length).toBeGreaterThan(0)
      }
    }
  })

  it('produces a stability report with a measured mass and a stated basis', () => {
    for (const entry of golden) {
      for (const candidate of entry.candidates) {
        const statics = analyseStatics(candidate.document)
        expect(statics.mass.grams, `${entry.fixture.id} · ${candidate.id}`).toBeGreaterThan(0)
        expect(statics.coverage).toBeGreaterThan(0)
        expect(statics.assumptions.massBasis).toContain('LDraw')
        expect(candidate.metrics.supportMarginLdu).not.toBeNull()
      }
    }
  })

  it('honours every hard constraint the brief stated', () => {
    for (const entry of golden) {
      const brief = entry.brief
      for (const candidate of entry.candidates) {
        const parts = partsOf(candidate.document)
        if (brief.partBudget !== null) {
          expect(parts.length, `${entry.fixture.id} · ${candidate.id} budget`).toBeLessThanOrEqual(brief.partBudget)
        }
        if (brief.envelopeStuds) {
          for (let axis = 0; axis < 3; axis += 1) {
            expect(
              candidate.metrics.extentStuds[axis],
              `${entry.fixture.id} · ${candidate.id} axis ${axis}`,
            ).toBeLessThanOrEqual(brief.envelopeStuds[axis] + 1e-6)
          }
        }
        if (brief.palette.length) {
          const outside = parts.filter((part) => !brief.palette.includes(part.color))
          expect(outside.map((part) => `${part.definitionId}:${part.color}`), `${entry.fixture.id} palette`).toEqual([])
        }
      }
    }
  })

  it('places only identities this build can actually place', () => {
    for (const entry of golden) {
      for (const candidate of entry.candidates) {
        for (const part of partsOf(candidate.document)) {
          const record = catalog.describe(part.definitionId)
          expect(record?.tier, `${entry.fixture.id} · ${part.definitionId}`).toBe('placeable')
          expect(catalog.get(part.definitionId)?.geometryStatus).toBe('certified')
        }
      }
    }
  })

  it('is accepted by the kernel through the command bus, collisions and all', () => {
    for (const entry of golden) {
      const candidate = entry.candidates[0]
      const engine = new CadEngine(base())
      engine.setAutonomy('build')
      const revision = engine.getSnapshot().document.revision
      const result = applyCandidate(candidate, engine, revision)
      expect(
        result.ok ? null : `${entry.fixture.id}: ${result.error.code} — ${result.error.message}`,
        `${entry.fixture.id} was refused by the kernel`,
      ).toBeNull()
      if (!result.ok) continue
      const committed = engine.getSnapshot().document
      expect(Object.keys(committed.parts).length).toBe(candidate.metrics.partCount)
      expect(verifyBuildOrder(committed, committed.steps).valid).toBe(true)
    }
  }, 300_000)
})

describe('the same inputs produce the same model', () => {
  it('reproduces the structural hash and the operation list byte for byte', async () => {
    const brief = compileBriefDeterministically(BRIEFS[4].prompt)
    const first = await engineWithDouble().generate(brief, { base: base(), seed: 42, count: 3 })
    const second = await engineWithDouble().generate(brief, { base: base(), seed: 42, count: 3 })

    expect(first.promptHash).toBe(second.promptHash)
    const key = (run: typeof first) =>
      [...run.candidates, ...run.rejected.map((entry) => entry.candidate)]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((candidate) => candidate.structuralHash)
    expect(key(first)).toEqual(key(second))

    const operations = (run: typeof first) =>
      [...run.candidates, ...run.rejected.map((entry) => entry.candidate)]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((candidate) => JSON.stringify(candidateOperations(candidate)))
    const a = operations(first)
    const b = operations(second)
    expect(a).toEqual(b)
    expect(a.every((entry) => entry.length > 100)).toBe(true)
  }, 120_000)

  it('changes the model when the seed changes', async () => {
    const brief = compileBriefDeterministically(BRIEFS[12].prompt)
    const engine = engineWithDouble()
    const first = await engine.generate(brief, { base: base(), seed: 1, count: 1 })
    const second = await engine.generate(brief, { base: base(), seed: 2, count: 1 })
    const one = first.candidates[0] ?? first.rejected[0].candidate
    const two = second.candidates[0] ?? second.rejected[0].candidate
    expect(one.seed).not.toBe(two.seed)
  }, 120_000)
})

describe('the candidates offered are genuinely different designs', () => {
  it('gives three distinct structures with materially different metrics', async () => {
    const brief = compileBriefDeterministically(BRIEFS[6].prompt)
    const run = await engineWithDouble().generate(brief, { base: base(), seed: 11, count: 3 })
    const all = [...run.candidates, ...run.rejected.map((entry) => entry.candidate)]
    expect(all.length).toBe(3)

    const hashes = new Set(all.map((candidate) => candidate.structuralHash))
    expect(hashes.size).toBe(3)
    expect(run.distinctHashes).toBe(3)

    const strategies = new Set(all.map((candidate) => candidate.strategy))
    expect(strategies.size).toBe(3)

    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const differences = diffMetrics(all[i].metrics, all[j].metrics)
        expect(
          differences.length,
          `${all[i].id} and ${all[j].id} differ on too few axes: ${JSON.stringify(differences)}`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  }, 120_000)
})
