import { describe, expect, it } from 'vitest'
import {
  chooseElement,
  courseSpans,
  elementLibrary,
  familyLibrary,
  paneFor,
  planHingedFlap,
  planBrickField,
  planCourse,
  planEnclosure,
  planWall,
  resolveOpening,
  seamsOf,
  type AssemblyPlan,
} from './assembly'
import { findArticulatedJoints } from './articulation'
import { planSharedMutation, SHARED_MUTATION_CAPABILITIES } from './capabilities'
import { captureModule, documentModules, stampModule } from './modules'
import { STUD_LDU } from './catalog'
import { CadEngine } from './engine'
import { getPartBounds } from './geometry'
import { createBlankDocument } from './sample'
import { validateDocument } from './validation'
import type { CadOperation, ModelDocument } from './types'

/**
 * These tests check the property that matters, not the call.
 *
 * "It placed 148 parts" is worthless if the courses are stacked in columns and
 * the walls fall apart. What is asserted here is what makes a generated wall a
 * wall: exact coverage, staggered seams, no collisions, and one connected
 * structure — verified through the same kernel a human edit goes through.
 */

const base = {
  origin: [0, 0, 0] as [number, number, number],
  color: 71,
  subassemblyId: 'main',
  stepId: 'step_1',
  actor: 'human' as const,
}

const partIds = (plan: AssemblyPlan): string[] =>
  plan.operations
    .filter((operation): operation is Extract<CadOperation, { type: 'part.add' }> => operation.type === 'part.add')
    .map((operation) => operation.part.definitionId)

/** Applies a plan to a blank document through the real engine. */
function commit(plan: AssemblyPlan): { document: ModelDocument; engine: CadEngine } {
  const engine = new CadEngine(createBlankDocument('Generated'))
  const result = engine.execute('Generated assembly', plan.operations as CadOperation[], 'human', engine.getSnapshot().document.revision)
  if (!result.ok) throw new Error(`The kernel refused the generated assembly: ${JSON.stringify(result.error)}`)
  return { document: engine.getSnapshot().document, engine }
}

describe('the part library is derived from measured shape', () => {
  it('finds a run of brick lengths including a single stud', () => {
    const library = familyLibrary('brick', 1)!
    expect(library).toBeTruthy()
    expect(library.lengths).toContain(1)
    expect(Math.max(...library.lengths)).toBeGreaterThan(3)
    // Descending, so the greedy cover reaches for the longest part first.
    expect([...library.lengths]).toEqual([...library.lengths].sort((a, b) => b - a))
  })

  it('measures the course pitch rather than assuming 24 LDU', () => {
    expect(familyLibrary('brick', 1)!.courseLdu).toBe(24)
    expect(familyLibrary('plate', 1)!.courseLdu).toBe(8)
  })

  it('picks the everyday part where several share a footprint', () => {
    // 3004 "Brick 1 x 2" is far more common than 3065 "without Bottom Tube".
    expect(familyLibrary('brick', 1)!.definitionFor(2)?.canonicalId).toBe('3004')
  })

  it('reports nothing for a family this build cannot lay', () => {
    expect(familyLibrary('brick', 7)).toBeNull()
  })
})

describe('course partitioning', () => {
  const lengths = [8, 6, 4, 3, 2, 1]

  it('covers a run exactly', () => {
    for (const run of [1, 2, 5, 7, 13, 16, 23, 40]) {
      const plan = planCourse(run, lengths, new Set())
      expect(plan.exact).toBe(true)
      expect(plan.parts.reduce((sum, value) => sum + value, 0)).toBe(run)
    }
  })

  it('staggers against the course below', () => {
    const first = planCourse(16, lengths, new Set())
    const second = planCourse(16, lengths, new Set(seamsOf(first.parts)))
    expect(second.sharedSeams).toBe(0)
    // Not merely different — no seam in common at all, which is the bond.
    const shared = seamsOf(second.parts).filter((seam) => seamsOf(first.parts).includes(seam))
    expect(shared).toEqual([])
  })

  it('is deterministic', () => {
    const previous = new Set([4, 8])
    expect(planCourse(16, lengths, previous)).toEqual(planCourse(16, lengths, previous))
  })

  it('reports the shortfall instead of hiding it when no stagger is possible', () => {
    // A single-stud run has one part and therefore no interior seam to move.
    const plan = planCourse(1, [1], new Set([1]))
    expect(plan.parts).toEqual([1])
    expect(plan.sharedSeams).toBe(0)
  })
})

