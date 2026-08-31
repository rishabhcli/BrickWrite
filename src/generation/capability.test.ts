import { describe, expect, it } from 'vitest'
import { planSharedMutation, SharedCapabilityError, sharedCapability } from '../cad/capabilities'
import { createBlankDocument } from '../cad/sample'
import type { ModelDocument } from '../cad/types'
import './capability'

const context = (document: ModelDocument) => ({ document, selection: [] as string[], actor: 'agent' as const })

const SHOP = 'A three-storey shop 20 x 16 studs, 18 studs tall, with a door'

describe('generate_from_brief', { timeout: 30_000 }, () => {
  it('is in the shared vocabulary, so capability_search can find it', () => {
    expect(sharedCapability('generate_from_brief')).toMatchObject({ kind: 'mutate', group: 'assemble' })
    expect(sharedCapability('generate_region')).toMatchObject({ kind: 'mutate' })
  })

  it('turns one sentence into a whole bonded model in one plan', () => {
    const plan = planSharedMutation('generate_from_brief', { prompt: SHOP }, context(createBlankDocument('Generated')))
    expect(plan.capability).toBe('generate_from_brief')
    expect(plan.label).toMatch(/^Generated: /)

    // The point of the whole workstream: one plan, hundreds of parts. A tool
    // that produced a handful would mean the agent still has to brick-lay.
    const added = plan.operations.filter((operation) => operation.type === 'part.add')
    expect(added.length).toBeGreaterThan(40)
    expect(plan.report).toMatchObject({ collisions: 0, components: 1 })
  })

  it('sends a caller who wants a model to the tool that has one', () => {
    expect(() => planSharedMutation('generate_from_brief', { prompt: SHOP, useModel: true }, context(createBlankDocument())))
      .toThrow(SharedCapabilityError)
    try {
      planSharedMutation('generate_from_brief', { prompt: SHOP, useModel: true }, context(createBlankDocument()))
    } catch (cause) {
      expect((cause as SharedCapabilityError).repair).toMatch(/generation_run/)
    }
  })

  it('refuses an empty prompt rather than planning an empty wave', () => {
    expect(() => planSharedMutation('generate_from_brief', { prompt: '   ' }, context(createBlankDocument())))
      .toThrow(SharedCapabilityError)
  })
})

describe('generate_region', { timeout: 30_000 }, () => {
  /** A flat 24 x 24 slab: something with a real top surface to build onto. */
  const seeded = () => {
    const base = createBlankDocument('Region base')
    const plan = planSharedMutation('build_field', { widthStuds: 24, depthStuds: 24, layers: 2 }, context(base))
    const parts = { ...base.parts }
    for (const operation of plan.operations) if (operation.type === 'part.add') parts[operation.part.id] = operation.part
    return { ...base, parts, revision: base.revision + 1 }
  }

  /** The part nearest the slab's minimum corner, so an 8-stud region fits on it. */
  const cornerPart = (document: ReturnType<typeof seeded>) =>
    Object.keys(document.parts).reduce((best, id) => {
      const here = document.parts[id].transform.position
      const there = document.parts[best].transform.position
      return here[1] < there[1] || (here[1] === there[1] && here[0] + here[2] < there[0] + there[2]) ? id : best
    })

  it('adds to a model without touching what is already there', () => {
    const document = seeded()
    const existing = Object.keys(document.parts)
    expect(existing.length).toBeGreaterThan(40)
    const anchorPartId = cornerPart(document)
    const plan = planSharedMutation(
      'generate_region',
      { prompt: 'A crane deck 8 x 8 studs, 6 studs tall', anchorPartId, envelopeStuds: [8, 6, 8] },
      context(document),
    )

    const added = plan.operations.filter((operation) => operation.type === 'part.add')
    expect(added.length).toBeGreaterThan(0)
    // Nothing removed, nothing moved, nothing recoloured: a region adds parts
    // and the assemblies to hold them, or it is a refusal. No operation may
    // name a part that was already there.
    expect(plan.operations.every((operation) => operation.type === 'part.add' || operation.type === 'subassembly.add')).toBe(true)
    expect(plan.operations.some((operation) => 'partId' in operation && existing.includes(operation.partId))).toBe(false)
    expect(added.some((operation) => operation.type === 'part.add' && existing.includes(operation.part.id))).toBe(false)
    expect(plan.report).toMatchObject({ anchorPartId, protectedPartIds: existing.length, parts: added.length })
  })

  it('refuses a region buried inside the model rather than reporting an empty success', () => {
    const base = createBlankDocument('Buried region')
    const shop = planSharedMutation('generate_from_brief', { prompt: SHOP }, context(base))
    const parts = { ...base.parts }
    for (const operation of shop.operations) if (operation.type === 'part.add') parts[operation.part.id] = operation.part
    const document = { ...base, parts, revision: base.revision + 1 }

    // The lowest part of a three-storey building: the space above it is the
    // building.
    const buried = Object.keys(document.parts).reduce((lowest, id) =>
      document.parts[id].transform.position[1] > document.parts[lowest].transform.position[1] ? id : lowest,
    )
    expect(() =>
      planSharedMutation(
        'generate_region',
        { prompt: 'A crane deck 8 x 8 studs, 6 studs tall', anchorPartId: buried, envelopeStuds: [8, 6, 8] },
        context(document),
      ),
    ).toThrow(/collided with the model already there/)
  })
})
