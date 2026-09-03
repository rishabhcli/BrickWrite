import { describe, expect, it } from 'vitest'
import { IDENTITY_BASIS } from './math'
import { inspectModelHealth } from './modelHealth'
import {createEmptyDocument} from './sample'
import { createRoverDocument } from './__fixtures__/rover'
import type { ModelDocument, PartInstance } from './types'
import { validateDocument } from './validation'

const part = (id: string, position: [number, number, number], color = 15): PartInstance => ({
  id,
  definitionId: '3001',
  color,
  transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

function withParts(...parts: PartInstance[]): ModelDocument {
  const base = createEmptyDocument()
  return {
    ...base,
    parts: Object.fromEntries(parts.map((item) => [item.id, item])),
    subassemblies: {
      ...base.subassemblies,
      hull: { ...base.subassemblies.hull, partIds: parts.map((item) => item.id) },
    },
  }
}

describe('shared model health', () => {
  it('turns the real showcase kernel report into stable checks without inventing blockers', () => {
    const document = createRoverDocument()
    const validation = validateDocument(document)
    const health = inspectModelHealth(document, validation)

    expect(health.revision).toBe(document.revision)
    expect(health.blockers).toBe(0)
    expect(health.metrics).toMatchObject({
      parts: validation.partCount,
      connections: validation.connectionCount,
      massCoverage: expect.any(Number),
    })
    expect(health.checks.map((check) => check.id)).toEqual([
      'collision',
      'connections',
      'balance',
      'clutch',
      'constraints',
      'evidence',
    ])
  })

  it('preserves collision certainty, exact part ids, evidence, and repair guidance', () => {
    const document = withParts(part('a', [0, 0, 0]), part('b', [20, 0, 0]))
    const validation = validateDocument(document, { provideGeometry: () => null })
    const health = inspectModelHealth(document, validation)
    const collision = health.issues.find((issue) => issue.kind === 'collision')

    expect(collision).toMatchObject({
      id: expect.stringMatching(/^collision:/),
      severity: 'warning',
      title: 'Unverified overlap',
      partIds: ['a', 'b'],
    })
    expect(collision?.evidence).toContain('unknown')
    expect(collision?.repair).toContain('Load both meshes')
  })

  it('maps a failed palette constraint to the exact violating parts', () => {
    const document = withParts(part('allowed', [0, 0, 0], 4), part('wrong', [400, 0, 0], 15))
    document.constraints = [{
      id: 'palette_build',
      kind: 'palette',
      label: 'Build palette',
      value: [4],
      hard: true,
    }]
    const health = inspectModelHealth(document, validateDocument(document))
    const constraint = health.issues.find((issue) => issue.id === 'constraint:palette_build')

    expect(constraint).toMatchObject({
      severity: 'blocker',
      title: 'Build palette',
      partIds: ['wrong'],
    })
    expect(health.blockers).toBeGreaterThanOrEqual(1)
    expect(health.ready).toBe(false)
  })

  it('distinguishes a grounded second model from an airborne connected island', () => {
    const document = withParts(
      part('ground', [0, 0, 0]),
      part('air_a', [400, -200, 0]),
      part('air_b', [400, -224, 0]),
    )
    const health = inspectModelHealth(document, validateDocument(document))
    const grounding = health.issues.find((issue) => issue.id === 'grounding:airborne')

    expect(grounding).toMatchObject({
      severity: 'warning',
      partIds: ['air_a', 'air_b'],
    })
  })
})