describe('openings', () => {
  it('cuts a span out of the courses it crosses and leaves the others whole', () => {
    const openings = [{ atStud: 4, widthStuds: 4, fromCourse: 0, toCourse: 1 }]
    expect(courseSpans(16, 0, openings)).toEqual([{ from: 0, to: 4 }, { from: 8, to: 16 }])
    expect(courseSpans(16, 2, openings)).toEqual([{ from: 0, to: 16 }])
  })

  it('merges overlapping openings rather than double-cutting', () => {
    const openings = [
      { atStud: 4, widthStuds: 4, fromCourse: 0, toCourse: 0 },
      { atStud: 6, widthStuds: 4, fromCourse: 0, toCourse: 0 },
    ]
    expect(courseSpans(16, 0, openings)).toEqual([{ from: 0, to: 4 }, { from: 10, to: 16 }])
  })

  it('clamps an opening wider than the wall instead of producing a negative span', () => {
    expect(courseSpans(8, 0, [{ atStud: -4, widthStuds: 40, fromCourse: 0, toCourse: 0 }])).toEqual([])
  })
})

describe('a generated wall', () => {
  const plan = planWall({ ...base, axis: 'x', lengthStuds: 16, courses: 4 })

  it('is one transaction of many parts', () => {
    expect(plan.partCount).toBeGreaterThan(8)
    expect(plan.operations.every((operation) => operation.type === 'part.add')).toBe(true)
    expect(plan.courses).toBe(4)
  })

  it('is fully bonded, and says so', () => {
    expect(plan.unbondedCourses).toBe(0)
    expect(plan.warnings).toEqual([])
  })

  it('covers exactly the requested footprint', () => {
    const { document } = commit(plan)
    const bounds = Object.values(document.parts).map(getPartBounds)
    const minX = Math.min(...bounds.map((item) => item.min[0]))
    const maxX = Math.max(...bounds.map((item) => item.max[0]))
    expect(maxX - minX).toBe(16 * STUD_LDU)
  })

  it('rises by exactly one course pitch per course, upward', () => {
    const { document } = commit(plan)
    // LDraw is Y-down: a wall that grows upward has decreasing Y. Origins are
    // asserted rather than the bounding box, because the top course's studs
    // protrude 4 LDU above the plane the next course would rest on.
    const levels = [...new Set(Object.values(document.parts).map((part) => part.transform.position[1]))].sort((a, b) => b - a)
    expect(levels).toHaveLength(4)
    expect(levels).toEqual([-24, -48, -72, -96])
    const bounds = Object.values(document.parts).map(getPartBounds)
    expect(Math.max(...bounds.map((item) => item.max[1]))).toBe(0)
  })

  it('passes the kernel\u2019s own collision and connectivity checks', () => {
    const { document } = commit(plan)
    const report = validateDocument(document)
    expect(report.collisions).toEqual([])
    expect(report.unverifiedCollisions).toBe(0)
    // One wall is one thing, not a pile of unattached bricks.
    expect(report.componentCount).toBe(1)
    expect(report.connectionCount).toBeGreaterThan(plan.partCount)
  })

  it('runs along Z when asked, without changing what it builds', () => {
    const along = planWall({ ...base, axis: 'z', lengthStuds: 16, courses: 4 })
    expect(along.partCount).toBe(plan.partCount)
    const { document } = commit(along)
    const bounds = Object.values(document.parts).map(getPartBounds)
    expect(Math.max(...bounds.map((item) => item.max[2])) - Math.min(...bounds.map((item) => item.min[2]))).toBe(16 * STUD_LDU)
    expect(Math.max(...bounds.map((item) => item.max[0])) - Math.min(...bounds.map((item) => item.min[0]))).toBe(STUD_LDU)
  })

  it('leaves a doorway open and closes the courses above it', () => {
    const withDoor = planWall({
      ...base,
      axis: 'x',
      lengthStuds: 16,
      courses: 4,
      openings: [{ atStud: 6, widthStuds: 4, fromCourse: 0, toCourse: 2 }],
    })
    const { document } = commit(withDoor)
    // Nothing occupies the doorway in the courses it cuts through.
    const doorwayCentre = (6 + 2) * STUD_LDU
    const inDoorway = Object.values(document.parts)
      .map(getPartBounds)
      .filter((item) => item.min[0] < doorwayCentre && item.max[0] > doorwayCentre && item.max[1] > -3 * 24)
    expect(inDoorway).toEqual([])
    expect(validateDocument(document).collisions).toEqual([])
  })

  it('refuses a specification it cannot build, with a repair', () => {
    expect(() => planWall({ ...base, axis: 'x', lengthStuds: 0, courses: 4 })).toThrowError(/at least one stud/)
    expect(() => planWall({ ...base, axis: 'x', lengthStuds: 8, courses: 4, depthStuds: 9 })).toThrowError(/no compiled brick parts/)
  })
})

