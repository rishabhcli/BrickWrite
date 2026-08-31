import { describe, expect, it } from 'vitest'
import { catalog } from '../cad/catalog'
import { createBlankDocument } from '../cad/sample'
import { compileBriefDeterministically, matchColours } from './brief'
import { runPipelineSync, strategyOrderFor, STRATEGIES, MAX_MASSING_BOXES } from './phases'

/**
 * Massing that is not three axis-aligned buildings.
 *
 * The gap this closes is measurable rather than aesthetic: before these
 * strategies, a saucer freighter, a clock palace and a shop all decomposed into
 * the same stack of storeys, because the only three decompositions in the
 * vocabulary described a building. These tests assert the *roles* a subject's
 * massing names, since that is what the later phases and the subassembly pass
 * both key on.
 */

const brief = (text: string) => compileBriefDeterministically(text)
const base = () => createBlankDocument('Strategies')

const rolesOf = (subject: string, strategy?: string) => {
  const design = brief(subject)
  const candidate = runPipelineSync(design, {
    seed: 7,
    base: base(),
    ...(strategy ? { strategy } : {}),
  })
  return { candidate, roles: candidate.boxes.map((box) => box.role) }
}

describe('archetype routing', () => {
  it.each([
    ['A saucer freighter 40 x 16 studs with a boarding ramp', 'hull-and-keel'],
    ['A harbour crane 16 x 16 studs, 24 studs tall', 'machine-frame'],
    ['A lattice observation spire 16 x 16 studs, 40 studs tall', 'tower-stages'],
    ['A three-storey shop 20 x 16 studs, 18 studs tall', 'framed-shell'],
  ])('sends "%s" to %s first', (subject, strategy) => {
    expect(strategyOrderFor(brief(subject))[0]).toBe(strategy)
  })

  it('prefers the programmed block for a building with a working programme', () => {
    const design = brief('A city tower 24 x 24 studs, 30 studs tall with a metro station and a crane')
    expect(strategyOrderFor(design)[0]).toBe('play-program')
  })

  it('offers every other strategy after the one the subject asked for', () => {
    const order = strategyOrderFor(brief('A saucer freighter'))
    expect(order[0]).toBe('hull-and-keel')
    expect(new Set(order)).toEqual(new Set(STRATEGIES.map((strategy) => strategy.id)))
  })
})

describe('non-building massing', { timeout: 30_000 }, () => {
  it('gives a vehicle a keel, two hull sides and a cockpit — not three storeys', () => {
    const { roles, candidate } = rolesOf('A saucer freighter 40 x 16 studs, 12 studs tall')
    expect(candidate.strategy).toBe('hull-and-keel')
    expect(roles).toEqual(expect.arrayContaining(['keel', 'port', 'starboard', 'cockpit']))
    expect(roles).not.toContain('storey1')
    expect(candidate.metrics.partCount).toBeGreaterThan(40)
  })

  it('gives a landmark stages that actually diminish', () => {
    const { roles, candidate } = rolesOf('A lattice observation spire 20 x 20 studs, 44 studs tall')
    expect(candidate.strategy).toBe('tower-stages')
    expect(roles.length).toBeGreaterThan(1)
    const widths = candidate.boxes.map((box) => box.widthStuds)
    expect(widths).toEqual([...widths].sort((a, b) => b - a))
    expect(new Set(widths).size).toBe(widths.length)
  })

  it('gives a mechanism a bed, a mast and a boom', () => {
    const { roles, candidate } = rolesOf('A harbour crane 18 x 18 studs, 28 studs tall')
    expect(candidate.strategy).toBe('machine-frame')
    expect(roles).toEqual(expect.arrayContaining(['bed', 'mast', 'boom']))
  })

  it('gives a programmed building two ground bays rather than one wall', () => {
    const { roles } = rolesOf('A city tower 24 x 24 studs, 32 studs tall with a metro station', 'play-program')
    expect(roles).toEqual(expect.arrayContaining(['plinth', 'bay-left', 'bay-right', 'shaft']))
  })

  it('builds a real hinge when the brief asks for something that opens', () => {
    const { candidate } = rolesOf('A saucer freighter 40 x 16 studs, 12 studs tall with a boarding ramp')
    const flap = candidate.graph.nodes.find((node) => node.role === 'ramp')
    expect(flap?.region?.shape).toBe('hinged-flap')
    // Skipped for want of geometry is acceptable; silently dropping the
    // function the builder asked for is not.
    const outcome = candidate.realize.nodes.find((entry) => entry.nodeId === flap?.id)
    expect(outcome).toBeDefined()
    if (outcome!.status === 'realized' || outcome!.status === 'repaired') {
      expect(candidate.notes.join(' ')).toMatch(/hinged flap/)
    } else {
      expect(candidate.notes.join(' ') + JSON.stringify(outcome)).toMatch(/hinge|geometry|GEOMETRY_UNAVAILABLE/i)
    }
  })

  it('does not hang a ramp on a subject that never asked for one', () => {
    const { candidate } = rolesOf('A three-storey shop 20 x 16 studs, 18 studs tall')
    expect(candidate.graph.nodes.some((node) => node.role === 'ramp')).toBe(false)
  })
})

