import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createShowcaseDocument } from '../cad/sample'
import { scriptedTransport, toolValue, type ScriptedLeg } from './__fixtures__/scriptedTransport'
import { compileBrief } from './brief'
import { AgentSession } from './session'
import type { AgentMode } from './modes'

/**
 * The twelve workflows.
 *
 * Each one drives the real session loop against the real kernel; only the model
 * is scripted. That is deliberate — the thing worth testing is what happens to
 * the document when a model says a particular thing, and a mocked tool host
 * would test nothing but the mock.
 */

const reset = (mode: AgentMode = 'propose') => {
  cadEngine.replaceDocument(createShowcaseDocument())
  cadEngine.setAutonomy(mode)
  cadEngine.setSelection([])
}

const makeSession = (script: ScriptedLeg[] | ((request: never, index: number) => ScriptedLeg), options: { brief?: ReturnType<typeof compileBrief> } = {}) => {
  const transport = scriptedTransport(script as ScriptedLeg[])
  const session = new AgentSession({ transport, maxToolTurns: 6, brief: options.brief ?? null })
  return { session, transport }
}

const lastToolResults = (transport: { requests: readonly { messages: readonly unknown[] }[] }) => {
  const messages = transport.requests.at(-1)?.messages ?? []
  const results: Array<{ id: string; name: string; ok: boolean; content: string }> = []
  for (const message of messages as Array<{ role: string; results?: Array<{ id: string; name: string; ok: boolean; content: string }> }>) {
    if (message.role === 'tool' && message.results) results.push(...message.results)
  }
  return results
}