describe('a generated storey', () => {
  const plan = planEnclosure({ ...base, widthStuds: 16, footprintDepthStuds: 12, courses: 4, floor: true })

  it('encloses the footprint on all four sides', () => {
    const { document } = commit(plan)
    const bounds = Object.values(document.parts).map(getPartBounds)
    expect(Math.max(...bounds.map((item) => item.max[0])) - Math.min(...bounds.map((item) => item.min[0]))).toBe(16 * STUD_LDU)
    expect(Math.max(...bounds.map((item) => item.max[2])) - Math.min(...bounds.map((item) => item.min[2]))).toBe(12 * STUD_LDU)
  })

  it('interlocks its corners rather than colliding at them', () => {
    const { document } = commit(plan)
    const report = validateDocument(document)
    expect(report.collisions).toEqual([])
    expect(report.unverifiedCollisions).toBe(0)
  })

  it('holds together as one connected structure', () => {
    const { document } = commit(plan)
    expect(validateDocument(document).componentCount).toBe(1)
  })

  it('lays the floor under the walls so the walls stand on it', () => {
    const withoutFloor = planEnclosure({ ...base, widthStuds: 16, footprintDepthStuds: 12, courses: 4 })
    expect(plan.partCount).toBeGreaterThan(withoutFloor.partCount)
    expect(plan.notes.some((note) => note.startsWith('Floor laid under the walls'))).toBe(true)
    const { document } = commit(plan)
    expect(validateDocument(document).collisions).toEqual([])
    // Every wall brick sits above the deck, never level with it.
    const deckTop = Math.min(...Object.values(document.parts).map((part) => part.transform.position[1]))
    expect(deckTop).toBeLessThan(0)
  })

  it('cross-bonds the deck by default, and says what one layer costs', () => {
    // A single-layer floor is genuinely loose in the middle; the default is the
    // rigid slab, and the cheaper option reports that it is not one.
    const loose = planEnclosure({ ...base, widthStuds: 16, footprintDepthStuds: 12, courses: 4, floor: true, floorLayers: 1 })
    expect(validateDocument(commit(loose).document).componentCount).toBeGreaterThan(1)
    expect(loose.notes.some((note) => note.includes('pass layers: 2'))).toBe(true)
    expect(plan.partCount).toBeGreaterThan(loose.partCount)
  })

  it('bills every part it used, including the floor', () => {
    const total = plan.bill.reduce((sum, entry) => sum + entry.count, 0)
    expect(total).toBe(plan.partCount)
    expect(plan.bill[0].name).toBeTruthy()
  })

  it('refuses a footprint too small for its own walls', () => {
    expect(() => planEnclosure({ ...base, widthStuds: 2, footprintDepthStuds: 2, courses: 2, depthStuds: 2 }))
      .toThrowError(/too small/)
  })
})

