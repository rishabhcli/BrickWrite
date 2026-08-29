import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalog } from '../cad/catalog'
import { cadEngine } from '../cad/engine'
import { IDENTITY_BASIS } from '../cad/math'
import { createEmptyDocument, createShowcaseDocument } from '../cad/sample'
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
