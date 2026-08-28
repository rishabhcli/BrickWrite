import { createId } from '../cad/ids'

/**
 * The activity ledger.
 *
 * Two rules shape this file.
 *
 * First: nothing here records reasoning. There is no `thought` field, no
 * summary of deliberation, no narration of intent. Every entry is a thing that
 * happened — a tool ran, a wave was proposed, validation said something, a
 * transaction committed — with the revision it happened at. A workbench that
 * shows invented reasoning teaches the operator to trust a story rather than
 * the model, and the first time the story and the document disagree, the
 * operator believes the wrong one.
 *
 * Second: a failure is never left looking like work in progress. `begin` opens
 * a pending entry and exactly one of `succeed` or `fail` closes it; a stream
 * that dies takes its pending entries to `failed` with the reason, so "still
 * thinking" can never be what a crash looks like.
 */

export type TraceKind =
  | 'message'
  | 'scope'
  | 'tool'
  | 'proposal'
  | 'validation'
  | 'commit'
  | 'reject'
  | 'cancel'
  | 'error'

export type TraceStatus = 'pending' | 'ok' | 'failed'

export interface TraceEntry {
  readonly id: string
  readonly at: string
  readonly kind: TraceKind
  /** What happened, in the operator's vocabulary. */
  readonly label: string
  /** Document revision observed when the entry opened. */
  readonly revision: number
  readonly status: TraceStatus
  /** Measured facts only: counts, ids, codes, durations. */
  readonly detail?: Readonly<Record<string, unknown>>
  readonly durationMs?: number
  /** Present on failed entries. Always a concrete reason. */
  readonly problem?: string
}

/** Field names that would mean the ledger had started narrating. */
const FORBIDDEN_DETAIL_KEYS = /^(?:thought|thoughts|reasoning|thinking|rationale|monologue)$/i

export class TraceLedger {
  private items: TraceEntry[] = []
  private starts = new Map<string, number>()
  private listeners = new Set<() => void>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  private guard(detail?: Record<string, unknown>) {
    if (!detail) return
    for (const key of Object.keys(detail)) {
      if (FORBIDDEN_DETAIL_KEYS.test(key)) {
        throw new Error(`Trace detail may not carry "${key}": the ledger records what happened, not why.`)
      }
    }
  }

  /** Opens a pending entry. Exactly one of succeed/fail must close it. */
  begin(kind: TraceKind, label: string, revision: number, detail?: Record<string, unknown>): string {
    this.guard(detail)
    const id = createId('trace')
    this.starts.set(id, this.now())
    this.items = [
      ...this.items,
      { id, at: new Date(this.now()).toISOString(), kind, label, revision, status: 'pending', detail },
    ]
    this.emit()
    return id
  }

  private close(id: string, status: 'ok' | 'failed', patch: Partial<TraceEntry>) {
    const started = this.starts.get(id)
    this.starts.delete(id)
    this.items = this.items.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            ...patch,
            status,
            detail: { ...(entry.detail ?? {}), ...((patch.detail as Record<string, unknown>) ?? {}) },
            durationMs: started === undefined ? entry.durationMs : this.now() - started,
          }
        : entry,
    )
    this.emit()
  }

  succeed(id: string, detail?: Record<string, unknown>) {
    this.guard(detail)
    this.close(id, 'ok', { detail })
  }

  fail(id: string, problem: string, detail?: Record<string, unknown>) {
    this.guard(detail)
    this.close(id, 'failed', { problem, detail })
  }

  /** Records something that already finished. */
  note(kind: TraceKind, label: string, revision: number, detail?: Record<string, unknown>): string {
    this.guard(detail)
    const id = createId('trace')
    this.items = [...this.items, { id, at: new Date(this.now()).toISOString(), kind, label, revision, status: 'ok', detail }]
    this.emit()
    return id
  }

  /** Records a failure that never had a pending phase. */
  noteFailure(kind: TraceKind, label: string, revision: number, problem: string, detail?: Record<string, unknown>): string {
    this.guard(detail)
    const id = createId('trace')
    this.items = [
      ...this.items,
      { id, at: new Date(this.now()).toISOString(), kind, label, revision, status: 'failed', problem, detail },
    ]
    this.emit()
    return id
  }

  /**
   * Closes every open entry as failed.
   *
   * Called when a stream aborts or throws. Without it the last thing the
   * operator sees is a spinner that never resolves, which reads as "working"
   * and is in fact "broken".
   */
  failAllPending(problem: string) {
    const open = this.items.filter((entry) => entry.status === 'pending')
    for (const entry of open) this.close(entry.id, 'failed', { problem })
  }

  entries(): readonly TraceEntry[] {
    return this.items
  }

  pending(): readonly TraceEntry[] {
    return this.items.filter((entry) => entry.status === 'pending')
  }

  failures(): readonly TraceEntry[] {
    return this.items.filter((entry) => entry.status === 'failed')
  }

  clear() {
    this.items = []
    this.starts.clear()
    this.emit()
  }

  /**
   * A compact, human-readable transcript of the activity.
   *
   * Used by the workbench's copy-for-a-bug-report affordance, and by tests as
   * the single assertion surface for "what did this session actually do".
   */
  summarize(): string {
    return this.items
      .map((entry) => {
        const mark = entry.status === 'ok' ? '✓' : entry.status === 'failed' ? '✗' : '…'
        const problem = entry.problem ? ` — ${entry.problem}` : ''
        return `${mark} r${entry.revision} ${entry.kind}: ${entry.label}${problem}`
      })
      .join('\n')
  }
}