describe('a generated floor', () => {
  it('tiles a footprint exactly, with staggered rows and no collisions', () => {
    const plan = planBrickField({ ...base, widthStuds: 16, footprintDepthStuds: 8 })
    const { document } = commit(plan)
    const bounds = Object.values(document.parts).map(getPartBounds)
    expect(Math.max(...bounds.map((item) => item.max[0])) - Math.min(...bounds.map((item) => item.min[0]))).toBe(16 * STUD_LDU)
    expect(Math.max(...bounds.map((item) => item.max[2])) - Math.min(...bounds.map((item) => item.min[2]))).toBe(8 * STUD_LDU)
    expect(validateDocument(document).collisions).toEqual([])
    expect(plan.warnings).toEqual([])
  })

  it('handles an odd depth by falling back to one-deep rows', () => {
    const plan = planBrickField({ ...base, widthStuds: 9, footprintDepthStuds: 5 })
    const { document } = commit(plan)
    const bounds = Object.values(document.parts).map(getPartBounds)
    expect(Math.max(...bounds.map((item) => item.max[2])) - Math.min(...bounds.map((item) => item.min[2]))).toBe(5 * STUD_LDU)
    expect(validateDocument(document).collisions).toEqual([])
  })
})

describe('the shared capability surface', () => {
  const context = (document: ModelDocument, selection: string[] = []) => ({ document, selection, actor: 'agent' as const })

  it('builds a storey from one agent call, and reports what it built', () => {
    const document = createBlankDocument('Tower')
    const plan = planSharedMutation('build_enclosure', { widthStuds: 16, depthStuds: 12, courses: 4, floor: true, color: 4 }, context(document))
    expect(plan.operations.length).toBeGreaterThan(40)
    const report = plan.report as { parts: number; courses: number; runningBond: boolean; bill: Array<{ count: number }> }
    expect(report.runningBond).toBe(true)
    expect(report.courses).toBe(4)
    expect(report.bill.reduce((sum, entry) => sum + entry.count, 0)).toBe(report.parts)
    expect(plan.operations.every((operation) => operation.type === 'part.add' && operation.part.color === 4)).toBe(true)
  })

  it('stacks a selection by its own measured height', () => {
    const engine = new CadEngine(createBlankDocument('Tower'))
    const storey = planSharedMutation('build_enclosure', { widthStuds: 12, depthStuds: 12, courses: 3 }, context(engine.getSnapshot().document))
    engine.execute('Storey', [...storey.operations], 'human', engine.getSnapshot().document.revision)
    const ids = storey.nextSelection as string[]

    const stacked = planSharedMutation('stack_selection', { copies: 2 }, context(engine.getSnapshot().document, ids))
    expect(stacked.operations).toHaveLength(ids.length * 2)
    const pitch = (stacked.report as { pitchLdu: number }).pitchLdu
    // Three brick courses is 72 LDU, and the stack has to land on the plate grid.
    expect(pitch).toBe(72)

    const result = engine.execute('Stack', [...stacked.operations], 'human', engine.getSnapshot().document.revision)
    expect(result.ok).toBe(true)
    const report = validateDocument(engine.getSnapshot().document)
    expect(report.collisions).toEqual([])
    expect(report.componentCount).toBe(1)
  })

  it('refuses to stack a selection it cannot measure', () => {
    const document = createBlankDocument('Empty')
    expect(() => planSharedMutation('stack_selection', { copies: 2 }, context(document, []))).toThrowError(/at least one part/)
  })

  it('keeps generated parts inside the kernel’s ceiling', () => {
    const document = createBlankDocument('Huge')
    expect(() => planSharedMutation('build_enclosure', { widthStuds: 250, depthStuds: 250, courses: 60 }, context(document)))
      .toThrowError(/more than 4000 parts|too small/)
  })

  it('is offered to the human and the agent alike', () => {
    // Parity is a stated invariant of this project, so a generator only one
    // operator can reach would be a defect rather than a feature. Both surfaces
    // read the same registry, so being in it is what makes that true.
    const ids = ['build_wall', 'build_enclosure', 'build_field', 'stack_selection']
    for (const id of ids) {
      const capability = SHARED_MUTATION_CAPABILITIES.find((entry) => entry.id === id)
      expect(capability, `${id} is missing from the shared registry`).toBeTruthy()
      expect(capability!.group).toBe('assemble')
    }
  })
})

