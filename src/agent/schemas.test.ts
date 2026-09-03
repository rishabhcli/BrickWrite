import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SHARED_CAPABILITIES, SHARED_MUTATION_CAPABILITIES, planSharedMutation } from '../cad/capabilities'
import { cadEngine } from '../cad/engine'
import { createRoverDocument } from '../cad/__fixtures__/rover'
import { advertisedFields, capabilityJsonSchema, capabilitySchema, mutationSchema, parseCapabilityArgs } from './schemas'

/**
 * The parity gate.
 *
 * A capability added to the shared catalog without a runtime schema would be
 * advertised to the agent and then validated by nothing, which is the exact
 * failure mode `action_mutate` had before. These tests fail the build instead.
 */
describe('capability schema parity', () => {
  it('gives every advertised mutation capability a runtime schema', () => {
    expect(SHARED_MUTATION_CAPABILITIES.length).toBeGreaterThan(20)
    const missing = SHARED_MUTATION_CAPABILITIES.filter((capability) => !capabilitySchema(capability.id))
    expect(missing.map((capability) => capability.id)).toEqual([])
  })

  it('gives every capability — read or mutate — a runtime schema', () => {
    const missing = SHARED_CAPABILITIES.filter((capability) => !capabilitySchema(capability.id))
    expect(missing.map((capability) => capability.id)).toEqual([])
  })

  it.each(SHARED_CAPABILITIES.map((capability) => [capability.id, capability] as const))(
    'enforces exactly what %s advertises',
    (_id, capability) => {
      const json = capabilityJsonSchema(capability.id) as {
        type: string
        properties?: Record<string, unknown>
        required?: string[]
        additionalProperties?: boolean
      }
      expect(json.type).toBe('object')
      // Strict objects: an undeclared key is a mistake the agent should be told
      // about, not one the gateway quietly discards.
      expect(json.additionalProperties).toBe(false)

      const enforced = new Set(Object.keys(json.properties ?? {}))
      const required = new Set(json.required ?? [])
      const advertised = advertisedFields(capability)

      // Every field the prose contract names is a field the schema enforces...
      for (const field of advertised) expect(enforced.has(field.name), `${capability.id}.${field.name} is advertised but unenforced`).toBe(true)
      // ...and the schema enforces nothing it does not advertise.
      for (const name of enforced) {
        expect(
          advertised.some((field) => field.name === name),
          `${capability.id}.${name} is enforced but not advertised`,
        ).toBe(true)
      }
      // Requiredness agrees in both directions.
      for (const field of advertised) {
        expect(required.has(field.name), `${capability.id}.${field.name} requiredness disagrees`).toBe(field.required)
      }
    },
  )

  it('exposes the same declaration through every surface', () => {
    // capabilities_help, capability_search and the gateway all read this one
    // object; deriving JSON Schema twice must produce the same document.
    for (const capability of SHARED_CAPABILITIES) {
      const direct = z.toJSONSchema(mutationSchema(capability.id as never), { io: 'input' })
      expect(capabilityJsonSchema(capability.id)).toEqual(direct)
    }
  })
})

describe('capability argument parsing', () => {
  it('rejects an unknown capability by name', () => {
    const result = parseCapabilityArgs('demolish_everything', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('demolish_everything')
    expect(result.error.repair).toContain('capability_search')
  })

  it('rejects a misspelled field instead of silently defaulting it', () => {
    const result = parseCapabilityArgs('build_wall', { lengthStud: 8, courses: 3 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.issues.length).toBeGreaterThan(0)
  })

  it('rejects an out-of-range value with the field named', () => {
    const result = parseCapabilityArgs('linear_array', { copies: 400, offsetLdu: [20, 0, 0] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('copies')
  })

  it('rejects a non-finite coordinate', () => {
    expect(parseCapabilityArgs('duplicate_selection', { offsetLdu: [0, Number.NaN, 0] }).ok).toBe(false)
  })

  it('accepts the arguments the planner documents and hands them through unchanged', () => {
    const result = parseCapabilityArgs('build_wall', { lengthStuds: 8, courses: 3, axis: 'x', family: 'brick' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args).toEqual({ lengthStuds: 8, courses: 3, axis: 'x', family: 'brick' })
  })

  it('produces arguments the shared planner actually accepts', () => {
    cadEngine.replaceDocument(createRoverDocument())
    const state = cadEngine.getSnapshot()
    const parsed = parseCapabilityArgs('rename_document', { name: 'Parity check' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const plan = planSharedMutation('rename_document', parsed.args, {
      document: state.document,
      selection: state.selection,
      actor: 'agent',
    })
    expect(plan.operations).toEqual([{ type: 'document.rename', name: 'Parity check' }])
  })
})
