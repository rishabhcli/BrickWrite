import { describe, expect, it } from 'vitest'
import { proposalDelta } from './proposalDelta'
import { IDENTITY_BASIS } from '../../cad/math'
import type { ModelDocument, PartInstance, Proposal, Transform } from '../../cad/types'

const pose = (x: number, y: number, z: number): Transform =>
  ({ position: [x, y, z], basis: IDENTITY_BASIS }) as unknown as Transform

const part = (id: string, transform: Transform, color = 4): PartInstance =>
  ({ id, definitionId: '3001', color, transform, subassemblyId: 'hull', stepId: 'step_1', provenance: 'human', protected: false }) as PartInstance

const documentOf = (parts: PartInstance[]): ModelDocument =>
  ({ id: 'd', revision: 1, parts: Object.fromEntries(parts.map((entry) => [entry.id, entry])), subassemblies: {}, steps: [], connections: [] }) as unknown as ModelDocument

const proposalOf = (parts: PartInstance[]): Proposal =>
  ({ id: 'p', status: 'pending', previewDocument: documentOf(parts) }) as unknown as Proposal

describe('proposal delta', () => {
  it('counts a new part, a recolour and a move as added', () => {
    const current = documentOf([part('a', pose(0, 0, 0)), part('b', pose(20, 0, 0)), part('c', pose(40, 0, 0))])
    const proposal = proposalOf([
      part('a', pose(0, 0, 0)),
      part('b', pose(20, 0, 0), 15), // recoloured
      part('c', pose(40, -24, 0)), // moved
      part('d', pose(60, 0, 0)), // new
    ])
    expect(proposalDelta(proposal, current).added.map((entry) => entry.id).sort()).toEqual(['b', 'c', 'd'])
  })

  it('does not count an untouched part whose pose is a different object', () => {
    // The preview document is a separate object graph, so every transform in it
    // is a fresh object. Comparing poses by reference would report the entire
    // model as added and reveal all of it as a ghost — which is exactly what the
    // wave exists to distinguish from the parts the proposal actually touched.
    const parts = ['a', 'b', 'c', 'd', 'e'].map((id, index) => part(id, pose(index * 20, 0, 0)))
    const current = documentOf(parts)
    const proposal = proposalOf(parts.map((entry) => part(entry.id, pose(entry.transform.position[0], 0, 0))))
    expect(proposalDelta(proposal, current).added).toEqual([])
  })

  it('reports what the proposal drops', () => {
    const current = documentOf([part('a', pose(0, 0, 0)), part('b', pose(20, 0, 0))])
    const proposal = proposalOf([part('a', pose(0, 0, 0))])
    const delta = proposalDelta(proposal, current)
    expect(delta.removed.map((entry) => entry.id)).toEqual(['b'])
    expect(delta.added).toEqual([])
  })
})