describe('openings hold real elements', () => {
  it('seats a window frame whose height it chooses from the pack', () => {
    const plan = planWall({
      ...base,
      axis: 'x',
      lengthStuds: 12,
      courses: 5,
      openings: [{ atStud: 4, widthStuds: 2, fromCourse: 1, toCourse: 3, element: 'window' }],
    })
    const seated = partIds(plan).filter((id) => elementLibrary('window').some((entry) => entry.definition.canonicalId === id))
    expect(seated).toHaveLength(1)
    expect(plan.notes.some((note) => note.includes('with a real frame seated'))).toBe(true)
    expect(plan.warnings).toEqual([])
  })

  it('lets the element set the course span rather than floating in a taller hole', () => {
    const resolved = resolveOpening({ atStud: 2, widthStuds: 2, fromCourse: 1, toCourse: 8, element: 'window' })
    expect(resolved.element).toBeTruthy()
    expect(resolved.opening.toCourse).toBe(1 + resolved.element!.courses - 1)
  })

  it('says so, and cuts a bare hole, when no frame of that width is compiled', () => {
    const plan = planWall({
      ...base,
      axis: 'x',
      lengthStuds: 16,
      courses: 5,
      openings: [{ atStud: 4, widthStuds: 3, fromCourse: 1, toCourse: 3, element: 'window' }],
    })
    expect(plan.warnings.some((warning) => warning.includes('No window frame 3 studs wide'))).toBe(true)
  })

  it('bridges an opening’s edges in the courses above and below it', () => {
    // Without this the two edges of a doorway continue as one unbroken vertical
    // joint through the whole wall, and the run beside it comes away as a
    // separate column. It is invisible until the model is picked up.
    const plan = planWall({
      ...base,
      axis: 'x',
      lengthStuds: 12,
      courses: 5,
      openings: [{ atStud: 4, widthStuds: 2, fromCourse: 1, toCourse: 3 }],
    })
    const { document } = commit(plan)
    const report = validateDocument(document)
    expect(report.componentCount).toBe(1)
    expect(report.collisions).toEqual([])
  })
})

