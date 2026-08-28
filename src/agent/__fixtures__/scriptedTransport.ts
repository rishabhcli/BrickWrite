import type {
  AssistantErrorCode,
  AssistantStop,
  ChatRequest,
  ToolCall,
} from '../protocol'
import type { AgentModelTransport, StreamHandlers } from '../provider'

/**
 * A deterministic stand-in for the model, for tests only.
 *
 * Nothing in the application imports this file — `boundary.test.ts` asserts
 * that. Runtime always talks to the real provider through the API process; a
 * double that could be reached from production code would be a way for the
 * product to appear to work while calling nothing.
 *
 * The script is a list of legs. One leg is one model turn: some text, some tool
 * calls, and a stop reason. The loop under test does the rest — it executes the
 * tools against the live kernel and comes back for the next leg — which is what
 * makes these tests exercise the real tool host, the real planner and the real
 * command bus rather than a mock of them.
 */

export interface ScriptedLeg {
  /** Streamed in order, so a test can observe a partial reply. */
  text?: string[]
  toolCalls?: Array<{ id?: string; name: string; input: Record<string, unknown> }>
  stop?: AssistantStop
  error?: { code: AssistantErrorCode; message: string; retryable: boolean }
  usage?: { inputTokens: number; outputTokens: number }
  /** Awaited after the first text chunk, so a test can cancel mid-stream. */
  hold?: () => Promise<void>
}

export interface ScriptedTransport extends AgentModelTransport {
  /** Every request the session sent, in order. */
  readonly requests: readonly ChatRequest[]
  readonly legs: number
}

export function scriptedTransport(
  script: ScriptedLeg[] | ((request: ChatRequest, index: number) => ScriptedLeg),
  options: { model?: string } = {},
): ScriptedTransport {
  const requests: ChatRequest[] = []
  const model = options.model ?? 'scripted-model'

  const transport: ScriptedTransport = {
    id: 'scripted',
    get requests() {
      return requests
    },
    get legs() {
      return requests.length
    },
    async stream(request: ChatRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<void> {
      const index = requests.length
      requests.push(request)
      const leg = typeof script === 'function' ? script(request, index) : (script[index] ?? { text: ['(no further script)'] })

      const aborted = () => signal?.aborted === true
      if (aborted()) {
        handlers.onDone?.('aborted')
        return
      }

      handlers.onStart?.({
        type: 'start',
        requestId: `scripted_${index}`,
        model,
        toolTurn: request.messages.filter((message) => message.role === 'tool').length,
        maxToolTurns: request.maxToolTurns ?? 8,
      })

      let first = true
      for (const chunk of leg.text ?? []) {
        if (aborted()) {
          handlers.onDone?.('aborted')
          return
        }
        handlers.onText?.(chunk)
        if (first) {
          first = false
          if (leg.hold) await leg.hold()
        }
        // Yield, so a cancel scheduled by the test lands between chunks the way
        // it would between network frames.
        await Promise.resolve()
      }

      if (aborted()) {
        handlers.onDone?.('aborted')
        return
      }

      if (leg.error) {
        handlers.onError?.(leg.error)
        handlers.onDone?.('error')
        return
      }

      const calls: ToolCall[] = (leg.toolCalls ?? []).map((call, position) => ({
        id: call.id ?? `tool_${index}_${position}`,
        name: call.name,
        input: call.input,
      }))

      handlers.onTurn?.([
        ...(leg.text?.length ? [{ type: 'text', text: leg.text.join('') }] : []),
        ...calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
      ])
      for (const call of calls) handlers.onToolCall?.(call)
      handlers.onUsage?.(leg.usage ?? { inputTokens: 100, outputTokens: 20 })
      handlers.onDone?.(leg.stop ?? (calls.length ? 'tool_use' : 'end_turn'))
    },
  }

  return transport
}

/** Parses a recorded tool result back into the value the tool returned. */
export function toolValue<T = Record<string, unknown>>(content: string): T {
  return JSON.parse(content) as T
}
