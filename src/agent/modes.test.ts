import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createShowcaseDocument } from '../cad/sample'
import type { CadOperation } from '../cad/types'
import { WaveLedger, capabilitiesFor, currentMode, setMode } from './modes'
import { TraceLedger } from './trace'

const rename = (name: string): CadOperation[] => [{ type: 'document.rename', name }]
const recolor = (partId: string, color: number): CadOperation[] => [{ type: 'part.recolor', partId, color }]

describe('autonomy modes', () => {
  let trace: TraceLedger
  let waves: WaveLedger

  beforeEach(() => {
    cadEngine.replaceDocument(createShowcaseDocument())
    setMode('propose')
    trace = new TraceLedger()
    waves = new WaveLedger(trace)
  })

  afterEach(() => {
    cadEngine.replaceDocument(createShowcaseDocument())
    setMode('propose')
  })

  it('declares what each mode may do', () => {
    expect(capabilitiesFor('inspect')).toEqual({ canRead: true, canPreflight: false, canAutoApply: false })
    expect(capabilitiesFor('propose')).toEqual({ canRead: true, canPreflight: true, canAutoApply: false })
    expect(capabilitiesFor('build')).toEqual({ canRead: true, canPreflight: true, canAutoApply: true })
    setMode('inspect')
    expect(currentMode()).toBe('inspect')
  })

  it('refuses to propose at all in Inspect', () => {
    setMode('inspect')
    const result = waves.propose({ label: 'Rename', operations: rename('Nope') })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('READ_ONLY_MODE')
    expect(cadEngine.getSnapshot().document.name).toBe('Survey rover')
  })

  // ---- GATE: Propose is mutation-free -------------------------------
  it('leaves the document revision untouched after any number of proposals', () => {
    const before = cadEngine.getSnapshot().document
    const beforeRevision = before.revision
    const beforeName = before.name
    const beforeColor = before.parts.part_0001.color

    for (let index = 0; index < 25; index += 1) {
      const result = waves.propose({ label: `Rename ${index}`, operations: rename(`Candidate ${index}`) })
      expect(result.ok).toBe(true)
    }
    for (let index = 0; index < 10; index += 1) {
      expect(waves.propose({ label: `Recolor ${index}`, operations: recolor('part_0001', 15) }).ok).toBe(true)
    }

    const after = cadEngine.getSnapshot().document
    expect(after.revision).toBe(beforeRevision)
    expect(after.name).toBe(beforeName)
    expect(after.parts.part_0001.color).toBe(beforeColor)
    expect(cadEngine.getSnapshot().transactions.length).toBe(0)
    expect(waves.pending().length).toBe(35)
  })

  it('reports a preview validation without applying it', () => {
    const result = waves.propose({ label: 'Recolour the nose', operations: recolor('part_0001', 15) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.wave.status).toBe('pending')
    expect(result.wave.validation?.partCount).toBe(33)
    expect(result.wave.changedPartIds).toEqual(['part_0001'])
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
  })

  it('refuses a wave that touches a protected region, at proposal time', () => {
    const result = waves.propose({ label: 'Recolour the canopy', operations: recolor('part_0023', 15) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PROTECTED_REGION')
    expect(result.error.message).toContain('part_0023')
    expect(trace.failures().length).toBe(1)
  })

  it('refuses an empty wave rather than committing nothing', () => {
    const result = waves.propose({ label: 'Nothing', operations: [] })
    expect(result.ok).toBe(false)
  })

  // ---- GATE: Build re-checks the revision before applying ------------
  it('fails loudly when the document moved between proposal and accept', () => {
    const proposed = waves.propose({ label: 'Rename to Alpha', operations: rename('Alpha') })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return

    // A person edits the model in the meantime.
    expect(cadEngine.execute('Human rename', rename('Human edit'), 'human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(2)

    const applied = waves.apply(proposed.wave.id, { actor: 'human' })
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.error.code).toBe('PROPOSAL_STALE')
    expect(applied.error.message).toContain('planned at revision 1')
    expect(applied.error.message).toContain('document is at 2')
    expect(waves.get(proposed.wave.id)?.status).toBe('stale')
    expect(cadEngine.getSnapshot().document.name).toBe('Human edit')
  })

  it('will not let the agent commit outside Build mode', () => {
    const proposed = waves.propose({ label: 'Rename', operations: rename('Agent') })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    const result = waves.apply(proposed.wave.id, { actor: 'agent' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('READ_ONLY_MODE')
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
  })

  it('lets a person accept a wave while the mode stays Propose', () => {
    const proposed = waves.propose({ label: 'Rename to Beta', operations: rename('Beta') })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    const applied = waves.apply(proposed.wave.id, { actor: 'human' })
    expect(applied.ok).toBe(true)
    expect(cadEngine.getSnapshot().document.name).toBe('Beta')
    expect(cadEngine.getSnapshot().autonomy).toBe('propose')
    expect(waves.get(proposed.wave.id)?.status).toBe('applied')
  })

  it('lets the agent commit in Build mode, through the same ledger a click uses', () => {
    setMode('build')
    const proposed = waves.propose({ label: 'Rename to Gamma', operations: rename('Gamma') })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    expect(waves.apply(proposed.wave.id, { actor: 'agent' }).ok).toBe(true)
    const transaction = cadEngine.getSnapshot().transactions.at(-1)
    expect(transaction?.author).toBe('agent')
    expect(transaction?.sourceTool).toBe('build_apply')
  })

  // ---- GATE: multi-wave accept with rebase ---------------------------
  it('rebases the remaining waves after each accept, so several can land in order', () => {
    const first = waves.propose({ label: 'Rename to Delta', operations: rename('Delta') })
    const second = waves.propose({ label: 'Recolour the nose', operations: recolor('part_0001', 15) })
    const third = waves.propose({ label: 'Recolour the tail', operations: recolor('part_0002', 15) })
    expect([first.ok, second.ok, third.ok]).toEqual([true, true, true])
    if (!first.ok || !second.ok || !third.ok) return
    expect(cadEngine.getSnapshot().document.revision).toBe(1)

    expect(waves.apply(first.wave.id, { actor: 'human' }).ok).toBe(true)
    expect(cadEngine.getSnapshot().document.revision).toBe(2)
    // The kernel cleared its proposals on commit; the survivors were re-planned.
    expect(waves.pending().map((wave) => wave.baseRevision)).toEqual([2, 2])

    expect(waves.apply(second.wave.id, { actor: 'human' }).ok).toBe(true)
    expect(waves.apply(third.wave.id, { actor: 'human' }).ok).toBe(true)

    const document = cadEngine.getSnapshot().document
    expect(document.revision).toBe(4)
    expect(document.name).toBe('Delta')
    expect(document.parts.part_0001.color).toBe(15)
    expect(document.parts.part_0002.color).toBe(15)
    expect(waves.list().every((wave) => wave.status === 'applied')).toBe(true)
  })

  it('marks a wave stale, with the kernel’s reason, when a rebase can no longer apply it', () => {
    const wave = waves.propose({ label: 'Recolour part_0003', operations: recolor('part_0003', 15) })
    expect(wave.ok).toBe(true)
    if (!wave.ok) return

    expect(cadEngine.execute('Delete it', [{ type: 'part.remove', partId: 'part_0003' }], 'human').ok).toBe(true)
    const rebase = waves.rebasePending()
    expect(rebase.stale).toEqual([wave.wave.id])
    expect(waves.get(wave.wave.id)?.problem).toContain('part_0003')
  })

  // ---- GATE: rejection ----------------------------------------------
  it('rejecting a wave leaves the document exactly as it was', () => {
    const proposed = waves.propose({ label: 'Rename to Epsilon', operations: rename('Epsilon') })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    expect(cadEngine.getSnapshot().proposals.length).toBe(1)

    const rejected = waves.reject(proposed.wave.id, 'Wrong name')
    expect(rejected.ok).toBe(true)
    expect(waves.get(proposed.wave.id)?.status).toBe('rejected')
    expect(waves.get(proposed.wave.id)?.problem).toBe('Wrong name')
    expect(cadEngine.getSnapshot().proposals.length).toBe(0)
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    expect(cadEngine.getSnapshot().document.name).toBe('Survey rover')

    const reapply = waves.apply(proposed.wave.id, { actor: 'human' })
    expect(reapply.ok).toBe(false)
  })

  // ---- GATE: one undoable history -----------------------------------
  it('puts agent and human changes in the same undoable history', () => {
    setMode('build')

    // human, agent, human, agent — interleaved through the same command bus.
    expect(cadEngine.execute('Human: rename', rename('H1'), 'human').ok).toBe(true)
    const agentWave = waves.propose({ label: 'Agent: recolour', operations: recolor('part_0001', 15) })
    expect(agentWave.ok).toBe(true)
    if (!agentWave.ok) return
    expect(waves.apply(agentWave.wave.id, { actor: 'agent' }).ok).toBe(true)
    expect(cadEngine.execute('Human: recolour', recolor('part_0002', 15), 'human').ok).toBe(true)
    const agentWave2 = waves.propose({ label: 'Agent: rename', operations: rename('A2') })
    expect(agentWave2.ok).toBe(true)
    if (!agentWave2.ok) return
    expect(waves.apply(agentWave2.wave.id, { actor: 'agent' }).ok).toBe(true)

    const authors = cadEngine.getSnapshot().transactions.map((transaction) => transaction.author)
    expect(authors).toEqual(['human', 'agent', 'human', 'agent'])
    expect(cadEngine.getSnapshot().document.name).toBe('A2')

    // Walk back through both authors' work with one undo stack.
    expect(cadEngine.undo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.name).toBe('H1')
    expect(cadEngine.undo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.parts.part_0002.color).not.toBe(15)
    expect(cadEngine.undo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.parts.part_0001.color).not.toBe(15)
    expect(cadEngine.undo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.name).toBe('Survey rover')

    // ...and forward again.
    expect(cadEngine.redo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.name).toBe('H1')
    expect(cadEngine.redo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.parts.part_0001.color).toBe(15)
    expect(cadEngine.redo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.parts.part_0002.color).toBe(15)
    expect(cadEngine.redo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.name).toBe('A2')
  })

  it('records commits in the trace with the transaction they produced', () => {
    const proposed = waves.propose({ label: 'Rename to Zeta', operations: rename('Zeta') })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    expect(waves.apply(proposed.wave.id, { actor: 'human' }).ok).toBe(true)
    const commit = trace.entries().find((entry) => entry.kind === 'commit')
    expect(commit?.status).toBe('ok')
    expect(commit?.detail).toMatchObject({ resultRevision: 2 })
  })
})
