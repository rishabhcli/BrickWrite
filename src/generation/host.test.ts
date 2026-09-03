import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import {createBlankDocument} from '../cad/sample'
import { createRoverDocument } from '../cad/__fixtures__/rover'
import { ContractError } from '../webmcp/contract'
import { replayBrick } from './__fixtures__/run'
import { disposeGenerationHost, getGenerationHost, getGenerationSession, peekGenerationSession } from './host'
import * as mcpHost from './mcpHost'

const ARMCHAIR = 'A green armchair 6 x 6 studs, 6 studs tall, at most 90 pieces'

beforeEach(() => {
  cadEngine.replaceDocument(createBlankDocument('Generation host'))
  getGenerationSession({ tickMs: 0, runner: replayBrick })
})

afterEach(() => {
  disposeGenerationHost()
  cadEngine.replaceDocument(createRoverDocument())
})

const settle = (host = getGenerationHost()) => {
  for (const field of host.state().unresolvedConflicts) host.set({ conflict: { field, choice: 'compiler' } })
}

describe('the generation host', () => {
  it('drives the one session every other surface reads', () => {
    const host = getGenerationHost()
    host.compileLocal(ARMCHAIR)

    // Not "a brief exists somewhere" — the same session object the Generate
    // panel is bound to, so a brief compiled by the assistant is the brief the
    // builder sees, and neither can strand a ghost the other cannot discard.
    expect(peekGenerationSession()?.getState().brief?.subject).toEqual(expect.any(String))
    expect(host.state().prompt).toBe(ARMCHAIR)
    expect(mcpHost.generationState().brief).toEqual(host.state().brief)
  })

  it('runs, previews and applies without a model', () => {
    cadEngine.setAutonomy('build')
    const host = getGenerationHost()
    host.compileLocal(ARMCHAIR)
    settle(host)
    host.set({ candidateCount: 1 })

    return host.run({ useModel: false }).then((ran) => {
      expect(ran.runPhase).toBe('ready')
      expect(ran.usedModel).toBe(false)
      expect(ran.candidates).toMatchObject([{ id: 'cand_brick', partCount: 1 }])

      const before = cadEngine.getDocument().revision
      expect(host.preview('cand_brick').ghost).toBeTruthy()
      const applied = host.apply(before)
      expect(applied.outcome).toMatchObject({ kind: 'applied' })
      expect(Object.values(cadEngine.getDocument().parts)).toHaveLength(1)
    })
  })

  it('refuses with the code and the repair rather than a bare throw', async () => {
    const host = getGenerationHost()
    expect(() => host.compileLocal('   ')).toThrow(ContractError)
    await expect(host.run({ useModel: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    host.compileLocal(ARMCHAIR)
    settle(host)
    await host.run({ useModel: false })
    expect(() => host.preview('cand_nonexistent')).toThrow(/not in the current run/)
  })

  it('keeps the WebMCP names pointing at the same implementations', () => {
    expect(mcpHost.getGenerationHost).toBe(getGenerationHost)
    expect(mcpHost.getGenerationSession).toBe(getGenerationSession)
  })
})