describe('scale', { timeout: 30_000 }, () => {
  it('reads "large" as an envelope a hull can be massed into', () => {
    const design = brief('A large saucer freighter')
    // The old answer was 14 x 8 x 8 scaled uniformly to a 31-stud cube. A hull
    // is long and wide against its height, which is the measurable half of
    // "large means large".
    expect(design.envelopeStuds).toEqual([48, 16, 40])
    const candidate = runPipelineSync(design, { seed: 3, base: base() })
    expect(candidate.boxes[0].widthStuds).toBeGreaterThan(20)
    expect(candidate.metrics.partCount).toBeGreaterThan(100)
  })

  it('leaves a stated envelope alone', () => {
    const candidate = runPipelineSync(brief('A large freighter 12 x 6 studs, 6 studs tall'), { seed: 3, base: base() })
    expect(candidate.boxes.every((box) => box.widthStuds <= 12)).toBe(true)
  })
})

describe('the massing box cap', () => {
  it('allows sixteen volumes, not eight', () => {
    expect(MAX_MASSING_BOXES).toBe(16)
  })
})

describe('the part ceiling', { timeout: 30_000 }, () => {
  it('reports what it could not build instead of returning a quiet fragment', () => {
    const design = brief('A three-storey shop 20 x 16 studs, 18 studs tall')
    const candidate = runPipelineSync(design, { seed: 5, base: base(), constraints: { partBudget: 40 } })

    expect(candidate.realize.truncated).toBe(true)
    expect(candidate.continuation).not.toBeNull()
    expect(candidate.continuation).toMatchObject({
      reason: 'part-ceiling',
      suggestedTool: 'generate_region',
    })
    expect(candidate.continuation!.remainingRoles.length).toBeGreaterThan(0)
    expect(candidate.continuation!.suggestedPrompt).toMatch(/shop/i)
    // Truncated, not broken: what did get built is still a valid candidate.
    expect(candidate.metrics.collisionCount).toBe(0)
    expect(candidate.metrics.partCount).toBeGreaterThan(0)
  })

  it('reports no continuation when the whole massing was built', () => {
    const candidate = runPipelineSync(brief('A three-storey shop 20 x 16 studs, 18 studs tall'), { seed: 5, base: base() })
    expect(candidate.realize.truncated).toBe(false)
    expect(candidate.continuation).toBeNull()
  })

  it('names which candidate every phase event belongs to', () => {
    const events: string[] = []
    const candidate = runPipelineSync(brief('A three-storey shop 20 x 16 studs, 18 studs tall'), {
      seed: 5,
      base: base(),
      onPhase: (event) => events.push(event.candidateId),
    })
    // Candidates run concurrently; an event that did not say which one it came
    // from could only be attributed by arrival order, which is not stable.
    expect(new Set(events)).toEqual(new Set([candidate.id]))
    expect(events).toHaveLength(4)
  })
})

