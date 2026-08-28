import { describe, expect, it } from 'vitest'
import { TraceLedger } from './trace'

describe('activity ledger', () => {
  it('opens a pending entry and closes it exactly once', () => {
    let clock = 1000
    const ledger = new TraceLedger({ now: () => clock })
    const id = ledger.begin('tool', 'scene_overview', 4)
    expect(ledger.pending().length).toBe(1)
    clock = 1120
    ledger.succeed(id, { bytes: 812 })
    expect(ledger.pending()).toEqual([])
    const [entry] = ledger.entries()
    expect(entry.status).toBe('ok')
    expect(entry.durationMs).toBe(120)
    expect(entry.detail).toMatchObject({ bytes: 812 })
  })

  it('records a failure with its reason instead of leaving it pending', () => {
    const ledger = new TraceLedger()
    const id = ledger.begin('proposal', 'Lay a wall', 7)
    ledger.fail(id, 'COLLISION: two parts overlap')
    const [entry] = ledger.entries()
    expect(entry.status).toBe('failed')
    expect(entry.problem).toContain('COLLISION')
    expect(ledger.failures().length).toBe(1)
  })

  it('never leaves a stream failure looking like work in progress', () => {
    const ledger = new TraceLedger()
    ledger.begin('tool', 'catalog_search', 2)
    ledger.begin('tool', 'render_capture', 2)
    ledger.failAllPending('The connection dropped')
    expect(ledger.pending()).toEqual([])
    expect(ledger.failures().length).toBe(2)
    for (const entry of ledger.entries()) expect(entry.problem).toBe('The connection dropped')
  })

  it('refuses to carry fabricated reasoning', () => {
    const ledger = new TraceLedger()
    expect(() => ledger.begin('tool', 'x', 1, { reasoning: 'I decided to…' })).toThrow(/records what happened/)
    expect(() => ledger.note('tool', 'x', 1, { thought: 'hmm' })).toThrow()
    expect(() => ledger.noteFailure('error', 'x', 1, 'boom', { rationale: 'because' })).toThrow()
    // The type has no such field either; this guards the untyped detail bag.
    expect(JSON.stringify(ledger.entries())).not.toMatch(/thought|reasoning|thinking/)
  })

  it('keeps entries in the order they happened and reports the revision each ran at', () => {
    const ledger = new TraceLedger()
    ledger.note('message', 'Operator message', 3)
    const toolId = ledger.begin('tool', 'scene_query', 3)
    ledger.succeed(toolId)
    ledger.note('commit', 'Lay a wall', 4)
    expect(ledger.entries().map((entry) => entry.revision)).toEqual([3, 3, 4])
    expect(ledger.summarize().split('\n')).toEqual([
      '✓ r3 message: Operator message',
      '✓ r3 tool: scene_query',
      '✓ r4 commit: Lay a wall',
    ])
  })

  it('marks a failure in the summary rather than hiding it among successes', () => {
    const ledger = new TraceLedger()
    const id = ledger.begin('commit', 'Apply wave', 9)
    ledger.fail(id, 'PROPOSAL_STALE: the document moved')
    expect(ledger.summarize()).toContain('✗ r9 commit: Apply wave — PROPOSAL_STALE')
  })

  it('notifies subscribers on every transition', () => {
    const ledger = new TraceLedger()
    let notifications = 0
    const stop = ledger.subscribe(() => {
      notifications += 1
    })
    const id = ledger.begin('tool', 'validate_model', 1)
    ledger.succeed(id)
    ledger.note('reject', 'Wave rejected', 1)
    stop()
    ledger.clear()
    expect(notifications).toBe(3)
  })
})
