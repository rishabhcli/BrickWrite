import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalog } from '../cad/catalog'
import { cadEngine } from '../cad/engine'
import { IDENTITY_BASIS } from '../cad/math'
import { createBlankDocument, createEmptyDocument, createShowcaseDocument } from '../cad/sample'
import { replayBrick } from '../generation/__fixtures__/run'
import { disposeGenerationHost, getGenerationSession } from '../generation/host'
import type { PartInstance } from '../cad/types'
import { WaveLedger } from './modes'
import { createToolHost } from './tools'

const brick = (id: string): PartInstance => ({
  id,
  definitionId: '3001',
  color: 72,
  transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
  subassemblyId: 'hull',
  stepId: 'step_1',
  provenance: 'human',
  protected: false,
})

function plateTileId(): string {
  if (catalog.get('3070b')) return '3070b'
  const found = catalog.placeable().find((item) => {
    if (item.connectors.some((feature) => feature.family === 'stud')) return false
    const bounds = item.dimensions?.bounds
    return Boolean(bounds) && bounds!.max[1] - bounds!.min[1] <= 10
  })
  if (!found) throw new Error('compiled catalog has no plate-height tile')
  return found.canonicalId
}

describe('tool host', () => {
  beforeEach(() => {
    cadEngine.replaceDocument(createShowcaseDocument())
    cadEngine.setAutonomy('propose')
    cadEngine.setSelection(['part_0001'])
  })

  afterEach(() => {
    cadEngine.replaceDocument(createShowcaseDocument())
    cadEngine.setAutonomy('propose')
  })

  it('tells the model which faces of the selection can actually receive a part', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('anchor') }], 'human', 0)
    cadEngine.setSelection(['anchor'])
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({ id: 'g1', name: 'selection_geometry', input: { reference: '@selection' } })
    expect(result.ok).toBe(true)
    const body = JSON.parse(result.content) as {
      connectors: { approaches: { 'on-top': boolean }; freeByFamily: Record<string, number> }
    }
    expect(body.connectors.approaches['on-top']).toBe(true)
    expect(body.connectors.freeByFamily.stud).toBeGreaterThan(0)
  })

  it('refuses a second identical preflight instead of looping', async () => {
    const host = createToolHost({ waves: new WaveLedger() })
    const input = { definitionId: 'sarlacc-9000', anchorPartId: 'part_0001', approach: 'on-top' }
    const first = await host.execute({ id: 'p1', name: 'preflight_placement', input })
    expect(first.ok).toBe(false)
    expect(JSON.parse(first.content).error.code).not.toBe('REPEAT_REFUSED')

    const second = await host.execute({ id: 'p2', name: 'preflight_placement', input })
    expect(second.ok).toBe(false)
    const error = JSON.parse(second.content).error as { code: string; repair: string }
    expect(error.code).toBe('REPEAT_REFUSED')
    expect(error.repair).toMatch(/Do not retry/)
  })

  it('names occupied studs separately from a surface that never had them', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('base') }], 'human', 0)
    cadEngine.execute('Stack', [{ type: 'part.add', part: { ...brick('upper'), transform: { position: [0, -24, 0], basis: IDENTITY_BASIS } } }], 'human', 1)
    expect(Object.keys(cadEngine.getSnapshot().document.parts)).toHaveLength(2)
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({
      id: 'p3',
      name: 'preflight_placement',
      input: { definitionId: '3001', anchorPartId: 'base', approach: 'on-top' },
    })
    expect(result.ok).toBe(false)
    const error = JSON.parse(result.content).error as {
      code: string
      details?: { openApproaches?: string[]; placeableAnchors?: Array<{ id: string }>; next?: { tool: string; args?: Record<string, unknown> } }
    }
    expect(error.code).toBe('CONNECTOR_OCCUPIED')
    expect(error.details?.openApproaches).toBeDefined()
    expect(error.details?.placeableAnchors?.some((entry) => entry.id === 'upper')).toBe(true)
    expect(error.details?.next?.tool).toBe('preflight_placement')
    expect(error.details?.next?.args).toEqual({ definitionId: '3001', anchorPartId: 'upper', approach: 'on-top' })
  })

  it('names a tile as having no connector rather than an occupied one', async () => {
    const tileId = plateTileId()
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute(
      'Tile',
      [
        {
          type: 'part.add',
          part: {
            ...brick('tile'),
            definitionId: tileId,
          },
        },
      ],
      'human',
      0,
    )
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({
      id: 'p4',
      name: 'preflight_placement',
      input: { definitionId: '3001', anchorPartId: 'tile', approach: 'on-top' },
    })
    expect(result.ok).toBe(false)
    expect(JSON.parse(result.content).error.code).toBe('NO_COMPATIBLE_CONNECTOR')
  })

  it('lists which faces of each queried part can receive a brick', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('anchor') }], 'human', 0)
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({ id: 'q1', name: 'scene_query', input: { includeNeighbours: true } })
    expect(result.ok).toBe(true)
    const body = JSON.parse(result.content) as { parts: Array<{ id: string; approaches: { 'on-top': boolean } }> }
    expect(body.parts[0]?.id).toBe('anchor')
    expect(body.parts[0]?.approaches['on-top']).toBe(true)
  })

  it('lists placeable anchors on the overview so the model does not pick a full brick', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('anchor') }], 'human', 0)
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({ id: 'o1', name: 'scene_overview', input: {} })
    expect(result.ok).toBe(true)
    const body = JSON.parse(result.content) as { placeableAnchors: Array<{ id: string; approaches: { 'on-top': boolean } }> }
    expect(body.placeableAnchors[0]?.id).toBe('anchor')
    expect(body.placeableAnchors[0]?.approaches['on-top']).toBe(true)
  })

  it('lists spatially nearby parts even when they share no connection edge', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('anchor') }], 'human', 0)
    cadEngine.execute(
      'Second building',
      [{ type: 'part.add', part: { ...brick('island'), transform: { position: [400, 0, 0], basis: IDENTITY_BASIS } } }],
      'human',
      1,
    )
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({
      id: 'q2',
      name: 'scene_query',
      input: { includeNeighbours: true, partIds: ['anchor'] },
    })
    expect(result.ok).toBe(true)
    const body = JSON.parse(result.content) as {
      parts: Array<{ id: string; connectedTo: string[]; nearby: Array<{ id: string; approaches: { 'on-top': boolean } }> }>
    }
    expect(body.parts[0]?.id).toBe('anchor')
    expect(body.parts[0]?.connectedTo).toEqual([])
    expect(body.parts[0]?.nearby.some((entry) => entry.id === 'island' && entry.approaches['on-top'])).toBe(true)
  })

  it('lists spatially nearby parts from selection_geometry', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('anchor') }], 'human', 0)
    cadEngine.execute(
      'Second building',
      [{ type: 'part.add', part: { ...brick('island'), transform: { position: [400, 0, 0], basis: IDENTITY_BASIS } } }],
      'human',
      1,
    )
    cadEngine.setSelection(['anchor'])
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({ id: 'g2', name: 'selection_geometry', input: { reference: '@selection' } })
    expect(result.ok).toBe(true)
    const body = JSON.parse(result.content) as {
      neighbourPartIds: string[]
      nearby: Array<{ id: string; approaches: { 'on-top': boolean } }>
    }
    expect(body.neighbourPartIds).toEqual([])
    expect(body.nearby.some((entry) => entry.id === 'island' && entry.approaches['on-top'])).toBe(true)
  })

  it('points connect_parts at another nearby id when a mate is refused', async () => {
    const tileId = plateTileId()
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute(
      'Tiles',
      [
        { type: 'part.add', part: { ...brick('tileA'), definitionId: tileId } },
        { type: 'part.add', part: { ...brick('tileB'), definitionId: tileId, transform: { position: [400, 0, 0], basis: IDENTITY_BASIS } } },
        { type: 'part.add', part: { ...brick('anchor'), transform: { position: [800, 0, 0], basis: IDENTITY_BASIS } } },
      ],
      'human',
      0,
    )
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({
      id: 'c1',
      name: 'preflight_capability',
      input: { capability: 'connect_parts', args: { movingPartId: 'tileA', targetPartId: 'tileB' } },
    })
    expect(result.ok).toBe(false)
    const error = JSON.parse(result.content).error as {
      code: string
      details?: { nearbyPartId?: string; next?: { tool: string; args?: { capability?: string; args?: { targetPartId?: string } } } }
    }
    expect(error.code === 'NO_COMPATIBLE_CONNECTOR' || error.code === 'COLLISION' || error.code === 'CONNECTOR_OCCUPIED').toBe(true)
    expect(error.details?.nearbyPartId).toBeTruthy()
    expect(error.details?.nearbyPartId).not.toBe('tileB')
    expect(error.details?.next?.tool).toBe('preflight_capability')
    expect(error.details?.next?.args?.capability).toBe('connect_parts')
    expect(error.details?.next?.args?.args?.targetPartId).toBe(error.details?.nearbyPartId)
  })

  it('does not tell the model to type a collision clearance as a transform', async () => {
    cadEngine.replaceDocument(createEmptyDocument())
    cadEngine.execute('Foundation', [{ type: 'part.add', part: brick('anchor') }], 'human', 0)
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({
      id: 'r1',
      name: 'repair_suggest',
      input: { failureCode: 'COLLISION' },
    })
    expect(result.ok).toBe(true)
    const body = JSON.parse(result.content) as {
      collisions: Array<{ suggestion: string; suggestedClearanceLdu: number[] }>
      next: { tool: string }
    }
    for (const collision of body.collisions) {
      expect(collision.suggestion).toMatch(/Do not invent XYZ/)
      expect(collision.suggestion).not.toMatch(/Move \S+ by /)
    }
    expect(body.next.tool).toBeTruthy()
  })

  it('points a hovering brick at connect_parts from repair_suggest', async () => {
    const document = createEmptyDocument()
    cadEngine.replaceDocument({
      ...document,
      parts: {
        anchor: brick('anchor'),
        ghost: { ...brick('ghost'), transform: { position: [0, -200, 0], basis: IDENTITY_BASIS } },
      },
      subassemblies: {
        ...document.subassemblies,
        hull: { ...document.subassemblies.hull, partIds: ['anchor', 'ghost'] },
      },
    })
    cadEngine.setAutonomy('propose')
    const host = createToolHost({ waves: new WaveLedger() })
    const result = await host.execute({
      id: 'r2',
      name: 'repair_suggest',
      input: { failureCode: 'DISCONNECTED' },
    })
    expect(result.ok).toBe(true)
    const body = JSON.parse(result.content) as {
      floatingPartIds: string[]
      next: { tool: string; args?: { capability?: string; args?: { movingPartId?: string; targetPartId?: string } } }
    }
    expect(body.floatingPartIds).toContain('ghost')
    expect(body.next.tool).toBe('preflight_capability')
    expect(body.next.args?.capability).toBe('connect_parts')
    expect(body.next.args?.args?.movingPartId).toBe('ghost')
    expect(body.next.args?.args?.targetPartId).toBe('anchor')
  })
})