describe('subassemblies from massing roles', { timeout: 30_000 }, () => {
  it('names assemblies after the volumes the massing chose, and puts every part in one', () => {
    const candidate = runPipelineSync(brief('A saucer freighter 40 x 16 studs, 24 studs tall, max 1500 pieces'), {
      seed: 7,
      base: base(),
    })
    const assemblies = Object.values(candidate.document.subassemblies).filter((item) => item.partIds.length)

    // Hull roles, not house roles, and every one of them actually built. The
    // point of the grouping is that a builder can lock the keel by name and
    // generate into what is left, rather than being handed one
    // undifferentiated "Generated" bag.
    const names = assemblies.map((item) => item.name.toLowerCase())
    expect(names).toEqual(expect.arrayContaining(['keel', 'port', 'starboard', 'cockpit', 'engine']))
    expect(assemblies.length).toBeGreaterThan(1)

    // Unlocked: generation proposes, the builder edits.
    expect(assemblies.every((item) => item.locked === false)).toBe(true)

    // Nothing orphaned, and no part pointing at an assembly that does not exist.
    const parts = Object.values(candidate.document.parts)
    const assigned = new Set(assemblies.flatMap((item) => item.partIds))
    expect(parts.every((part) => assigned.has(part.id))).toBe(true)
    expect(parts.every((part) => candidate.document.subassemblies[part.subassemblyId])).toBe(true)
  })

  it('keeps a volume and its bracing in the same assembly', () => {
    const candidate = runPipelineSync(brief('A three-storey shop 20 x 16 studs, 18 studs tall'), { seed: 7, base: base() })
    const names = Object.values(candidate.document.subassemblies).map((item) => item.name.toLowerCase())
    expect(names.some((name) => name.includes('brace'))).toBe(false)
  })
})

describe('the functions a brief carries forward', () => {
  /**
   * `brief.functions` is not decoration. It selects the massing strategy,
   * decides whether the detail phase builds a real hinge, and is read back to
   * the model in the grounding block — so a malformed entry is noise in three
   * places at once.
   *
   * The general "<something> that <verb>s" rule used to capture whatever
   * preceded `that`, so "a shop with doors that open" produced the function
   * "A shop with doors opens" *alongside* the correct "doors open". Two
   * requirements where the builder stated one, and the first of them nonsense.
   */
  it.each([
    ['A shop with doors that open', ['doors open']],
    ['A car with wheels that turn', ['wheels turn']],
    ['A house with a roof that lifts off', ['roof lifts off']],
    ['A crane that turns', ['crane turns']],
    ['A lighthouse with a lamp room that lifts off', ['lamp room lifts']],
  ])('reads "%s" as exactly one requirement', (prompt, expected) => {
    expect(brief(prompt).functions).toEqual(expected)
  })

  it('names the thing that moves, not the clause it sat in', () => {
    // A connective splits the phrase rather than being trimmed from its front:
    // "a shop with doors" is about the doors.
    for (const prompt of ['A shop with doors that open', 'A car with wheels that turn']) {
      for (const entry of brief(prompt).functions) {
        expect(entry).not.toMatch(/\b(with|a|an|the|and)\b/)
      }
    }
  })

  it('still records a feature that is named rather than described moving', () => {
    expect(brief('A saucer freighter with a boarding ramp').functions).toContain('boarding ramp')
    expect(brief('A tower with a metro station and a crane').functions).toEqual(
      expect.arrayContaining(['metro station', 'crane']),
    )
    expect(brief('A tower with a clock').functions).toContain('clock')
  })

  it('does not report one moving thing twice', () => {
    // The specific rules and the catch-all can both match the same clause.
    // "doors open" and "doors opens" are not two requirements.
    const functions = brief('A shop with doors that open and windows that open').functions
    expect(new Set(functions.map((entry) => entry.split(/\s+/)[0])).size).toBe(functions.length)
  })
})

