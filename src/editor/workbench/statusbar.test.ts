import { describe, expect, it } from 'vitest'
import { describeWorkbenchEscape, describeWorkbenchMode } from './StatusBar'
import type { Workbench } from './useWorkbench'

const base = {
  tool: 'select',
  placement: null,
  connect: { stage: 'source' },
  state: { proposals: [] },
} as unknown as Pick<Workbench, 'tool' | 'placement' | 'connect' | 'state'>

describe('workbench mode chrome copy', () => {
  it('names the active tool, placement, and connect stage', () => {
    expect(describeWorkbenchMode(base)).toBe('SELECT')
    expect(describeWorkbenchMode({ ...base, placement: { definitionId: '3001' } } as typeof base)).toBe('PLACING')
    expect(
      describeWorkbenchMode({
        ...base,
        tool: 'connect',
        connect: { stage: 'target' },
      } as typeof base),
    ).toBe('CONNECT · TARGET')
  })

  it('always explains how Esc leaves the current mode', () => {
    expect(describeWorkbenchEscape(base)).toBe('Esc returns to Select')
    expect(describeWorkbenchEscape({ ...base, placement: { definitionId: '3001' } } as typeof base)).toBe(
      'Esc puts the part back',
    )
    expect(
      describeWorkbenchEscape({
        ...base,
        tool: 'connect',
        connect: { stage: 'target' },
      } as typeof base),
    ).toBe('Esc backs out one stage')
    expect(
      describeWorkbenchEscape({
        ...base,
        state: { proposals: [{ id: 'p1' }] },
      } as typeof base),
    ).toBe('Esc rejects the ghost proposal')
  })
})
