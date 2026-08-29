import { describe, expect, it } from 'vitest'
import { nextAgentAction } from './guidance'

const ready = {
  partCount: 12,
  selectionCount: 1,
  collisions: 0,
  disconnectedParts: 0,
  floatingParts: 0,
  tipping: false,
}

describe('nextAgentAction', () => {
  it('forbids preflight_placement on an empty plate', () => {
    const step = nextAgentAction({ ...ready, partCount: 0, selectionCount: 0 })
    expect(step.tool).toBe('capability_search')
    expect(step.args).toEqual({ query: 'build_field' })
    expect(step.action).toMatch(/empty/)
    expect(step.action).toMatch(/Do not call preflight_placement/)
  })

  it('sends a collision to repair_suggest rather than a retry', () => {
    const step = nextAgentAction({ ...ready, collisions: 2, failureCode: 'COLLISION' })
    expect(step.tool).toBe('repair_suggest')
    expect(step.args).toEqual({ failureCode: 'COLLISION' })
    expect(step.action).toMatch(/Do not retry the same/)
    expect(step.action).toMatch(/different face/)
  })

  it('reads neighbours before inventing coordinates for a hovering brick', () => {
    const step = nextAgentAction({ ...ready, floatingParts: 1, failureCode: 'DISCONNECTED' })
    expect(step.tool).toBe('scene_query')
    expect(step.args).toEqual({ includeNeighbours: true })
    expect(step.action).toMatch(/Never invent XYZ/)
  })

  it('mates the hovering brick onto a measured nearby anchor', () => {
    const step = nextAgentAction({
      ...ready,
      floatingParts: 1,
      failureCode: 'DISCONNECTED',
      floatingPartId: 'ghost',
      nearbyAnchorId: 'wall_07',
    })
    expect(step.tool).toBe('preflight_capability')
    expect(step.args).toEqual({
      capability: 'connect_parts',
      args: { movingPartId: 'ghost', targetPartId: 'wall_07' },
    })
    expect(step.action).toMatch(/ghost/)
    expect(step.action).toMatch(/do not add a new/)
  })

  it('scopes scene_query to the hovering part when no nearby anchor is known', () => {
    const step = nextAgentAction({
      ...ready,
      floatingParts: 1,
      failureCode: 'DISCONNECTED',
      floatingPartId: 'ghost',
    })
    expect(step.tool).toBe('scene_query')
    expect(step.args).toEqual({ includeNeighbours: true, partIds: ['ghost'] })
  })

  it('rereads after a stale revision', () => {
    expect(nextAgentAction({ ...ready, failureCode: 'STALE_DOCUMENT' }).tool).toBe('scene_overview')
  })

  it('does not retry the same refused arguments', () => {
    const step = nextAgentAction({ ...ready, failureCode: 'REPEAT_REFUSED' })
    expect(step.tool).toBe('repair_suggest')
    expect(step.args).toEqual({ failureCode: 'REPEAT_REFUSED' })
    expect(step.action).toMatch(/Do not retry/)
  })

  it('reads free connectors after a mate refusal', () => {
    const step = nextAgentAction({ ...ready, failureCode: 'NO_COMPATIBLE_CONNECTOR' })
    expect(step.tool).toBe('selection_geometry')
    expect(step.args).toEqual({ reference: '@selection' })
    expect(step.action).toMatch(/free/)
  })

  it('looks for another anchor when every stud is taken', () => {
    const step = nextAgentAction({ ...ready, failureCode: 'CONNECTOR_OCCUPIED' })
    expect(step.tool).toBe('scene_query')
    expect(step.args).toEqual({ includeNeighbours: true })
    expect(step.action).toMatch(/occupied/)
  })

  it('preflights the same identity onto a measured free anchor when one exists', () => {
    const step = nextAgentAction({
      ...ready,
      failureCode: 'CONNECTOR_OCCUPIED',
      triedDefinitionId: '3001',
      placeableAnchorId: 'wall_07',
    })
    expect(step.tool).toBe('preflight_placement')
    expect(step.args).toEqual({ definitionId: '3001', anchorPartId: 'wall_07', approach: 'on-top' })
    expect(step.action).toMatch(/wall_07/)
  })

  it('does not send repair_suggest back to itself', () => {
    const step = nextAgentAction({ ...ready, collisions: 2, failureCode: 'COLLISION', seenRepair: true })
    expect(step.tool).toBe('scene_query')
    expect(step.args).toEqual({ includeNeighbours: true })
    expect(step.action).toMatch(/Do not retry/)
  })

  it('preflights a measured free anchor after a tile refusal when one exists', () => {
    const step = nextAgentAction({
      ...ready,
      failureCode: 'NO_COMPATIBLE_CONNECTOR',
      triedDefinitionId: '3001',
      placeableAnchorId: 'wall_07',
    })
    expect(step.tool).toBe('preflight_placement')
    expect(step.args).toEqual({ definitionId: '3001', anchorPartId: 'wall_07', approach: 'on-top' })
  })
})
