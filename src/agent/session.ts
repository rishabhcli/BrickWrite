import { cadEngine } from '../cad/engine'
import { createId } from '../cad/ids'
import { STUD_LDU } from '../cad/catalog'
import type { DesignBrief } from '../platform/contracts'
import { briefGrounding } from './brief'
import { WaveLedger, capabilitiesFor, setMode, type AgentMode, type Wave, type WaveFailure } from './modes'
import type { AgentModelTransport } from './provider'
import { createAssistantTransport } from './provider'
import { resolveMessageReferences, type SpatialReference, type ViewportPin } from './references'
import { createToolHost, type ToolHost, type ToolHostOptions } from './tools'
import { TraceLedger, type TraceEntry } from './trace'
import {
  ASSISTANT_PROTOCOL,
  DEFAULT_MAX_TOOL_TURNS,
  type AssistantErrorCode,
  type ChatRequest,
  type Grounding,
  type ToolCall,
  type ToolResult,
  type UserImage,
  type WireMessage,
} from './protocol'

/**
 * The conversation loop.
 *
 * It holds no document truth. Every fact it renders — the revision, the waves,
 * the validation of a preview — is read from the kernel or from the wave ledger
 * at the moment of rendering, so a transcript can never disagree with the model
 * on screen. What the session does own is the *conversation*: which leg is in
 * flight, which tool results belong to which turn, what is cancellable, and what
 * a retry would actually resend.
 *
 * The loop is: send a leg, stream it, and if it stopped to ask for tools, run
 * them here against the live kernel and send the next leg. It is bounded by the
 * tool-turn budget on both sides, and the whole thing is one AbortController, so
 * cancelling stops the network, the tools and the pending trace entries together
 * rather than leaving one of them running.
 */

export type SessionStatus = 'idle' | 'streaming' | 'tools' | 'error' | 'cancelled'

export type TranscriptRole = 'user' | 'assistant' | 'notice'

export interface TranscriptMessage {
  readonly id: string
  readonly role: TranscriptRole
  readonly text: string
  readonly at: string
  readonly status: 'streaming' | 'complete' | 'failed' | 'cancelled'
  readonly references?: readonly SpatialReference[]
  readonly toolCalls?: ReadonlyArray<{ id: string; name: string; ok: boolean | null }>
  readonly waveIds?: readonly string[]
  readonly problem?: string
  readonly images?: readonly UserImage[]
}

export interface SessionError {
  readonly code: AssistantErrorCode | string
  readonly message: string
  readonly retryable: boolean
}

export interface SessionState {
  readonly status: SessionStatus
  readonly transcript: readonly TranscriptMessage[]
  readonly waves: readonly Wave[]
  readonly trace: readonly TraceEntry[]
  readonly usage: { inputTokens: number; outputTokens: number; legs: number }
  readonly error: SessionError | null
  readonly toolTurn: number
  readonly maxToolTurns: number
  readonly mode: AgentMode
  readonly revision: number
  readonly busy: boolean
  readonly canRetry: boolean
  readonly canReplan: boolean
  readonly attachments: readonly SpatialReference[]
  readonly brief: DesignBrief | null
  readonly model: string | null
}

export interface SessionOptions {
  transport?: AgentModelTransport
  waves?: WaveLedger
  trace?: TraceLedger
  toolHost?: ToolHost
  maxToolTurns?: number
  pins?: readonly ViewportPin[]
  view?: string
  brief?: DesignBrief | null
  /** Rendering hooks handed to the tool host. */
  render?: Pick<ToolHostOptions, 'geometry' | 'encode' | 'canvas'>
}

export interface SendOptions {
  images?: readonly UserImage[]
  /** Reference chips the operator attached through the interface. */
  attachments?: readonly SpatialReference[]
}

const nowIso = () => new Date().toISOString()

export class AgentSession {
  private readonly transport: AgentModelTransport
  readonly waves: WaveLedger
  readonly trace: TraceLedger
  private readonly toolHost: ToolHost
  private readonly maxToolTurns: number

  private listeners = new Set<() => void>()
  private transcript: TranscriptMessage[] = []
  private wire: WireMessage[] = []
  private status: SessionStatus = 'idle'
  private error: SessionError | null = null
  private usage = { inputTokens: 0, outputTokens: 0, legs: 0 }
  private toolTurn = 0
  private controller: AbortController | null = null
  private attachments: SpatialReference[] = []
  private brief: DesignBrief | null
  private model: string | null = null
  private pins: readonly ViewportPin[]
  private view: string | undefined
  private lastSend: { text: string; options: SendOptions } | null = null
  private unsubscribeEngine: () => void
  private rebasing = false
  private lastSeenRevision: number
  private state: SessionState

