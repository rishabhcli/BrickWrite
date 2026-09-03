import { describe, expect, it } from 'vitest'
import { cadEngine } from '../../cad/engine'
import {createBlankDocument} from '../../cad/sample'
import { createRoverDocument } from '../../cad/__fixtures__/rover'
import { classifyRequest, nextAgentAction } from '../../agent/guidance'
import { compileBriefDeterministically } from '../brief'
import { runPipelineSync, strategyOrderFor } from '../phases'

/**
 * The floor: what generation has to keep being able to do.
 *
 * Deterministic and offline, so it runs in CI on every change. It asserts the
 * three properties this workstream exists to establish — a sentence becomes a
 * whole bonded model, a subject that is not a building is not massed as one,
 * and a design request never routes to a single brick — rather than the exact
 * brickwork, which is free to change.
 *
 * The live-model counterpart is `npm run test:live:generation`.
 */

const base = () => createBlankDocument('Archetype eval')

describe('a sentence becomes a whole model', () => {
  it('builds a three-storey shop as one connected, collision-free candidate', { timeout: 30_000 }, () => {
    const candidate = runPipelineSync(
      compileBriefDeterministically('A three-storey shop 20 x 16 studs, 18 studs tall with a door'),
      { seed: 1, base: base() },
    )

    expect(candidate.metrics.partCount).toBeGreaterThan(40)
    expect(candidate.metrics.collisionCount).toBe(0)
    expect(candidate.metrics.componentCount).toBe(1)
    expect(candidate.metrics.floatingPartCount).toBe(0)
    // Buildable in sequence, not just valid as a heap: every step attaches to
    // something placed before it.
    expect(candidate.metrics.buildOrderValid).toBe(true)
    expect(candidate.metrics.buildOrderViolations).toBe(0)
    // Mostly bonded. Some seams line up where a deck meets a brace, and the
    // number is bounded rather than asserted to be zero — a wall built as
    // stacked columns would be a large fraction of the model, not a fifth.
    expect(candidate.metrics.stackedSeamCount / candidate.metrics.partCount).toBeLessThan(0.35)
  })
})

describe('a subject that is not a building is not massed as one', () => {
  it('gives a saucer freighter a hull, not a house', { timeout: 30_000 }, () => {
    const design = compileBriefDeterministically('A saucer freighter 40 x 16 studs, 24 studs tall with a boarding ramp')
    expect(strategyOrderFor(design)[0]).toBe('hull-and-keel')

    const candidate = runPipelineSync(design, { seed: 1, base: base() })
    expect(candidate.strategy).toBe('hull-and-keel')

    const roles = candidate.boxes.map((box) => box.role)
    expect(roles).toContain('keel')
    // The house vocabulary, explicitly absent.
    expect(roles.some((role) => /^storey|^slab/.test(role))).toBe(false)

    // The function the builder named by name, expressed as something that
    // actually opens rather than as a decal.
    const flap = candidate.graph.nodes.find((node) => node.role === 'ramp')
    expect(flap?.region?.shape).toBe('hinged-flap')
    expect(design.functions).toContain('boarding ramp')
  })

  it('gives a landmark diminishing stages', { timeout: 30_000 }, () => {
    const design = compileBriefDeterministically('A lattice observation spire 20 x 20 studs, 44 studs tall')
    const candidate = runPipelineSync(design, { seed: 1, base: base() })
    expect(candidate.strategy).toBe('tower-stages')
    const widths = candidate.boxes.map((box) => box.widthStuds)
    expect(widths).toEqual([...widths].sort((a, b) => b - a))
  })
})

describe('a design request never routes to a single brick', () => {
  const requests = [
    'Build a clock tower with a belfry',
    'Build a harbour control tower with a crane and a metro station',
    'Make me a saucer freighter with a boarding ramp',
    'Design a west-end clock palace',
  ]

  it.each(requests)('"%s" on an empty plate goes to generation', (text) => {
    cadEngine.replaceDocument(createBlankDocument('Empty'))
    const request = classifyRequest(text)
    const step = nextAgentAction({
      partCount: 0,
      selectionCount: 0,
      collisions: 0,
      disconnectedParts: 0,
      floatingParts: 0,
      tipping: null,
      ...request,
    })

    expect(step.tool).toBe('generation_compile')
    expect(step.tool).not.toBe('preflight_placement')
    expect(step.tool).not.toBe('capability_search')
    cadEngine.replaceDocument(createRoverDocument())
  })

  it('still lays a bare baseplate with build_field', () => {
    const step = nextAgentAction({
      partCount: 0,
      selectionCount: 0,
      collisions: 0,
      disconnectedParts: 0,
      floatingParts: 0,
      tipping: null,
      ...classifyRequest('Give me a blank plate to start on'),
    })
    expect(step.tool).toBe('capability_search')
    expect(step.args).toEqual({ query: 'build_field' })
  })
})

describe('a model is as many storeys as it was asked for', () => {
  /**
   * The regression this guards is the one that made every generated model a
   * stump. `massingDelta` proposes the deck of every level during the massing
   * phase, so an upper deck is attempted while the walls that would hold it up
   * are still only a plan and is correctly refused for hovering. Until the
   * realiser retried transient failures that refusal was permanent, and a
   * three-storey request came back one storey tall from every strategy.
   */
  it.each([
    ['A three-storey shop 20 x 16 studs, 18 studs tall', ['base', 'storey1', 'storey2']],
    ['A saucer freighter 40 x 16 studs, 24 studs tall', ['keel', 'port', 'starboard', 'cockpit', 'engine']],
    ['A lattice observation spire 20 x 20 studs, 44 studs tall', ['base', 'clock-stage', 'belfry', 'spire']],
    ['A harbour control tower 24 x 24 studs, 40 studs tall with a metro station and a crane',
      ['plinth', 'bay-left', 'bay-right', 'shaft', 'crown']],
  ])('builds every volume "%s" was massed into', { timeout: 60_000 }, (prompt, roles) => {
    const candidate = runPipelineSync(compileBriefDeterministically(prompt), { seed: 7, base: base() })

    expect(candidate.boxes.map((box) => box.role)).toEqual(expect.arrayContaining(roles))

    // Massed *and built*. An assembly per role, each holding parts.
    const built = Object.values(candidate.document.subassemblies)
      .filter((item) => item.partIds.length)
      .map((item) => item.name.toLowerCase())
    for (const role of roles) {
      expect(built).toContain(role.replace(/[_-]+/g, ' '))
    }

    expect(candidate.metrics.collisionCount).toBe(0)
    expect(candidate.metrics.componentCount).toBe(1)
    expect(candidate.metrics.partCount).toBeGreaterThan(250)
  })

  it('does not retry a failure a later phase could never fix', { timeout: 30_000 }, () => {
    // Retrying is only safe because it is bounded: a node refused for a
    // collision, a missing identity or an envelope breach is terminal and is
    // reported once rather than re-attempted every phase.
    const candidate = runPipelineSync(
      compileBriefDeterministically('A three-storey shop 20 x 16 studs, 18 studts tall'),
      { seed: 7, base: base(), constraints: { partBudget: 60 } },
    )
    const terminal = candidate.realize.nodes.filter((node) => node.status === 'rejected' && !node.retryable)
    for (const node of terminal) {
      expect(candidate.realize.nodes.filter((entry) => entry.nodeId === node.nodeId)).toHaveLength(1)
    }
  })
})
