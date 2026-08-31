import { describe, expect, it, vi } from 'vitest'
import { catalog } from './catalog'
import { planCrane, planLattice, planSnotHull, planClockFaces, type AssemblyPlan } from './assembly'
import { CadEngine } from './engine'
import { createBlankDocument } from './sample'
import { validateDocument } from './validation'
import { findArticulatedJoints } from './articulation'
import { planSharedMutation, type SharedMutationId } from './capabilities'
import { parseCapabilityArgs } from '../agent/schemas'
import { deriveConnections } from './snapping'

function commit(plan: AssemblyPlan) {
  const engine = new CadEngine(createBlankDocument('Mechanism'))
  const result = engine.execute('Mechanism', plan.operations, 'human', engine.getSnapshot().document.revision)
  expect(result.ok, JSON.stringify(result.ok ? '' : result.error)).toBe(true)
  const doc = engine.getSnapshot().document
  const report = validateDocument(doc)
  expect(report.collisions).toEqual([])
  expect(report.componentCount).toBe(1)
  return doc
}

describe('mechanism assembly plans through real transaction gates', () => {
  it.each([2, 6, 12])('crane boom %s is connected and articulated', (boomStuds) => {
    const doc = commit(planCrane({ boomStuds }))
    const moving = Object.values(doc.parts).filter(p => p.definitionId === '3938').map(p => p.id)
    expect(findArticulatedJoints(doc, moving).length).toBeGreaterThan(0)
  })
  it.each([[5, 5, 2], [7, 5, 2], [7, 7, 3]])('orthogonal lattice %s × %s / bay %s', (widthStuds, depthStuds, bayStuds) => {
    commit(planLattice({ widthStuds, depthStuds, bayStuds, heightCourses: 3 }))
  })
  it.each([1, 2])('SNOT hull has connected sideways skin layers=%s', (layers) => {
    const doc = commit(planSnotHull({ widthStuds: 6, depthStuds: 5, layers }))
    expect(deriveConnections(doc).pairs.some(pair => {
      const a = doc.parts[pair.a.partId]; const b = doc.parts[pair.b.partId]
      return [a.definitionId, b.definitionId].includes('87087') && [a.definitionId, b.definitionId].includes('3024')
    })).toBe(true)
  })
  it.each([4, 8, 16])('four clock faces diameter=%s have articulated hands', (diameterStuds) => {
    const doc = commit(planClockFaces({ diameterStuds }))
    const moving = Object.values(doc.parts).filter(p => p.definitionId === '3938').map(p => p.id)
    expect(moving).toHaveLength(4)
    for (const id of moving) expect(findArticulatedJoints(doc, [id]).length).toBeGreaterThan(0)
  })
  it('missing geometry is an id-specific error, never a partial ghost plan', () => {
    const get = catalog.get.bind(catalog)
    const spy = vi.spyOn(catalog, 'get').mockImplementation(id => id === '3938' ? undefined : get(id))
    try { expect(() => planCrane({ boomStuds: 4 })).toThrow('GEOMETRY_UNAVAILABLE: 3938') } finally { spy.mockRestore() }
  })
  it('rejects fractional, unbounded and nonconforming inputs', () => {
    expect(() => planCrane({ boomStuds: NaN })).toThrow()
    expect(() => planCrane({ boomStuds: 4.5 })).toThrow()
    expect(() => planLattice({ widthStuds: 6, depthStuds: 5, heightCourses: 3, bayStuds: 2 })).toThrow()
    expect(() => planSnotHull({ widthStuds: 5, depthStuds: 5, layers: 3 })).toThrow()
  })
})

const mechanismCases: Array<[SharedMutationId, Record<string, unknown>]> = [
  ['build_crane', { boomStuds: 6 }],
  ['build_lattice', { widthStuds: 5, depthStuds: 5, heightCourses: 3, bayStuds: 2 }],
  ['build_snot_hull', { widthStuds: 6, depthStuds: 5, layers: 2 }],
  ['build_clock_faces', { diameterStuds: 8 }],
]

describe('shared mechanism capabilities and strict contracts', () => {
  it.each(mechanismCases)('%s validates and commits for an agent', (capability, args) => {
    const parsed = parseCapabilityArgs(capability, args)
    expect(parsed.ok).toBe(true)
    expect(parseCapabilityArgs(capability, { ...args, typo: 1 }).ok).toBe(false)
    const engine = new CadEngine(createBlankDocument('Shared mechanism'))
    engine.setAutonomy('build')
    const before = engine.getSnapshot().document
    const plan = planSharedMutation(capability, args, { document: before, selection: [], actor: 'agent' })
    const result = engine.execute(plan.label, plan.operations, 'agent', before.revision)
    expect(result.ok, JSON.stringify(result.ok ? '' : result.error)).toBe(true)
    const report = validateDocument(engine.getSnapshot().document)
    expect(report.collisions).toEqual([])
    expect(report.componentCount).toBe(1)
  })
  it.each([
    ['crane', () => planCrane({ boomStuds: 6 })],
    ['clock', () => planClockFaces({ diameterStuds: 8 })],
  ] as const)('%s really drives its hand/boom through the transaction gate', (_, makePlan) => {
    const engine = new CadEngine(createBlankDocument('Drive'))
    expect(engine.execute('Build', makePlan().operations, 'human', engine.getSnapshot().document.revision).ok).toBe(true)
    const before = engine.getSnapshot().document
    const selection = Object.values(before.parts).filter(p => p.definitionId === '3938').slice(0, 1).map(p => p.id)
    const joint = findArticulatedJoints(before, selection)[0]
    expect(joint.movingPartIds.length).toBeGreaterThan(1)
    const plan = planSharedMutation('articulate_joint', { edgeId: joint.edgeId, rotateDegrees: _ === 'crane' ? -90 : 90 }, { document: before, selection, actor: 'human' })
    const applied = engine.execute('Drive', plan.operations, 'human', before.revision)
    expect(applied.ok, JSON.stringify(applied.ok ? '' : applied.error)).toBe(true)
    const after = engine.getSnapshot().document
    expect(validateDocument(after).collisions).toEqual([])
    expect(validateDocument(after).componentCount).toBe(1)
    expect(after.parts[selection[0]].transform).not.toEqual(before.parts[selection[0]].transform)
    for (const id of Object.keys(before.parts)) if (!joint.movingPartIds.includes(id)) expect(after.parts[id].transform).toEqual(before.parts[id].transform)
  })
  it('preserves the missing-geometry code through the capability adapter', () => {
    const get = catalog.get.bind(catalog)
    const spy = vi.spyOn(catalog, 'get').mockImplementation(id => id === '87087' ? undefined : get(id))
    try {
      expect(() => planSharedMutation('build_snot_hull', { widthStuds: 5, depthStuds: 5, layers: 1 }, {
        document: createBlankDocument('Missing'), selection: [], actor: 'agent',
      })).toThrowError(expect.objectContaining({ code: 'GEOMETRY_UNAVAILABLE', details: { definitionId: '87087' } }))
    } finally { spy.mockRestore() }
  })
})