describe('openings a builder asked for', { timeout: 30_000 }, () => {
  const glazing = (candidate: ReturnType<typeof runPipelineSync>) =>
    Object.values(candidate.document.parts).filter((entry) =>
      (catalog.get(entry.definitionId)?.category ?? '').startsWith('Windows'),
    )

  it('records a plainly named door or window as a requirement', () => {
    // These are the two features most often named without describing motion,
    // and the whole opening system keys on `brief.functions`. Before they were
    // recorded, "a shop with a door" produced a blank wall.
    expect(brief('A shop 20 x 16 studs with a door').functions).toContain('door')
    expect(brief('A farmhouse 24 x 18 studs with windows').functions).toContain('windows')
  })

  it('seats real frames and glazing rather than leaving a gap', () => {
    const candidate = runPipelineSync(brief('A red farmhouse 24 x 18 studs, 20 studs tall with windows'), {
      seed: 3,
      base: base(),
    })
    const seated = glazing(candidate)
    expect(seated.length).toBeGreaterThan(8)
    expect(candidate.metrics.collisionCount).toBe(0)
    expect(candidate.metrics.componentCount).toBe(1)
  })

  it('puts windows on the upper storeys too, not just the ground floor', () => {
    const candidate = runPipelineSync(brief('A tower 24 x 24 studs, 40 studs tall with windows'), {
      seed: 3,
      base: base(),
    })
    // Distinct heights, which is what "every storey" means once the model is
    // built rather than planned.
    const heights = new Set(glazing(candidate).map((entry) => Math.round(entry.transform.position[1] / 24)))
    expect(heights.size).toBeGreaterThan(1)
  })

  it('cuts no opening it cannot fill', () => {
    // The catalog's only door is six courses tall. A five-course storey cannot
    // seat one, and cutting the hole anyway is how a wall ends up with a
    // doorway-shaped gap and no door in it — structurally sound, and wrong.
    const short = runPipelineSync(brief('A three-storey shop 20 x 16 studs, 18 studs tall with a door'), {
      seed: 3,
      base: base(),
    })
    expect(glazing(short)).toHaveLength(0)

    const tall = runPipelineSync(brief('A three-storey shop 20 x 16 studs, 26 studs tall with a door and windows'), {
      seed: 3,
      base: base(),
    })
    const doors = glazing(tall).filter((entry) => catalog.get(entry.definitionId)?.name.toLowerCase().includes('door'))
    expect(doors.length).toBeGreaterThan(0)
  })

  it('leaves a subject that asked for neither alone', () => {
    const candidate = runPipelineSync(brief('A saucer freighter 40 x 16 studs, 24 studs tall'), { seed: 3, base: base() })
    expect(glazing(candidate)).toHaveLength(0)
  })
})

