import { describe, expect, it } from 'vitest'
import { IDENTITY_BASIS } from '../../cad/math'
import type { WorldConnector } from '../../cad/snapping'
import { connectorChipLabel, connectorStudCell } from './ConnectPanel'

const stud = (id: string, x: number, z: number): WorldConnector =>
  ({
    id,
    partId: 'a',
    definitionId: '3001',
    family: 'stud',
    gender: 'male',
    frame: { position: [x, 0, z], basis: IDENTITY_BASIS },
    axis: [0, 1, 0],
    feature: {
      id,
      family: 'stud',
      gender: 'male',
      pos: [x, 0, z],
      src: 'test',
    },
  }) as WorldConnector

describe('Connect chip labels', () => {
  it('names studs by local cell instead of family index', () => {
    const siblings = [stud('s0', -20, -40), stud('s1', 20, -40), stud('s2', -20, -20)]
    expect(connectorStudCell(siblings[0]!)).toEqual([-1, -2])
    expect(connectorChipLabel(siblings[0]!, siblings)).toBe('stud M -1,-2')
    expect(connectorChipLabel(siblings[1]!, siblings)).toBe('stud M 1,-2')
    expect(new Set(siblings.map((entry) => connectorChipLabel(entry, siblings))).size).toBe(3)
    expect(connectorChipLabel(siblings[0]!, siblings)).not.toMatch(/M\d+$/)
  })
})