describe('generation through the Design Partner', () => {
  const ARMCHAIR = 'A green armchair 6 x 6 studs, 6 studs tall, at most 90 pieces'

  beforeEach(() => {
    cadEngine.replaceDocument(createBlankDocument('Design Partner generation'))
    cadEngine.setAutonomy('propose')
    getGenerationSession({ tickMs: 0, runner: replayBrick })
  })

  afterEach(() => {
    disposeGenerationHost()
    cadEngine.replaceDocument(createShowcaseDocument())
    cadEngine.setAutonomy('propose')
  })

  const body = (result: { content: string }) => JSON.parse(result.content) as Record<string, never>

  const drive = async (host: ReturnType<typeof createToolHost>) => {
    const compiled = body(await host.execute({ id: 'c1', name: 'generation_compile', input: { prompt: ARMCHAIR, useModel: false } }))
    for (const field of (compiled.unresolvedConflicts as string[]) ?? []) {
      await host.execute({ id: `s_${field}`, name: 'generation_set', input: { conflict: { field, choice: 'compiler' } } })
    }
    return body(await host.execute({ id: 'r1', name: 'generation_run', input: { useModel: false } }))
  }

  it('compiles a sentence, runs the pipeline and stages the candidate as one wave', async () => {
    const waves = new WaveLedger()
    const host = createToolHost({ waves })

    const ran = await drive(host)
    expect(ran.runPhase).toBe('ready')
    expect(ran.usedModel).toBe(false)
    // The kernel's own instruction after a run is to review the candidate, not
    // to start placing its parts.
    expect(ran.nextTool).toBe('generation_preview')
    expect(ran.nextAction).toMatch(/Do not place its parts individually/)

    const preview = body(await host.execute({ id: 'p1', name: 'generation_preview', input: { candidateId: ran.candidates[0].id } }))
    expect(preview.waveId).toEqual(expect.any(String))
    expect(preview.status).toMatch(/awaiting review/)
    expect(preview.capability).toBe('generate_from_brief')

    // One wave, holding the whole candidate. Not one wave per part.
    expect(waves.pending()).toHaveLength(1)
    expect(waves.pending()[0].operations.length).toBe(preview.operations)
    expect(cadEngine.getDocument().revision).toBe(preview.documentRevision)
    expect(Object.keys(cadEngine.getDocument().parts)).toHaveLength(0)
  })

  it('labels the wave from the brief subject so a reviewer reads what they asked for', async () => {
    const waves = new WaveLedger()
    const host = createToolHost({ waves })
    const ran = await drive(host)
    await host.execute({ id: 'p1', name: 'generation_preview', input: { candidateId: ran.candidates[0].id } })
    expect(waves.pending()[0].label).toMatch(/^Generated: /)
  })

  it('shares one session with the Generate panel', async () => {
    const host = createToolHost({ waves: new WaveLedger() })
    await host.execute({ id: 'c1', name: 'generation_compile', input: { prompt: ARMCHAIR, useModel: false } })
    expect(getGenerationSession().getState().prompt).toBe(ARMCHAIR)

    getGenerationSession().setPrompt('A harbour control tower')
    const state = body(await host.execute({ id: 's1', name: 'generation_state', input: {} }))
    expect(state.prompt).toBe('A harbour control tower')
  })

  it('reads in Inspect but refuses to stage anything there', async () => {
    cadEngine.setAutonomy('inspect')
    const host = createToolHost({ waves: new WaveLedger() })
    const compiled = await host.execute({ id: 'c1', name: 'generation_compile', input: { prompt: ARMCHAIR, useModel: false } })
    expect(compiled.ok).toBe(true)
    expect((await host.execute({ id: 's1', name: 'generation_state', input: {} })).ok).toBe(true)

    const preview = await host.execute({ id: 'p1', name: 'generation_preview', input: { candidateId: 'cand_brick' } })
    expect(preview.ok).toBe(false)
    expect(body(preview).error.code).toBe('READ_ONLY_MODE')
  })

  it('names an unknown candidate rather than staging an empty wave', async () => {
    const waves = new WaveLedger()
    const host = createToolHost({ waves })
    await drive(host)
    const refused = await host.execute({ id: 'p1', name: 'generation_preview', input: { candidateId: 'cand_invented' } })
    expect(refused.ok).toBe(false)
    expect(body(refused).error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/not in the current run/) })
    expect(waves.pending()).toHaveLength(0)
  })

  it('offers no commit tool, in any mode', () => {
    cadEngine.setAutonomy('build')
    const host = createToolHost({ waves: new WaveLedger() })
    const names = host.declarations.map((tool) => tool.name)
    expect(names).toContain('generation_preview')
    expect(names).not.toContain('generation_apply')
  })

  it('tells the model that preflight_placement is one brick and never a build strategy', () => {
    const host = createToolHost({ waves: new WaveLedger() })
    const placement = host.declarations.find((tool) => tool.name === 'preflight_placement')!
    expect(placement.description).toMatch(/ONE catalog part/)
    expect(placement.description).toMatch(/never lay a building, a vehicle, a mechanism or a set brick by brick/)
    expect(placement.description).toMatch(/generation_compile/)
  })
})
