import { cadEngine, commandBus } from '../cad/engine'
import { createId } from '../cad/ids'
import { validateDocument } from '../cad/validation'
import type { Actor, CadOperation, Proposal, ValidationReport } from '../cad/types'
import type { TraceLedger } from './trace'

/**
 * The autonomy gate.
 *
 * Three modes, enforced by the kernel rather than by the interface:
 *
 *   Inspect — reads only. The tool surface handed to the model contains no
 *             preflight tool at all, so there is nothing to refuse.
 *   Propose — the model may produce reviewable ghosts. `proposeWave` calls
 *             `commandBus.preflight` and nothing else; there is no code path
 *             from a model turn to `commandBus.dispatch`.
 *   Build   — a wave may be committed without a human clicking accept, but only
 *             after this module re-reads the revision and re-validates the
 *             preview immediately before applying.
 *
 * The structural half of "Propose mutates nothing" is that the model has no
 * commit tool in any mode. Committing is an operation of this module, invoked by
 * the workbench when a person accepts a wave, or by the session in Build mode.
 *
 * Waves and the kernel's proposal map: `CadEngine.execute` clears every pending
 * proposal when it commits, because a proposal computed against revision N is
 * meaningless at N+1. That is correct and it is why this module keeps the
 * operations, not just the proposal id — accepting one wave rebases the rest by
 * re-running preflight at the new revision, and says plainly which of them no
 * longer apply.
 */

export type AgentMode = 'inspect' | 'propose' | 'build'

export interface ModeCapabilities {
  readonly canRead: true
  readonly canPreflight: boolean
  /** Whether the session itself may commit, without a person accepting. */
  readonly canAutoApply: boolean
}

const CAPABILITIES: Record<AgentMode, ModeCapabilities> = {
  inspect: { canRead: true, canPreflight: false, canAutoApply: false },
  propose: { canRead: true, canPreflight: true, canAutoApply: false },
  build: { canRead: true, canPreflight: true, canAutoApply: true },
}

export const capabilitiesFor = (mode: AgentMode): ModeCapabilities => CAPABILITIES[mode]

export function currentMode(): AgentMode {
  return cadEngine.getSnapshot().autonomy
}

export function setMode(mode: AgentMode) {
  cadEngine.setAutonomy(mode)
}

export type WaveStatus = 'pending' | 'applied' | 'rejected' | 'stale'

export interface Wave {
  readonly id: string
  readonly label: string
  /** Present when the wave came from a named shared capability. */
  readonly capability: string | null
  readonly summary: string
  readonly operations: readonly CadOperation[]
  /** Kernel proposal backing this wave right now. Null once it goes stale. */
  readonly proposalId: string | null
  readonly baseRevision: number
  readonly createdAt: string
  readonly status: WaveStatus
  /** Validation of the preview document, from the kernel. */
  readonly validation: Pick<ValidationReport, 'collisions' | 'partCount' | 'componentCount' | 'healthy'> | null
  readonly changedPartIds: readonly string[]
  /** Why a stale or rejected wave is in that state. */
  readonly problem?: string
}

export interface WaveFailure {
  readonly code: string
  readonly message: string
  readonly repair: string
  readonly details?: unknown
}

export type WaveResult = { ok: true; wave: Wave } | { ok: false; error: WaveFailure }

export interface ProposeWaveRequest {
  label: string
  operations: readonly CadOperation[]
  capability?: string | null
  summary?: string
  /** The revision the plan was built against. Defaults to the current one. */
  expectedRevision?: number
}

const failure = (code: string, message: string, repair: string, details?: unknown): WaveFailure => ({
  code,
  message,
  repair,
  details,
})

type WaveValidation = NonNullable<Wave['validation']>

function summarizeProposal(proposal: Proposal): WaveValidation {
  return {
    collisions: proposal.validation.collisions,
    partCount: proposal.validation.partCount,
    componentCount: proposal.validation.componentCount,
    healthy: proposal.validation.healthy,
  }
}

/**
 * The reviewable-wave registry.
 *
 * Holds no document truth. Every fact it reports about a wave came from the
 * kernel's own preflight; the registry only remembers the operations so it can
 * ask again after the document moves.
 */
export class WaveLedger {
  private waves = new Map<string, Wave>()
  private listeners = new Set<() => void>()

  constructor(private readonly trace?: TraceLedger) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  private put(wave: Wave) {
    this.waves.set(wave.id, wave)
    this.emit()
  }