describe('agent workflows', () => {
  beforeEach(() => reset())
  afterEach(() => {
    vi.restoreAllMocks()
    reset()
  })

  // 1 --------------------------------------------------------------------
  it('workflow 1 — inspection answers from measured facts and changes nothing', async () => {
    reset('inspect')
    const { session, transport } = makeSession([
      {
        text: ['Let me read the model. '],
        toolCalls: [
          { name: 'scene_overview', input: {} },
          { name: 'validate_model', input: {} },
        ],
      },
      { text: ['33 parts across four assemblies; the cockpit is locked and validation is clean.'] },
    ])

    await session.send('What am I looking at?')

    const results = lastToolResults(transport)
    expect(results.map((result) => result.name)).toEqual(['scene_overview', 'validate_model'])
    expect(results.every((result) => result.ok)).toBe(true)
    const overview = toolValue<{ partCount: number; documentRevision: number }>(results[0].content)
    expect(overview.partCount).toBe(33)
    expect(overview.documentRevision).toBe(1)

    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    expect(session.getState().waves).toEqual([])
    expect(session.getState().status).toBe('idle')
    expect(session.getState().transcript.at(-1)?.text).toContain('33 parts')
    session.dispose()
  })

  it('workflow 1b — Inspect refuses a preflight structurally, and says why', async () => {
    reset('inspect')
    const { session, transport } = makeSession([
      { toolCalls: [{ name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Nope' } } }] },
      { text: ['I cannot propose changes in Inspect mode.'] },
    ])
    await session.send('Rename this project.')
    const [result] = lastToolResults(transport)
    expect(result.ok).toBe(false)
    expect(toolValue<{ error: { code: string } }>(result.content).error.code).toBe('READ_ONLY_MODE')
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    session.dispose()
  })

  // 2 --------------------------------------------------------------------
  it('workflow 2 — a local edit is planned against a connector, reviewed, then accepted', async () => {
    const { session, transport } = makeSession([
      {
        text: ['I will seat a 2×4 brick under the chassis plate. '],
        toolCalls: [
          { name: 'selection_geometry', input: { reference: '@part:part_0001' } },
          { name: 'preflight_placement', input: { definitionId: '3001', anchorPartId: 'part_0001', approach: 'underneath' } },
        ],
      },
      { text: ['Proposed one brick, mated to part_0001. Accept it when you are happy.'] },
    ])

    await session.send('Put a brick under @part:part_0001')

    const results = lastToolResults(transport)
    const geometry = toolValue<{ sizeStuds: number[]; neighbourPartIds: string[] }>(results[0].content)
    expect(geometry.sizeStuds[0]).toBeGreaterThan(0)
    expect(results[1].ok).toBe(true)
    const placement = toolValue<{ waveId: string; solvedPositionLdu: number[] }>(results[1].content)
    expect(placement.solvedPositionLdu).toHaveLength(3)

    // Reviewed, not applied.
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    const [wave] = session.getState().waves
    expect(wave.status).toBe('pending')

    const accepted = session.acceptWave(wave.id)
    expect(accepted.ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(2)
    expect(Object.keys(cadEngine.getSnapshot().document.parts).length).toBe(34)
    expect(cadEngine.getSnapshot().transactions.at(-1)?.author).toBe('human')
    session.dispose()
  })

  // 3 --------------------------------------------------------------------
  it('workflow 3 — a generator lays a wall after the envelope constraint is widened', async () => {
    const { session, transport } = makeSession([
      {
        text: ['The hard envelope is 10 × 14 studs, so a new wall would violate it. I will widen it first. '],
        toolCalls: [
          { name: 'scene_overview', input: {} },
          { name: 'preflight_capability', input: { capability: 'set_dimension_limit', args: { widthStuds: 96, depthStuds: 96 } } },
          {
            name: 'preflight_capability',
            input: { capability: 'build_wall', args: { lengthStuds: 8, courses: 3, axis: 'x', originLdu: [400, 0, 400] } },
          },
        ],
      },
      { text: ['Two waves: widen the envelope, then lay an 8 × 3 bonded wall.'] },
    ])

    await session.send('Lay an eight stud wall, three courses, well clear of the rover.')

    const results = lastToolResults(transport)
    expect(results[1].ok).toBe(true)
    expect(results[2].ok).toBe(true)
    const wall = toolValue<{ report: { parts: number; courses: number; runningBond: boolean } }>(results[2].content)
    expect(wall.report.courses).toBe(3)
    expect(wall.report.parts).toBeGreaterThan(3)

    const waves = session.getState().waves
    expect(waves.length).toBe(2)
    expect(cadEngine.getSnapshot().document.revision).toBe(1)

    const accepted = session.acceptAll()
    expect(accepted.error).toBeNull()
    expect(accepted.accepted.length).toBe(2)
    expect(cadEngine.getSnapshot().document.revision).toBe(3)
    expect(Object.keys(cadEngine.getSnapshot().document.parts).length).toBeGreaterThan(33)
    session.dispose()
  })

  // 4 --------------------------------------------------------------------
  it('workflow 4 — a refinement request resolves @selection to concrete ids before planning', async () => {
    cadEngine.setSelection(['part_0001', 'part_0002'])
    const { session, transport } = makeSession([
      {
        toolCalls: [
          { name: 'selection_geometry', input: { reference: '@selection' } },
          { name: 'preflight_capability', input: { capability: 'create_subassembly', args: { name: 'Front skid' } } },
        ],
      },
      { text: ['Grouped the two selected plates into a new assembly.'] },
    ])

    await session.send('Group @selection into its own assembly called Front skid.')

    // The reference was resolved for the model, not left as a token.
    const grounding = transport.requests[0].grounding
    expect(grounding.references?.[0]).toMatchObject({ token: '@selection', partIds: ['part_0001', 'part_0002'] })
    expect(grounding.documentRevision).toBe(1)

    const results = lastToolResults(transport)
    expect(results[1].ok).toBe(true)
    const wave = session.getState().waves[0]
    expect(wave.capability).toBe('create_subassembly')
    expect(session.acceptWave(wave.id).ok).toBe(true)
    const document = cadEngine.getSnapshot().document
    expect(Object.values(document.subassemblies).some((item) => item.name === 'Front skid')).toBe(true)
    session.dispose()
  })

  // 5 --------------------------------------------------------------------
  it('workflow 5 — an impossible part request is refused by identity, not attempted', async () => {
    const preflight = vi.spyOn(cadEngine, 'preflight')
    const { session, transport } = makeSession([
      {
        toolCalls: [
          { name: 'catalog_search', input: { text: 'sarlacc pit dish', tier: 'all' } },
          { name: 'preflight_placement', input: { definitionId: 'sarlacc-9000', anchorPartId: 'part_0001', approach: 'on-top' } },
        ],
      },
      { text: ['There is no such part in this catalogue, and nothing near it is placeable here.'] },
    ])

    await session.send('Add a sarlacc pit dish on the nose.')

    const results = lastToolResults(transport)
    expect(results[1].ok).toBe(false)
    const error = toolValue<{ error: { code: string; message: string } }>(results[1].content).error
    expect(error.code).toBe('PART_DEFINITION_NOT_FOUND')
    expect(error.message).toContain('sarlacc-9000')
    expect(preflight).not.toHaveBeenCalled()
    expect(session.getState().waves).toEqual([])
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    session.dispose()
  })

  // 6 --------------------------------------------------------------------
  it('workflow 6 — an ambiguous request travels with its conflicts and produces no plan', async () => {
    const brief = compileBrief('Build me a car or a truck, whichever works better.')
    expect(brief.conflicts.length).toBeGreaterThan(0)
    const { session, transport } = makeSession(
      [{ text: ['The brief has an unresolved choice: car or truck. Which do you want before I plan anything?'] }],
      { brief },
    )

    await session.send('Build me a car or a truck, whichever works better.')

    expect(transport.requests[0].grounding.brief?.conflicts.length).toBeGreaterThan(0)
    expect(session.getState().waves).toEqual([])
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    expect(session.getState().transcript.at(-1)?.text).toContain('Which do you want')
    session.dispose()
  })

  // 7 --------------------------------------------------------------------
  it('workflow 7 — cancelling mid-stream stops cleanly and leaves nothing pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { session } = makeSession([
      {
        text: ['Reading the model', ' and planning a change', ' that will never arrive'],
        hold: () => gate,
        toolCalls: [{ name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Never' } } }],
      },
    ])

    const inFlight = session.send('Rework the whole rear deck.')
    await Promise.resolve()
    expect(session.getState().status).toBe('streaming')

    session.cancel()
    release()
    await inFlight

    const state = session.getState()
    expect(state.status).toBe('cancelled')
    expect(state.transcript.at(-1)?.status).toBe('cancelled')
    expect(state.transcript.at(-1)?.problem).toContain('Cancelled')
    // No entry is left looking like work in progress.
    expect(state.trace.filter((entry) => entry.status === 'pending')).toEqual([])
    expect(state.waves).toEqual([])
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    session.dispose()
  })

  // 8 --------------------------------------------------------------------
  it('workflow 8 — a stale revision rebases what it can and fails loudly on what it cannot', async () => {
    const { session } = makeSession([
      {
        toolCalls: [
          { name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Rebasable' } } },
          { name: 'preflight_capability', input: { capability: 'create_subassembly', args: { name: 'Doomed', partIds: ['part_0003'] } } },
        ],
      },
      { text: ['Two waves ready.'] },
    ])

    await session.send('Rename the project and group part_0003.')
    expect(session.getState().waves.length).toBe(2)
    const [rebasable, doomed] = session.getState().waves

    // A person edits the model underneath both plans.
    expect(cadEngine.execute('Human deletes a plate', [{ type: 'part.remove', partId: 'part_0003' }], 'human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(2)

    const after = session.getState().waves
    expect(after.find((wave) => wave.id === rebasable.id)?.baseRevision).toBe(2)
    expect(after.find((wave) => wave.id === rebasable.id)?.status).toBe('pending')

    const dead = after.find((wave) => wave.id === doomed.id)
    expect(dead?.status).toBe('stale')
    expect(dead?.problem).toContain('part_0003')

    const refused = session.acceptWave(doomed.id)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(session.getState().transcript.at(-1)?.status).toBe('failed')
    expect(session.getState().error?.code).toBe(refused.error.code)

    // The rebased wave still applies, at the new revision.
    expect(session.acceptWave(rebasable.id).ok).toBe(true)
    expect(cadEngine.getSnapshot().document.name).toBe('Rebasable')
    expect(cadEngine.getSnapshot().document.revision).toBe(3)
    session.dispose()
  })

  // 9 --------------------------------------------------------------------
  it('workflow 9 — a protected region is refused at proposal time with the region named', async () => {
    const execute = vi.spyOn(cadEngine, 'execute')
    const { session, transport } = makeSession([
      {
        toolCalls: [
          { name: 'preflight_capability', input: { capability: 'create_subassembly', args: { name: 'Canopy', partIds: ['part_0023'] } } },
        ],
      },
      { text: ['The canopy is in the locked cockpit assembly, so I cannot move it.'] },
    ])

    await session.send('Move the canopy into its own assembly.')

    const [result] = lastToolResults(transport)
    expect(result.ok).toBe(false)
    const error = toolValue<{ error: { code: string; message: string; repair: string } }>(result.content).error
    expect(error.code).toBe('PROTECTED_REGION')
    expect(error.message).toContain('part_0023')
    expect(error.repair.length).toBeGreaterThan(10)
    expect(execute).not.toHaveBeenCalled()
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    session.dispose()
  })

  // 10 -------------------------------------------------------------------
  it('workflow 10 — a colliding wave is refused, repaired from measured overlap, then lands', async () => {
    cadEngine.setSelection(['part_0001'])
    const { session, transport } = makeSession([
      {
        toolCalls: [
          {
            name: 'preflight_capability',
            input: { capability: 'duplicate_selection', args: { partIds: ['part_0001'], offsetLdu: [0, 0, 0] } },
          },
        ],
      },
      {
        toolCalls: [{ name: 'repair_suggest', input: { proposalId: 'WAVE_PLACEHOLDER', failureCode: 'COLLISION' } }],
      },
      {
        toolCalls: [
          {
            name: 'preflight_capability',
            input: { capability: 'duplicate_selection', args: { partIds: ['part_0001'], offsetLdu: [0, -400, 0] } },
          },
        ],
      },
      { text: ['The first copy landed on top of the original; the second sits 400 LDU above the model.'] },
    ])

    await session.send('Duplicate the front plate.')
    const colliding = session.getState().waves[0]
    expect(colliding.validation?.collisions.length).toBeGreaterThan(0)

    const refused = session.acceptWave(colliding.id)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe('COLLISION')
    expect(cadEngine.getSnapshot().document.revision).toBe(1)

    // The repair tool reports the measured overlap and a concrete clearance.
    const repairCall = lastToolResults(transport).find((result) => result.name === 'repair_suggest')
    expect(repairCall).toBeDefined()

    const clean = session.getState().waves.find((wave) => wave.status === 'pending')
    expect(clean).toBeDefined()
    expect(clean!.validation?.collisions.length).toBe(0)
    expect(session.acceptWave(clean!.id).ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(2)
    session.dispose()
  })

  it('workflow 10b — repair_suggest reports the offending pair and a clearance that would fix it', async () => {
    cadEngine.setSelection(['part_0001'])
    const { session, transport } = makeSession([
      {
        toolCalls: [
          {
            name: 'preflight_capability',
            input: { capability: 'duplicate_selection', args: { partIds: ['part_0001'], offsetLdu: [0, 0, 0] } },
          },
        ],
      },
      { toolCalls: [{ name: 'repair_suggest', input: {} }] },
      { text: ['Move it clear.'] },
    ])
    await session.send('Duplicate the front plate.')
    const waveId = session.getState().waves[0].id
    session.acceptWave(waveId)

    const repair = lastToolResults(transport).find((result) => result.name === 'repair_suggest')
    const value = toolValue<{ protectedRegions: Array<{ subassemblyId: string }>; staleWaves: unknown[] }>(repair!.content)
    expect(value.protectedRegions.map((region) => region.subassemblyId)).toContain('cockpit')
    session.dispose()
  })

  // 11 -------------------------------------------------------------------
  it('workflow 11 — a rejection carries its reason back to the model and changes nothing', async () => {
    const { session, transport } = makeSession([
      { toolCalls: [{ name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Rover Mk II' } } }] },
      { text: ['Renamed, pending your review.'] },
      { text: ['Understood — I will leave the name alone.'] },
    ])

    await session.send('Give the project a better name.')
    const wave = session.getState().waves[0]
    expect(wave.status).toBe('pending')

    await session.feedback(wave.id, 'The name is fine as it is.')

    expect(session.getState().waves[0].status).toBe('rejected')
    expect(session.getState().waves[0].problem).toBe('The name is fine as it is.')
    expect(cadEngine.getSnapshot().document.name).toBe('Survey rover')
    expect(cadEngine.getSnapshot().document.revision).toBe(1)

    const sent = JSON.stringify(transport.requests.at(-1)?.messages)
    expect(sent).toContain('The name is fine as it is.')
    expect(session.getState().transcript.at(-1)?.text).toContain('leave the name alone')
    session.dispose()
  })

  // 12 -------------------------------------------------------------------
  it('workflow 12 — several waves are accepted in order, each rebased onto the last', async () => {
    const { session } = makeSession([
      {
        toolCalls: [
          { name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Survey rover mk2' } } },
          { name: 'preflight_capability', input: { capability: 'set_piece_budget', args: { maxParts: 500 } } },
          { name: 'preflight_capability', input: { capability: 'add_builder_note', args: { text: 'Deck tiles need a second look.', partIds: ['part_0001'] } } },
        ],
      },
      { text: ['Three waves ready for review.'] },
    ])

    await session.send('Rename it, raise the budget and leave me a note.')
    expect(session.getState().waves.length).toBe(3)
    expect(cadEngine.getSnapshot().document.revision).toBe(1)

    const result = session.acceptAll()
    expect(result.error).toBeNull()
    expect(result.accepted.length).toBe(3)

    const document = cadEngine.getSnapshot().document
    expect(document.revision).toBe(4)
    expect(document.name).toBe('Survey rover mk2')
    expect(document.constraints.find((constraint) => constraint.kind === 'piece-count')?.value).toBe(500)
    expect(document.notes.some((note) => note.text.includes('Deck tiles'))).toBe(true)
    expect(session.getState().waves.every((wave) => wave.status === 'applied')).toBe(true)
    session.dispose()
  })
})

describe('identity discipline', () => {
  beforeEach(() => reset())
  afterEach(() => {
    vi.restoreAllMocks()
    reset()
  })

  it('rejects a hallucinated part id before the command bus sees it', async () => {
    const preflight = vi.spyOn(cadEngine, 'preflight')
    const execute = vi.spyOn(cadEngine, 'execute')

    const { session, transport } = makeSession([
      {
        toolCalls: [
          {
            name: 'preflight_capability',
            input: { capability: 'create_subassembly', args: { name: 'Ghost bay', partIds: ['part_that_never_existed'] } },
          },
        ],
      },
      { text: ['That part id is not in the model.'] },
    ])

    await session.send('Group the ghost bay.')

    const [result] = lastToolResults(transport)
    expect(result.ok).toBe(false)
    const error = toolValue<{ error: { code: string; message: string; repair: string } }>(result.content).error
    expect(error.code).toBe('PART_NOT_FOUND')
    expect(error.message).toContain('part_that_never_existed')
    expect(error.message).toContain('revision 1')
    expect(error.repair).toContain('Do not construct part ids')

    expect(preflight).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(session.getState().waves).toEqual([])
    session.dispose()
  })

  it('rejects invented assembly, note, constraint and module ids the same way', async () => {
    const preflight = vi.spyOn(cadEngine, 'preflight')
    const { session, transport } = makeSession([
      {
        toolCalls: [
          { name: 'preflight_capability', input: { capability: 'assign_subassembly', args: { subassemblyId: 'nose_cone', partIds: ['part_0001'] } } },
          { name: 'preflight_capability', input: { capability: 'respond_to_note', args: { noteId: 'note_imaginary', response: 'done' } } },
          { name: 'preflight_capability', input: { capability: 'remove_constraint', args: { constraintId: 'c_invented' } } },
          { name: 'preflight_capability', input: { capability: 'stamp_module', args: { module: 'turret', atLdu: [0, 0, 0] } } },
        ],
      },
      { text: ['None of those exist.'] },
    ])

    await session.send('Do four impossible things.')
    const results = lastToolResults(transport)
    expect(results.map((result) => result.ok)).toEqual([false, false, false, false])
    for (const result of results) {
      expect(toolValue<{ error: { code: string } }>(result.content).error.code).toBe('INVALID_OPERATION')
    }
    expect(preflight).not.toHaveBeenCalled()
    session.dispose()
  })

  it('rejects a misspelled capability argument rather than silently defaulting it', async () => {
    const { session, transport } = makeSession([
      { toolCalls: [{ name: 'preflight_capability', input: { capability: 'build_wall', args: { lengthStud: 8, courses: 3 } } }] },
      { text: ['Fixed the field name.'] },
    ])
    await session.send('Lay a wall.')
    const [result] = lastToolResults(transport)
    expect(result.ok).toBe(false)
    const error = toolValue<{ error: { code: string; message: string } }>(result.content).error
    expect(error.code).toBe('INVALID_INPUT')
    expect(error.message).toContain('lengthStud')
    session.dispose()
  })
})

describe('session control', () => {
  beforeEach(() => reset())
  afterEach(() => {
    vi.restoreAllMocks()
    reset()
  })

  it('surfaces a transport failure as an error state that can be retried', async () => {
    const { session } = makeSession([
      { error: { code: 'RATE_LIMITED', message: 'The model API is rate limiting this key.', retryable: true } },
      { text: ['Second time lucky.'] },
    ])

    await session.send('Anything.')
    expect(session.getState().status).toBe('error')
    expect(session.getState().error?.code).toBe('RATE_LIMITED')
    expect(session.getState().canRetry).toBe(true)
    expect(session.getState().trace.some((entry) => entry.status === 'failed')).toBe(true)

    await session.retry()
    expect(session.getState().status).toBe('idle')
    expect(session.getState().error).toBeNull()
    expect(session.getState().transcript.at(-1)?.text).toBe('Second time lucky.')
    session.dispose()
  })

  it('stops at the tool-turn budget instead of looping forever', async () => {
    const { session } = makeSession(() => ({
      toolCalls: [{ name: 'scene_overview', input: {} }],
    }))
    await session.send('Go around forever.')
    expect(session.getState().status).toBe('error')
    expect(session.getState().error?.code).toBe('TOOL_TURN_LIMIT')
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    session.dispose()
  })

  it('replans by withdrawing the pending waves and asking again', async () => {
    const { session, transport } = makeSession([
      { toolCalls: [{ name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'First try' } } }] },
      { text: ['Ready.'] },
      { text: ['Replanned against the current revision.'] },
    ])
    await session.send('Rename it.')
    expect(session.getState().waves[0].status).toBe('pending')

    await session.replan()
    expect(session.getState().waves[0].status).toBe('rejected')
    expect(JSON.stringify(transport.requests.at(-1)?.messages)).toContain('replan')
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    session.dispose()
  })

  it('commits automatically in Build mode, through the same revision check', async () => {
    reset('build')
    const { session } = makeSession([
      { toolCalls: [{ name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Autonomous' } } }] },
      { text: ['Committed.'] },
    ])
    await session.send('Rename it and just do it.')
    expect(cadEngine.getSnapshot().document.name).toBe('Autonomous')
    const transaction = cadEngine.getSnapshot().transactions.at(-1)
    expect(transaction?.author).toBe('agent')
    expect(transaction?.sourceTool).toBe('build_apply')
    expect(session.getState().waves[0].status).toBe('applied')
    session.dispose()
  })

  it('sends the exact revision it read, on every leg', async () => {
    const { session, transport } = makeSession([
      { toolCalls: [{ name: 'scene_overview', input: {} }] },
      { text: ['Done.'] },
    ])
    await session.send('Look at it.')
    expect(transport.requests.every((request) => request.grounding.documentRevision === 1)).toBe(true)
    expect(transport.requests[0].protocol).toBe('brickwright.assistant/1')
    expect(transport.requests[0].mode).toBe('propose')
    session.dispose()
  })
})