describe('modules', () => {
  const buildStorey = () => {
    const engine = new CadEngine(createBlankDocument('Modules'))
    const plan = planEnclosure({ ...base, widthStuds: 10, footprintDepthStuds: 8, courses: 2 })
    engine.execute('storey', plan.operations as CadOperation[], 'human', engine.getSnapshot().document.revision)
    return { engine, ids: plan.partIds }
  }

  it('captures a selection into its own frame, so it stamps onto the ground', () => {
    const { engine, ids } = buildStorey()
    const module = captureModule(engine.getSnapshot().document, ids, 'Bay', 'human', 'module_bay')
    expect(module.parts).toHaveLength(ids.length)
    // Rebased: the lowest underside is at y = 0, and the minimum corner at x/z = 0.
    const minX = Math.min(...module.parts.map((entry) => entry.transform.position[0]))
    const maxY = Math.max(...module.parts.map((entry) => entry.transform.position[1]))
    expect(minX).toBeGreaterThanOrEqual(0)
    expect(maxY).toBeLessThanOrEqual(0)
    expect(module.sizeLdu[0]).toBe(10 * STUD_LDU)
    expect(module.sizeLdu[2]).toBe(8 * STUD_LDU)
  })

  it('stamps an exact copy that the kernel accepts', () => {
    const { engine, ids } = buildStorey()
    const module = captureModule(engine.getSnapshot().document, ids, 'Bay', 'human', 'module_bay')
    let counter = 0
    const stamped = stampModule(module, { atLdu: [400, 0, 0] }, {
      subassemblyId: 'main', stepId: 'step_1', actor: 'human', nextId: () => `stamp_${counter++}`,
    })
    expect(stamped.parts).toHaveLength(module.parts.length)
    const result = engine.execute('stamp', stamped.parts.map((part) => ({ type: 'part.add', part }) as CadOperation), 'human', engine.getSnapshot().document.revision)
    expect(result.ok).toBe(true)
    const report = validateDocument(engine.getSnapshot().document)
    expect(report.collisions).toEqual([])
    // Two separate buildings, so two components — the stamp did not land on top
    // of the original.
    expect(report.componentCount).toBe(2)
  })

  it('swaps the footprint on a quarter turn and still starts where it was asked', () => {
    const { engine, ids } = buildStorey()
    const module = captureModule(engine.getSnapshot().document, ids, 'Bay', 'human', 'module_bay')
    let counter = 0
    const turned = stampModule(module, { atLdu: [1000, 0, 0], quarterTurns: 1 }, {
      subassemblyId: 'main', stepId: 'step_1', actor: 'human', nextId: () => `turn_${counter++}`,
    })
    expect(turned.footprintLdu[0]).toBe(module.sizeLdu[2])
    expect(turned.footprintLdu[2]).toBe(module.sizeLdu[0])
    const xs = turned.parts.map((part) => part.transform.position[0])
    const zs = turned.parts.map((part) => part.transform.position[2])
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(1000 - STUD_LDU)
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-STUD_LDU)
  })

  it('repeats on a spacing without overlapping itself', () => {
    const { engine, ids } = buildStorey()
    const module = captureModule(engine.getSnapshot().document, ids, 'Bay', 'human', 'module_bay')
    let counter = 0
    const row = stampModule(module, { atLdu: [400, 0, 0], copies: 3, spacingLdu: [module.sizeLdu[0] + STUD_LDU, 0, 0] }, {
      subassemblyId: 'main', stepId: 'step_1', actor: 'human', nextId: () => `row_${counter++}`,
    })
    expect(row.parts).toHaveLength(module.parts.length * 3)
    const result = engine.execute('row', row.parts.map((part) => ({ type: 'part.add', part }) as CadOperation), 'human', engine.getSnapshot().document.revision)
    expect(result.ok).toBe(true)
    expect(validateDocument(engine.getSnapshot().document).collisions).toEqual([])
  })

  it('refuses to capture nothing', () => {
    const document = createBlankDocument('Empty')
    expect(() => captureModule(document, [], 'Bay', 'human', 'm')).toThrowError(/at least one part/)
  })

  it('survives the command bus, and undo takes it back', () => {
    const engine = new CadEngine(createBlankDocument('Modules'))
    const plan = planEnclosure({ ...base, widthStuds: 10, footprintDepthStuds: 8, courses: 2 })
    engine.execute('storey', plan.operations as CadOperation[], 'human', engine.getSnapshot().document.revision)
    const capture = planSharedMutation('capture_module', { name: 'Bay', partIds: plan.partIds }, {
      document: engine.getSnapshot().document, selection: plan.partIds, actor: 'human',
    })
    const committed = engine.execute(capture.label, [...capture.operations], 'human', engine.getSnapshot().document.revision)
    expect(committed.ok).toBe(true)
    expect(documentModules(engine.getSnapshot().document)).toHaveLength(1)
    engine.undo('human')
    expect(documentModules(engine.getSnapshot().document)).toHaveLength(0)
  })
})