  list(): readonly Wave[] {
    return [...this.waves.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  pending(): readonly Wave[] {
    return this.list().filter((wave) => wave.status === 'pending')
  }

  get(id: string): Wave | undefined {
    return this.waves.get(id)
  }

  clear() {
    this.waves.clear()
    this.emit()
  }

  /**
   * Plans a reviewable wave. Never mutates the document.
   *
   * The only kernel call is `commandBus.preflight`, which computes a preview
   * document and a validation report and leaves the real one untouched. A caller
   * that wants the change committed has to go through `apply`, and a person has
   * to have asked for it.
   */
  propose(request: ProposeWaveRequest): WaveResult {
    const snapshot = cadEngine.getSnapshot()
    const revision = snapshot.document.revision
    const expected = request.expectedRevision ?? revision

    if (!capabilitiesFor(snapshot.autonomy).canPreflight) {
      return {
        ok: false,
        error: failure(
          'READ_ONLY_MODE',
          `Inspect mode is read-only, so no wave can be proposed.`,
          'Switch the workbench to Propose or Build and ask again.',
        ),
      }
    }

    if (expected !== revision) {
      return {
        ok: false,
        error: failure(
          'STALE_DOCUMENT',
          `The plan targets revision ${expected}; the document is at ${revision}.`,
          'Reread the changed region and replan against the current revision.',
          { expectedRevision: expected, currentRevision: revision },
        ),
      }
    }

    if (!request.operations.length) {
      return {
        ok: false,
        error: failure('INVALID_OPERATION', 'A wave with no operations changes nothing.', 'Plan at least one operation.'),
      }
    }

    const traceId = this.trace?.begin('proposal', request.label, revision, {
      operations: request.operations.length,
      capability: request.capability ?? null,
    })

    const result = commandBus.preflight(request.label, [...request.operations], 'agent', revision)
    if (!result.ok) {
      if (traceId) this.trace?.fail(traceId, `${result.error.code}: ${result.error.message}`, { repair: result.error.repair })
      return {
        ok: false,
        error: failure(result.error.code, result.error.message, result.error.repair, result.error.details),
      }
    }

    const proposal = result.value
    const wave: Wave = {
      id: createId('wave'),
      label: request.label,
      capability: request.capability ?? null,
      summary: request.summary ?? `${request.operations.length} operation(s)`,
      operations: [...request.operations],
      proposalId: proposal.id,
      baseRevision: proposal.baseRevision,
      createdAt: proposal.createdAt,
      status: 'pending',
      validation: summarizeProposal(proposal),
      changedPartIds: [...new Set(proposal.operations.flatMap(affectedIds))],
    }
    this.put(wave)

    if (traceId) {
      this.trace?.succeed(traceId, {
        waveId: wave.id,
        proposalId: proposal.id,
        collisions: proposal.validation.collisions.length,
        changedParts: wave.changedPartIds.length,
      })
    }
    return { ok: true, wave }
  }

  /**
   * Commits one wave through the shared command bus.
   *
   * The revision and the preview validation are both re-read here, immediately
   * before applying, rather than trusted from proposal time. A person can move a
   * brick between the model proposing and the person accepting, and a plan that
   * was collision-free a second ago may not be now.
   */
  apply(waveId: string, options: { actor?: Actor } = {}): WaveResult {
    const actor: Actor = options.actor ?? 'human'
    const wave = this.waves.get(waveId)
    if (!wave) {
      return { ok: false, error: failure('PROPOSAL_NOT_FOUND', `Wave ${waveId} does not exist.`, 'List pending waves and retry.') }
    }
    if (wave.status !== 'pending') {
      return {
        ok: false,
        error: failure('PROPOSAL_NOT_FOUND', `Wave ${waveId} is ${wave.status}.`, 'Propose the change again.'),
      }
    }

    const snapshot = cadEngine.getSnapshot()
    const mode = snapshot.autonomy

    if (actor === 'agent' && !capabilitiesFor(mode).canAutoApply) {
      return {
        ok: false,
        error: failure(
          'READ_ONLY_MODE',
          `The agent may not commit in ${mode} mode.`,
          'A person accepts the wave, or the workbench is switched to Build.',
        ),
      }
    }

    // Loud, specific staleness. The generic kernel message would say the same
    // thing without naming the wave, and a reviewer looking at four waves needs
    // to know which one moved out from under them.
    if (wave.baseRevision !== snapshot.document.revision) {
      const problem = `Wave "${wave.label}" was planned at revision ${wave.baseRevision}; the document is at ${snapshot.document.revision}.`
      this.put({ ...wave, status: 'stale', proposalId: null, problem })
      this.trace?.noteFailure('commit', wave.label, snapshot.document.revision, problem, { waveId })
      return {
        ok: false,
        error: failure('PROPOSAL_STALE', problem, 'Rebase the wave onto the current revision and review it again.', {
          waveRevision: wave.baseRevision,
          currentRevision: snapshot.document.revision,
        }),
      }
    }

    if (!wave.proposalId) {
      return {
        ok: false,
        error: failure('PROPOSAL_STALE', `Wave "${wave.label}" has no live proposal.`, 'Rebase the wave and review it again.'),
      }
    }

    const proposal = snapshot.proposals.find((candidate) => candidate.id === wave.proposalId)
    if (!proposal) {
      const problem = `The kernel no longer holds a proposal for wave "${wave.label}".`
      this.put({ ...wave, status: 'stale', proposalId: null, problem })
      return { ok: false, error: failure('PROPOSAL_NOT_FOUND', problem, 'Rebase the wave and review it again.') }
    }

    // Re-validate the preview against the here and now rather than reusing the
    // report computed when the wave was proposed.
    const recheck = validateDocument(proposal.previewDocument)
    if (recheck.collisions.length) {
      const problem = `Re-validation found ${recheck.collisions.length} collision(s) in wave "${wave.label}".`
      this.put({ ...wave, status: 'stale', problem, validation: { ...summarizeProposal(proposal), collisions: recheck.collisions, healthy: false } })
      this.trace?.noteFailure('validation', wave.label, snapshot.document.revision, problem, { waveId })
      return {
        ok: false,
        error: failure('COLLISION', problem, 'Choose another placement or move the colliding part clear.', recheck.collisions),
      }
    }

    const traceId = this.trace?.begin('commit', wave.label, snapshot.document.revision, { waveId, actor })
    const result = cadEngine.applyProposal(wave.proposalId, actor)
    if (!result.ok) {
      if (traceId) this.trace?.fail(traceId, `${result.error.code}: ${result.error.message}`, { repair: result.error.repair })
      this.put({ ...wave, status: 'stale', proposalId: null, problem: result.error.message })
      return { ok: false, error: failure(result.error.code, result.error.message, result.error.repair, result.error.details) }
    }

    const applied: Wave = { ...wave, status: 'applied', proposalId: null }
    this.put(applied)
    if (traceId) {
      this.trace?.succeed(traceId, {
        transactionId: result.value.id,
        resultRevision: result.value.resultRevision,
        changedParts: result.value.affectedPartIds.length,
      })
    }

    // Committing cleared every other kernel proposal. Re-plan the survivors so
    // the review queue reflects what is still possible rather than what was.
    this.rebasePending()
    return { ok: true, wave: applied }
  }

  /** Discards a wave. The kernel proposal goes with it. */
  reject(waveId: string, reason = 'Rejected by the operator'): WaveResult {
    const wave = this.waves.get(waveId)
    if (!wave) {
      return { ok: false, error: failure('PROPOSAL_NOT_FOUND', `Wave ${waveId} does not exist.`, 'List pending waves.') }
    }
    if (wave.proposalId) cadEngine.rejectProposal(wave.proposalId)
    const rejected: Wave = { ...wave, status: 'rejected', proposalId: null, problem: reason }
    this.put(rejected)
    this.trace?.note('reject', wave.label, cadEngine.getSnapshot().document.revision, { waveId, reason })
    return { ok: true, wave: rejected }
  }

  /**
   * Re-preflights every pending wave at the current revision.
   *
   * This is the stale-plan rebase. A wave whose operations still apply gets a
   * fresh proposal and stays reviewable; one that no longer applies is marked
   * stale with the kernel's own reason, so a reviewer is told what changed
   * rather than finding an accept button that silently fails.
   */
  rebasePending(): { rebased: string[]; stale: string[] } {
    const snapshot = cadEngine.getSnapshot()
    const revision = snapshot.document.revision
    const rebased: string[] = []
    const stale: string[] = []

    for (const wave of this.list()) {
      if (wave.status !== 'pending') continue
      if (wave.baseRevision === revision && wave.proposalId && snapshot.proposals.some((p) => p.id === wave.proposalId)) {
        continue
      }
      const result = commandBus.preflight(wave.label, [...wave.operations], 'agent', revision)
      if (!result.ok) {
        stale.push(wave.id)
        this.put({
          ...wave,
          status: 'stale',
          proposalId: null,
          problem: `${result.error.code}: ${result.error.message}`,
        })
        continue
      }
      rebased.push(wave.id)
      this.put({
        ...wave,
        proposalId: result.value.id,
        baseRevision: result.value.baseRevision,
        validation: summarizeProposal(result.value),
        status: 'pending',
        problem: undefined,
      })
    }

    if (rebased.length || stale.length) {
      this.trace?.note('proposal', 'Rebased pending waves', revision, { rebased: rebased.length, stale: stale.length })
    }
    return { rebased, stale }
  }
}

function affectedIds(operation: CadOperation): string[] {
  if (operation.type === 'part.add') return [operation.part.id]
  if ('partId' in operation) return [operation.partId]
  if (operation.type === 'note.add') return operation.note.anchorPartIds
  return []
}