  constructor(options: SessionOptions = {}) {
    this.trace = options.trace ?? new TraceLedger()
    this.waves = options.waves ?? new WaveLedger(this.trace)
    this.toolHost =
      options.toolHost ?? createToolHost({ waves: this.waves, trace: this.trace, pins: options.pins, view: options.view, ...options.render })
    this.transport = options.transport ?? createAssistantTransport()
    this.maxToolTurns = options.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS
    this.brief = options.brief ?? null
    this.pins = options.pins ?? []
    this.view = options.view
    this.lastSeenRevision = cadEngine.getSnapshot().document.revision

    // A human edit between a proposal and its review invalidates the plan. The
    // ledger is rebased rather than the wave being silently applied against a
    // document it was not computed for.
    this.unsubscribeEngine = cadEngine.subscribe(() => this.onEngineChange())
    this.waves.subscribe(() => this.publish())
    this.trace.subscribe(() => this.publish())
    this.state = this.buildState()
  }

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): SessionState => this.state

  private buildState(): SessionState {
    const snapshot = cadEngine.getSnapshot()
    return {
      status: this.status,
      transcript: this.transcript,
      waves: this.waves.list(),
      trace: this.trace.entries(),
      usage: this.usage,
      error: this.error,
      toolTurn: this.toolTurn,
      maxToolTurns: this.maxToolTurns,
      mode: snapshot.autonomy,
      revision: snapshot.document.revision,
      busy: this.status === 'streaming' || this.status === 'tools',
      canRetry: this.lastSend !== null && this.status !== 'streaming' && this.status !== 'tools',
      canReplan: this.lastSend !== null && this.waves.pending().length > 0,
      attachments: this.attachments,
      brief: this.brief,
      model: this.model,
    }
  }

  private publish() {
    this.state = this.buildState()
    for (const listener of this.listeners) listener()
  }

  private onEngineChange() {
    if (this.rebasing) return
    const revision = cadEngine.getSnapshot().document.revision
    if (revision !== this.lastSeenRevision) {
      this.lastSeenRevision = revision
      this.rebasing = true
      try {
        this.waves.rebasePending()
      } finally {
        this.rebasing = false
      }
    }
    this.publish()
  }

  dispose() {
    this.unsubscribeEngine()
    this.controller?.abort()
    this.listeners.clear()
  }

  // -------------------------------------------------------------------
  // Composition surface
  // -------------------------------------------------------------------

  setMode(mode: AgentMode) {
    setMode(mode)
    this.publish()
  }

  setBrief(brief: DesignBrief | null) {
    this.brief = brief
    this.publish()
  }

  attach(reference: SpatialReference) {
    if (this.attachments.some((existing) => existing.token === reference.token)) return
    this.attachments = [...this.attachments, reference]
    this.publish()
  }

  detach(token: string) {
    this.attachments = this.attachments.filter((reference) => reference.token !== token)
    this.publish()
  }

  clearAttachments() {
    this.attachments = []
    this.publish()
  }

  // -------------------------------------------------------------------
  // Grounding
  // -------------------------------------------------------------------

  private grounding(references: readonly SpatialReference[]): Grounding {
    const snapshot = cadEngine.getSnapshot()
    const document = snapshot.document
    const validation = snapshot.validation
    return {
      documentRevision: document.revision,
      documentName: document.name,
      catalogVersion: document.catalogVersion,
      autonomy: snapshot.autonomy,
      partCount: validation.partCount,
      selection: snapshot.selection,
      subassemblies: Object.values(document.subassemblies).map((item) => ({
        id: item.id,
        name: item.name,
        partCount: item.partIds.length,
        locked: item.locked,
      })),
      constraints: document.constraints.map((constraint) => ({
        id: constraint.id,
        kind: constraint.kind,
        label: constraint.label,
        hard: constraint.hard,
        status: validation.constraints.find((entry) => entry.id === constraint.id)?.status,
      })),
      openNotes: document.notes
        .filter((note) => note.status === 'open')
        .map((note) => ({ id: note.id, text: note.text, anchorPartIds: note.anchorPartIds })),
      validation: {
        healthy: validation.healthy,
        collisions: validation.collisions.length,
        components: validation.componentCount,
        boundsStuds: [
          Math.round((validation.bounds.size[0] / STUD_LDU) * 100) / 100,
          Math.round((validation.bounds.size[1] / STUD_LDU) * 100) / 100,
          Math.round((validation.bounds.size[2] / STUD_LDU) * 100) / 100,
        ],
      },
      references: references.map((reference) => ({
        token: reference.token,
        kind: reference.kind,
        partIds: reference.partIds,
        label: reference.label,
      })),
      ...(this.brief ? { brief: briefGrounding(this.brief) } : {}),
    }
  }

  // -------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------

  async send(text: string, options: SendOptions = {}): Promise<void> {
    if (this.status === 'streaming' || this.status === 'tools') {
      throw new Error('A turn is already in flight. Cancel it before sending another.')
    }
    const trimmed = text.trim()
    if (!trimmed && !options.images?.length) return

    const snapshot = cadEngine.getSnapshot()
    const resolved = resolveMessageReferences(
      trimmed,
      { document: snapshot.document, selection: snapshot.selection, pins: this.pins, view: this.view },
      [...this.attachments, ...(options.attachments ?? [])],
    )

    this.lastSend = { text: trimmed, options }
    this.error = null
    this.trace.note('message', 'Operator message', snapshot.document.revision, {
      characters: trimmed.length,
      references: resolved.references.length,
      unresolvedReferences: resolved.references.filter((reference) => !reference.resolved).length,
      images: options.images?.length ?? 0,
    })

    this.transcript = [
      ...this.transcript,
      {
        id: createId('msg'),
        role: 'user',
        text: trimmed,
        at: nowIso(),
        status: 'complete',
        references: resolved.references,
        images: options.images,
      },
    ]

    // An unresolved chip is a fact about the request, and the model is told so
    // it never treats a dangling token as a live id.
    const unresolved = resolved.references.filter((reference) => !reference.resolved)
    const suffix = unresolved.length
      ? `\n\n[Unresolved references: ${unresolved.map((reference) => `${reference.token} — ${reference.problem}`).join('; ')}]`
      : ''

    this.wire = [...this.wire, { role: 'user', text: `${trimmed}${suffix}`, ...(options.images?.length ? { images: [...options.images] } : {}) }]
    this.attachments = []
    await this.run(resolved.references)
  }

  /** Resends the last operator message from a clean transcript position. */
  async retry(): Promise<void> {
    if (!this.lastSend) return
    // Everything after the last user message is discarded: a failed leg's
    // partial output is not context, it is debris.
    const lastUserIndex = this.wire.map((message) => message.role).lastIndexOf('user')
    if (lastUserIndex >= 0) this.wire = this.wire.slice(0, lastUserIndex + 1)
    this.transcript = this.transcript.filter((message) => message.status !== 'failed' && message.status !== 'cancelled')
    this.error = null
    this.toolTurn = 0
    this.trace.note('message', 'Retrying the last request', cadEngine.getSnapshot().document.revision)
    await this.run([])
  }

  /**
   * Discards the pending waves and asks again against the current revision.
   *
   * Distinct from retry: retry resends the same request, replan says the world
   * has moved and the previous plan should not be salvaged.
   */
  async replan(reason = 'The document changed; replan against the current revision.'): Promise<void> {
    if (!this.lastSend) return
    for (const wave of this.waves.pending()) this.waves.reject(wave.id, 'Superseded by a replan')
    const revision = cadEngine.getSnapshot().document.revision
    this.trace.note('message', 'Replanning', revision, { reason })
    this.transcript = [
      ...this.transcript,
      { id: createId('msg'), role: 'notice', text: reason, at: nowIso(), status: 'complete' },
    ]
    this.wire = [...this.wire, { role: 'user', text: `${reason} The document is now at revision ${revision}.` }]
    this.error = null
    await this.run([])
  }

  cancel() {
    if (!this.controller) return
    this.controller.abort()
    this.trace.failAllPending('Cancelled by the operator')
    this.status = 'cancelled'
    this.transcript = this.transcript.map((message) =>
      message.status === 'streaming' ? { ...message, status: 'cancelled', problem: 'Cancelled by the operator' } : message,
    )
    this.publish()
  }

  /**
   * Runs legs until the model stops asking for tools.
   *
   * Bounded twice over: the API process refuses a transcript past the budget,
   * and this loop stops on its own. Two ceilings for one limit is deliberate —
   * the browser's is what keeps the interface responsive, the server's is what
   * keeps the bill finite when the browser is not the caller.
   */
  private async run(references: readonly SpatialReference[]): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.status = 'streaming'
    this.publish()

    try {
      for (let leg = 0; leg < this.maxToolTurns + 1; leg += 1) {
        if (controller.signal.aborted) break

        const messageId = createId('msg')
        let text = ''
        const toolCalls: ToolCall[] = []
        let raw: unknown[] | null = null
        let stop: string | null = null
        let legError: SessionError | null = null

        this.status = 'streaming'
        this.transcript = [
          ...this.transcript,
          { id: messageId, role: 'assistant', text: '', at: nowIso(), status: 'streaming' },
        ]
        this.publish()

        const patch = (update: Partial<TranscriptMessage>) => {
          this.transcript = this.transcript.map((message) => (message.id === messageId ? { ...message, ...update } : message))
        }

        const request: ChatRequest = {
          protocol: ASSISTANT_PROTOCOL,
          kind: 'chat',
          mode: cadEngine.getSnapshot().autonomy,
          maxToolTurns: this.maxToolTurns,
          grounding: this.grounding(leg === 0 ? references : []),
          messages: this.wire,
        }

        await this.transport.stream(
          request,
          {
            onStart: (event) => {
              this.model = event.model
              this.toolTurn = event.toolTurn
              this.publish()
            },
            onText: (delta) => {
              text += delta
              patch({ text })
              this.publish()
            },
            onToolCall: (call) => {
              toolCalls.push(call)
              patch({ toolCalls: toolCalls.map((entry) => ({ id: entry.id, name: entry.name, ok: null })) })
              this.publish()
            },
            onTurn: (blocks) => {
              raw = blocks
            },
            onUsage: (usage) => {
              this.usage = {
                inputTokens: this.usage.inputTokens + usage.inputTokens,
                outputTokens: this.usage.outputTokens + usage.outputTokens,
                legs: this.usage.legs + 1,
              }
              this.publish()
            },
            onError: (error) => {
              legError = error
            },
            onDone: (value) => {
              stop = value
            },
          },
          controller.signal,
        )

        if (controller.signal.aborted || stop === 'aborted') {
          patch({ status: 'cancelled', problem: 'Cancelled by the operator', text })
          this.trace.failAllPending('Cancelled by the operator')
          this.status = 'cancelled'
          this.publish()
          return
        }

        if (legError) {
          const failure = legError as SessionError
          this.error = failure
          patch({ status: 'failed', problem: failure.message, text })
          this.trace.noteFailure('error', 'Assistant turn failed', cadEngine.getSnapshot().document.revision, failure.message, {
            code: failure.code,
            retryable: failure.retryable,
          })
          this.status = 'error'
          this.publish()
          return
        }

        this.wire = [
          ...this.wire,
          { role: 'assistant', text, ...(toolCalls.length ? { toolCalls } : {}), ...(raw ? { raw } : {}) },
        ]

        if (stop !== 'tool_use' || !toolCalls.length) {
          patch({ status: 'complete', text, waveIds: this.waves.pending().map((wave) => wave.id) })
          this.status = 'idle'
          await this.autoApplyIfBuilding()
          this.publish()
          return
        }

        if (leg >= this.maxToolTurns - 1) {
          const message = `The turn used its whole budget of ${this.maxToolTurns} tool rounds without finishing.`
          this.error = { code: 'TOOL_TURN_LIMIT', message, retryable: false }
          patch({ status: 'failed', problem: message, text })
          this.trace.noteFailure('error', 'Tool budget exhausted', cadEngine.getSnapshot().document.revision, message)
          this.status = 'error'
          this.publish()
          return
        }

        this.status = 'tools'
        patch({ status: 'complete', text })
        this.publish()

        const results: ToolResult[] = []
        for (const call of toolCalls) {
          if (controller.signal.aborted) break
          const result = await this.toolHost.execute(call)
          results.push(result)
        }

        if (controller.signal.aborted) {
          this.trace.failAllPending('Cancelled by the operator')
          this.status = 'cancelled'
          this.publish()
          return
        }

        patch({
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            ok: results.find((result) => result.id === call.id)?.ok ?? null,
          })),
        })

        this.wire = [...this.wire, { role: 'tool', results }]
        this.toolTurn += 1

        // If a human moved the document while the tools ran, the pending waves
        // are rebased and the model is told, rather than being left to plan the
        // next step against a revision that no longer exists.
        const rebase = this.waves.rebasePending()
        if (rebase.stale.length) {
          const stale = this.waves
            .list()
            .filter((wave) => rebase.stale.includes(wave.id))
            .map((wave) => `"${wave.label}" (${wave.problem ?? 'no longer applies'})`)
          this.wire = [
            ...this.wire,
            {
              role: 'user',
              text: `The document moved to revision ${cadEngine.getSnapshot().document.revision} while you were working. These waves no longer apply and were withdrawn: ${stale.join('; ')}. Reread before planning further.`,
            },
          ]
        }
        this.publish()
      }
    } catch (cause) {
      const message = `The assistant turn failed: ${String((cause as Error)?.message ?? cause)}`
      this.error = { code: 'INTERNAL_ERROR', message, retryable: true }
      this.trace.failAllPending(message)
      this.transcript = this.transcript.map((entry) =>
        entry.status === 'streaming' ? { ...entry, status: 'failed', problem: message } : entry,
      )
      this.status = 'error'
      this.publish()
    } finally {
      if (this.controller === controller) this.controller = null
      if (this.status === 'streaming' || this.status === 'tools') this.status = 'idle'
      this.publish()
    }
  }

  /**
   * Build mode commits what a person would otherwise accept.
   *
   * It goes through the same `WaveLedger.apply` a click does, so the revision
   * check and the re-validation happen identically. There is no faster path for
   * the agent, and that is the point.
   */
  private async autoApplyIfBuilding(): Promise<void> {
    const mode = cadEngine.getSnapshot().autonomy
    if (!capabilitiesFor(mode).canAutoApply) return
    for (const wave of this.waves.pending()) {
      const result = this.waves.apply(wave.id, { actor: 'agent' })
      if (!result.ok) {
        this.transcript = [
          ...this.transcript,
          {
            id: createId('msg'),
            role: 'notice',
            text: `Build mode could not commit "${wave.label}": ${result.error.message} ${result.error.repair}`,
            at: nowIso(),
            status: 'failed',
            problem: result.error.code,
          },
        ]
        break
      }
    }
  }

  // -------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------

  acceptWave(waveId: string): { ok: true; wave: Wave } | { ok: false; error: WaveFailure } {
    const result = this.waves.apply(waveId, { actor: 'human' })
    if (!result.ok) {
      this.error = { code: result.error.code, message: result.error.message, retryable: result.error.code === 'PROPOSAL_STALE' }
      this.transcript = [
        ...this.transcript,
        {
          id: createId('msg'),
          role: 'notice',
          text: `${result.error.message} ${result.error.repair}`,
          at: nowIso(),
          status: 'failed',
          problem: result.error.code,
        },
      ]
    }
    this.publish()
    return result
  }

  rejectWave(waveId: string, reason?: string) {
    const result = this.waves.reject(waveId, reason)
    this.publish()
    return result
  }

  /** Accepts every pending wave in order, stopping at the first refusal. */
  acceptAll(): { accepted: string[]; stoppedAt: string | null; error: WaveFailure | null } {
    const accepted: string[] = []
    for (const wave of this.waves.pending()) {
      const result = this.acceptWave(wave.id)
      if (!result.ok) return { accepted, stoppedAt: wave.id, error: result.error }
      accepted.push(wave.id)
    }
    return { accepted, stoppedAt: null, error: null }
  }

  /**
   * Rejects a wave and tells the model why.
   *
   * The reason becomes the next user turn rather than a note nobody reads: a
   * rejection without a reason teaches the model nothing and the operator ends
   * up rejecting the same plan twice.
   */
  async feedback(waveId: string, reason: string): Promise<void> {
    const wave = this.waves.get(waveId)
    if (wave && wave.status === 'pending') this.waves.reject(waveId, reason)
    const label = wave ? `"${wave.label}"` : `wave ${waveId}`
    this.transcript = [
      ...this.transcript,
      { id: createId('msg'), role: 'user', text: `Rejected ${label}: ${reason}`, at: nowIso(), status: 'complete' },
    ]
    this.wire = [
      ...this.wire,
      { role: 'user', text: `I rejected ${label}. Reason: ${reason}. Propose something that addresses that.` },
    ]
    this.lastSend = { text: reason, options: {} }
    await this.run([])
  }
}