describe('a whole building from one instruction', () => {
  const raise = (args: Record<string, unknown>) => {
    const engine = new CadEngine(createBlankDocument('Block'))
    // The human lane, because a fresh engine starts in propose mode and the
    // point of this test is the geometry, not the autonomy gate.
    const plan = planSharedMutation('build_structure', args, {
      document: engine.getSnapshot().document, selection: [], actor: 'human',
    })
    const result = engine.execute(plan.label, [...plan.operations], 'human', engine.getSnapshot().document.revision)
    if (!result.ok) throw new Error(`The kernel refused the building: ${JSON.stringify(result.error)}`)
    return { plan, document: engine.getSnapshot().document }
  }

  it('raises storeys, windows, bands and a roof in one transaction', () => {
    const { plan, document } = raise({ widthStuds: 16, depthStuds: 12, storeys: 3, coursesPerStorey: 6, color: 4, bandColor: 15, windowsPerSide: 2 })
    const report = plan.report as { parts: number; storeys: number; windows: number; doors: number; runningBond: boolean; warnings: string[] }
    expect(report.storeys).toBe(3)
    expect(report.parts).toBeGreaterThan(150)
    expect(report.windows).toBeGreaterThan(3)
    expect(report.doors).toBe(1)
    expect(report.runningBond).toBe(true)
    expect(report.warnings).toEqual([])
    expect(Object.keys(document.parts)).toHaveLength(report.parts)
  })

  it('is one collision-free connected structure, not a stack of separate boxes', () => {
    const { document } = raise({ widthStuds: 16, depthStuds: 12, storeys: 3, coursesPerStorey: 6, color: 4, bandColor: 15 })
    const validation = validateDocument(document)
    expect(validation.collisions).toEqual([])
    expect(validation.unverifiedCollisions).toBe(0)
    expect(validation.componentCount).toBe(1)
  })

  it('grows by exactly one storey pitch per storey', () => {
    const two = raise({ widthStuds: 16, depthStuds: 12, storeys: 2, coursesPerStorey: 4, color: 4, bandColor: 15 })
    const three = raise({ widthStuds: 16, depthStuds: 12, storeys: 3, coursesPerStorey: 4, color: 4, bandColor: 15 })
    const height = (document: ModelDocument) => {
      const bounds = Object.values(document.parts).map(getPartBounds)
      return Math.max(...bounds.map((item) => item.max[1])) - Math.min(...bounds.map((item) => item.min[1]))
    }
    const pitch = (three.plan.report as { storeyPitchLdu: number }).storeyPitchLdu
    expect(height(three.document) - height(two.document)).toBe(pitch)
  })

  it('cuts an honest doorway when no frame fits the storey, and says which', () => {
    const { plan } = raise({ widthStuds: 16, depthStuds: 12, storeys: 1, coursesPerStorey: 4, color: 4 })
    const report = plan.report as { doors: number; notes: string[]; warnings: string[] }
    expect(report.doors).toBe(0)
    expect(report.notes.some((note) => note.includes('open doorway with a lintel'))).toBe(true)
    // Reported as a design choice, not as a failure it could not explain.
    expect(report.warnings).toEqual([])
  })

  it('refuses a building past the per-command ceiling', () => {
    expect(() => raise({ widthStuds: 120, depthStuds: 120, storeys: 20, coursesPerStorey: 10, color: 4 }))
      .toThrowError(/more than 4000 parts|would place/)
  })
})

