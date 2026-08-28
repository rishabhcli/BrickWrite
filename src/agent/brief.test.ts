import { describe, expect, it } from 'vitest'
import fixtures from './__fixtures__/prompts.json'
import { compileBrief, briefProvenance, editBrief, refineBriefWithModel, resolveConflict, BriefRefinementSchema } from './brief'
import type { DesignBrief, ModelProvider, ModelRequest, ModelResult } from '../platform/contracts'

interface PromptFixture {
  id: string
  prompt: string
  expectConflicts: boolean
  expect: {
    subjectContains?: string
    envelopeStuds?: [number, number, number]
    scale?: DesignBrief['scale']
    paletteIncludes?: number[]
    styleIncludes?: string[]
    hasFunctions?: boolean
    partBudget?: number
    symmetry?: DesignBrief['symmetry']
    conflictFields?: string[]
    protectedIncludes?: string[]
  }
}

const prompts = (fixtures as { prompts: PromptFixture[] }).prompts

describe('design brief fixtures', () => {
  it('covers at least thirty varied requests', () => {
    expect(prompts.length).toBeGreaterThanOrEqual(30)
    expect(prompts.filter((fixture) => fixture.expectConflicts).length).toBeGreaterThanOrEqual(8)
  })

  it.each(prompts.map((fixture) => [fixture.id, fixture] as const))('compiles %s deterministically', (_id, fixture) => {
    const first = compileBrief(fixture.prompt)
    const second = compileBrief(fixture.prompt)
    // Stability is the whole reason the compiler exists: an operator editing a
    // brief must be editing the same brief they saw a moment ago.
    expect(second).toEqual(first)
    expect(briefProvenance(fixture.prompt)).toEqual(briefProvenance(fixture.prompt))
    expect(first.version).toBe(1)
    expect(first.subject.length).toBeGreaterThan(0)
  })

  it.each(prompts.map((fixture) => [fixture.id, fixture] as const))('extracts the stated fields of %s', (_id, fixture) => {
    const brief = compileBrief(fixture.prompt)
    const wanted = fixture.expect

    if (wanted.subjectContains) expect(brief.subject.toLowerCase()).toContain(wanted.subjectContains)
    if (wanted.envelopeStuds) expect(brief.envelopeStuds).toEqual(wanted.envelopeStuds)
    if (wanted.scale) expect(brief.scale).toBe(wanted.scale)
    if (wanted.partBudget !== undefined) expect(brief.partBudget).toBe(wanted.partBudget)
    if (wanted.symmetry) expect(brief.symmetry).toBe(wanted.symmetry)
    if (wanted.hasFunctions) expect(brief.functions.length).toBeGreaterThan(0)
    for (const color of wanted.paletteIncludes ?? []) expect(brief.palette).toContain(color)
    for (const style of wanted.styleIncludes ?? []) expect(brief.style).toContain(style)
    for (const partId of wanted.protectedIncludes ?? []) expect(brief.protectedPartIds).toContain(partId)
  })

  it.each(prompts.map((fixture) => [fixture.id, fixture] as const))('reports ambiguity in %s honestly', (_id, fixture) => {
    const brief = compileBrief(fixture.prompt)
    if (fixture.expectConflicts) {
      expect(brief.conflicts.length).toBeGreaterThan(0)
      for (const field of fixture.expect.conflictFields ?? []) {
        expect(brief.conflicts.map((conflict) => conflict.field)).toContain(field)
      }
      // A conflict has to be actionable, not a shrug.
      for (const conflict of brief.conflicts) expect(conflict.detail.length).toBeGreaterThan(20)
    } else {
      expect(brief.conflicts).toEqual([])
    }
  })

  it('records the phrase behind every field it filled', () => {
    const brief = compileBrief('A symmetrical 24 x 24 stud minifig scale fire station in red under 300 pieces.')
    expect(brief.evidence.envelopeStuds).toBeTruthy()
    expect(brief.evidence.scale).toBeTruthy()
    expect(brief.evidence.palette).toBeTruthy()
    expect(brief.evidence.partBudget).toBeTruthy()
    expect(brief.evidence.symmetry).toBeTruthy()
  })

  it('never invents a value the request did not contain', () => {
    const brief = compileBrief('A house.')
    expect(brief.envelopeStuds).toBeNull()
    expect(brief.partBudget).toBeNull()
    expect(brief.scale).toBe('unspecified')
    expect(brief.palette).toEqual([])
    expect(brief.functions).toEqual([])
  })

  it('treats a two-number size as a footprint with an unconstrained height', () => {
    expect(compileBrief('A 48 x 48 baseplate scene').envelopeStuds).toEqual([48, 0, 48])
  })
})