describe('the colours a brief asks for', { timeout: 30_000 }, () => {
  const used = (candidate: ReturnType<typeof runPipelineSync>) => {
    const counts = new Map<number, number>()
    for (const entry of Object.values(candidate.document.parts)) {
      counts.set(entry.color, (counts.get(entry.color) ?? 0) + 1)
    }
    return counts
  }

  it('reads every colour in a list, including adjacent ones', () => {
    // The matcher claimed the spaces around a name as well as the name, so two
    // colour words sharing the single space between them collided and the
    // longer one won. "a tan, white and dark bluish grey tower" compiled to a
    // two-colour brief with the tan silently missing.
    expect(matchColours('A tan, white and dark bluish grey tower').map((entry) => entry.code)).toEqual([15, 19, 72])
    expect(matchColours('a white red blue yellow flag').map((entry) => entry.code)).toEqual([1, 4, 14, 15])
  })

  it('still prefers the longer colour name where both would match', () => {
    expect(matchColours('A dark tan and white shop').map((entry) => entry.code)).toEqual([15, 28])
    expect(matchColours('a light bluish grey and dark bluish grey hull').map((entry) => entry.code)).toEqual([71, 72])
  })

  it('invents no colour the build cannot render', () => {
    // No LDraw colour is named plain "Grey"; there is Light Grey and Dark Grey.
    expect(matchColours('a grey tower')).toEqual([])
  })

  it('spends a stated palette across the model, not on six greebles', () => {
    const candidate = runPipelineSync(brief('A tan, white and dark bluish grey tower 24 x 24 studs, 40 studs tall'), {
      seed: 3,
      base: base(),
    })
    const counts = used(candidate)
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([15, 19, 72])
    // Every stated colour carries real structure. Before, the second colour
    // reached exactly the six detail tiles and the third was never placed.
    for (const [colour, count] of counts) {
      expect(count, `colour ${colour} is decorative only`).toBeGreaterThan(20)
    }
  })

  it('honours one stated colour as one colour', () => {
    const counts = used(runPipelineSync(brief('A red farmhouse 24 x 18 studs, 20 studs tall'), { seed: 3, base: base() }))
    expect([...counts.keys()]).toEqual([4])
  })

  it('never places a part outside the palette the brief stated', () => {
    for (const prompt of [
      'A tan, white and dark bluish grey tower 24 x 24 studs, 40 studs tall',
      'A red and dark bluish grey farmhouse 24 x 18 studs, 20 studs tall with windows',
    ]) {
      const design = brief(prompt)
      const candidate = runPipelineSync(design, { seed: 3, base: base() })
      for (const colour of used(candidate).keys()) {
        expect(design.palette, `${prompt} placed ${colour}`).toContain(colour)
      }
    }
  })
})

describe('surface detail', { timeout: 30_000 }, () => {
  const detailNodes = (candidate: ReturnType<typeof runPipelineSync>) =>
    candidate.graph.nodes.filter((node) => node.role === 'detail')

  it('scales with the model rather than being a constant six', () => {
    // Detail used to land on one host — the highest placed node — so a
    // four-storey tower carried six tiles on its crown and nothing anywhere
    // else, and a 24 x 24 deck carried the same six as a 4 x 4 one.
    const small = runPipelineSync(brief('A shed 10 x 8 studs, 8 studs tall'), { seed: 3, base: base() })
    const large = runPipelineSync(brief('A tower 24 x 24 studs, 40 studs tall'), { seed: 3, base: base() })
    expect(detailNodes(large).length).toBeGreaterThan(detailNodes(small).length)
  })

  it('reaches more than one surface', () => {
    const candidate = runPipelineSync(brief('A three-storey shop 20 x 16 studs, 26 studs tall'), { seed: 3, base: base() })
    const hosts = new Set(
      candidate.graph.edges
        .filter((edge) => detailNodes(candidate).some((node) => node.id === edge.to))
        .map((edge) => edge.from),
    )
    expect(hosts.size).toBeGreaterThan(1)
  })

  it('does not spend the part budget on greebles', () => {
    // Detail competes with structure. A candidate truncated halfway through its
    // walls to make room for surface elements is a worse model than a plain one.
    const candidate = runPipelineSync(brief('A tower 24 x 24 studs, 40 studs tall'), { seed: 3, base: base() })
    expect(detailNodes(candidate).length).toBeLessThanOrEqual(48)
    expect(detailNodes(candidate).length / candidate.metrics.partCount).toBeLessThan(0.15)
  })

  it('leaves the model standing', () => {
    for (const prompt of [
      'A three-storey shop 20 x 16 studs, 26 studs tall with a door and windows',
      'A saucer freighter 40 x 16 studs, 24 studs tall with a boarding ramp',
    ]) {
      const candidate = runPipelineSync(brief(prompt), { seed: 3, base: base() })
      expect(candidate.metrics.collisionCount, prompt).toBe(0)
      expect(candidate.metrics.componentCount, prompt).toBe(1)
    }
  })
})