describe('a flap that opens', () => {
  it('builds a hinge line and a panel that the kernel reads as a joint', () => {
    // Structure is half of what a model does. This is the other half: the
    // kernel already drives joints, and this is the thing that makes one.
    const deck = planBrickField({ ...base, widthStuds: 8, footprintDepthStuds: 6 })
    const flap = planHingedFlap({
      ...base,
      origin: [0, -12, 0],
      widthStuds: 6,
      reachStuds: 4,
    })
    const engine = new CadEngine(createBlankDocument('Flap'))
    const result = engine.execute(
      'flap',
      [...deck.operations, ...flap.operations] as CadOperation[],
      'human',
      engine.getSnapshot().document.revision,
    )
    expect(result.ok, JSON.stringify(result.ok ? '' : result.error)).toBe(true)

    const document = engine.getSnapshot().document
    expect(validateDocument(document).collisions).toEqual([])

    const hinged = Object.values(document.parts).filter((part) => part.definitionId === '3938')
    expect(hinged.length).toBeGreaterThan(0)
    const joints = findArticulatedJoints(document, hinged.map((part) => part.id))
    expect(joints.length).toBeGreaterThan(0)
    expect(joints[0].joint.kind).toBe('revolute')
  })

  it('moves the panel with the hinge, and leaves the deck where it was', () => {
    const deck = planBrickField({ ...base, widthStuds: 8, footprintDepthStuds: 6 })
    const flap = planHingedFlap({ ...base, origin: [0, -12, 0], widthStuds: 6, reachStuds: 4 })
    const engine = new CadEngine(createBlankDocument('Flap'))
    engine.execute('flap', [...deck.operations, ...flap.operations] as CadOperation[], 'human', engine.getSnapshot().document.revision)

    const before = engine.getSnapshot().document
    const hinged = Object.values(before.parts).filter((part) => part.definitionId === '3938').map((part) => part.id)
    const joint = findArticulatedJoints(before, hinged)[0]
    expect(joint).toBeTruthy()
    expect(joint.movingPartIds.length).toBeGreaterThan(1)

    const driven = planSharedMutation('articulate_joint', { edgeId: joint.edgeId, rotateDegrees: 45 }, {
      document: before, selection: hinged, actor: 'human',
    })
    const applied = engine.execute(driven.label, [...driven.operations], 'human', before.revision)
    expect(applied.ok).toBe(true)

    const after = engine.getSnapshot().document
    const moved = joint.movingPartIds.filter(
      (id) => before.parts[id].transform.position.join(',') !== after.parts[id].transform.position.join(','),
    )
    expect(moved.length).toBeGreaterThan(0)
    // Everything outside the moving island stayed exactly where it was.
    const island = new Set(joint.movingPartIds)
    for (const [id, part] of Object.entries(after.parts)) {
      if (island.has(id)) continue
      expect(part.transform.position).toEqual(before.parts[id].transform.position)
    }
  })

  it('rounds an odd hinge line down and says it did', () => {
    const flap = planHingedFlap({ ...base, widthStuds: 5, reachStuds: 2 })
    expect(flap.warnings.some((warning) => warning.includes('laid as 4'))).toBe(true)
  })
})

describe('a window is glazed', () => {
  it('seats a pane that mates to the frame it belongs in', () => {
    const element = chooseElement('window', 2, 2)!
    const pane = paneFor(element)
    expect(pane).toBeTruthy()

    const plan = planWall({
      ...base,
      axis: 'x',
      lengthStuds: 12,
      courses: 5,
      openings: [{ atStud: 4, widthStuds: 2, fromCourse: 1, toCourse: 2, element: 'window' }],
    })
    const { document } = commit(plan)
    const glazing = Object.values(document.parts).find((part) => part.definitionId === pane!.definition.canonicalId)
    expect(glazing).toBeTruthy()
    // Connected, not merely positioned: the pane is part of the model.
    expect(validateDocument(document).componentCount).toBe(1)
    expect(validateDocument(document).collisions).toEqual([])
  })

  it('glazes a wall running along Z as well as one along X', () => {
    const plan = planWall({
      ...base,
      axis: 'z',
      lengthStuds: 12,
      courses: 5,
      openings: [{ atStud: 4, widthStuds: 2, fromCourse: 1, toCourse: 2, element: 'window' }],
    })
    const { document } = commit(plan)
    expect(validateDocument(document).componentCount).toBe(1)
    expect(validateDocument(document).collisions).toEqual([])
  })

  it('says a frame is unglazed rather than fitting the wrong pane', () => {
    // The three-course window carries a shutter hinge, not a glazing socket.
    const tall = chooseElement('window', 2, 3)!
    expect(tall.courses).toBe(3)
    expect(paneFor(tall)).toBeNull()
  })
})