describe('brief editing', () => {
  it('records that the operator set a field', () => {
    const brief = compileBrief('A house.')
    const edited = editBrief(brief, { partBudget: 250 })
    expect(edited.partBudget).toBe(250)
    expect(edited.evidence.partBudget).toBe('set by the operator')
    // The original is untouched: editing is not mutation.
    expect(brief.partBudget).toBeNull()
  })

  it('resolves a conflict by recording the decision that closed it', () => {
    const brief = compileBrief('Build me a car or a truck.')
    expect(brief.conflicts.length).toBe(1)
    const resolved = resolveConflict(brief, 0, 'Car')
    expect(resolved.conflicts).toEqual([])
    expect(resolved.evidence['subject.decision']).toBe('Car')
  })
})

// A deterministic double of the ModelProvider seam. Doubles exist only here;
// runtime always talks to the real provider through the API process.
function scriptedProvider(value: unknown, options: { failFirst?: boolean } = {}): ModelProvider & { calls: number } {
  let calls = 0
  return {
    id: 'test-double',
    model: 'scripted',
    get calls() {
      return calls
    },
    async complete<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      calls += 1
      const raw = options.failFirst && calls === 1 ? { nonsense: true } : value
      return {
        value: request.parse(raw),
        provenance: { provider: 'test-double', model: 'scripted', promptHash: 'fnv1a:0', seed: 0, createdAt: '1970-01-01T00:00:00.000Z' },
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    },
  }
}

describe('model-assisted refinement', () => {
  const refinement = {
    subject: 'harbour crane',
    functions: ['the jib rotates'],
    style: ['industrial'],
    scale: 'minifig' as const,
    ambiguities: [{ field: 'palette', detail: 'No colour was stated; the generator will pick one unless you set a palette.' }],
  }

  it('fills only the fields the deterministic pass left empty', async () => {
    const base = compileBrief('A harbour crane.')
    expect(base.functions).toEqual([])
    const result = await refineBriefWithModel('A harbour crane.', base, scriptedProvider(refinement))
    expect(result.brief.functions).toEqual(['the jib rotates'])
    expect(result.brief.style).toEqual(['industrial'])
    expect(result.brief.scale).toBe('minifig')
    expect(result.brief.evidence.functions).toContain('model')
    expect(result.usage.inputTokens).toBe(10)
  })

  it('never silently overrides a field the request stated', async () => {
    const base = compileBrief('A microscale harbour crane whose jib rotates.')
    expect(base.scale).toBe('micro')
    const result = await refineBriefWithModel('A microscale harbour crane whose jib rotates.', base, scriptedProvider(refinement))
    expect(result.brief.scale).toBe('micro')
    expect(result.brief.conflicts.map((conflict) => conflict.field)).toContain('scale')
    expect(result.brief.conflicts.some((conflict) => conflict.detail.includes('minifig'))).toBe(true)
  })

  it('surfaces the model’s own ambiguities as editable conflicts', async () => {
    const base = compileBrief('A harbour crane.')
    const result = await refineBriefWithModel('A harbour crane.', base, scriptedProvider(refinement))
    expect(result.brief.conflicts.map((conflict) => conflict.field)).toContain('palette')
  })

  it('rejects a refinement that violates the schema instead of coercing it', async () => {
    const base = compileBrief('A harbour crane.')
    await expect(
      refineBriefWithModel('A harbour crane.', base, scriptedProvider({ subject: 42 })),
    ).rejects.toThrow()
    expect(BriefRefinementSchema.safeParse({ subject: 42 }).success).toBe(false)
  })
})
