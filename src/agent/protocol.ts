/**
 * The browser half of the assistant wire contract.
 *
 * Restated rather than imported: nothing under `src/` may import from
 * `server/`, because a single accidental import would pull the module that
 * reads `ANTHROPIC_API_KEY` into the browser bundle. `boundary.test.ts`
 * enforces that rule by scanning the source tree, and
 * `server/assistant/protocol.test.ts` — which runs in Node and may cross the
 * boundary in the safe direction — asserts these declarations still agree with
 * the server's.
 */

export const ASSISTANT_PROTOCOL = 'brickwright.assistant/1'
export const ASSISTANT_ENDPOINT = '/api/assistant'
export const DEFAULT_MAX_TOOL_TURNS = 8

export type AutonomyMode = 'inspect' | 'propose' | 'build'

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  id: string
  name: string
  ok: boolean
  content: string
}

export interface UserImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  dataBase64: string
  label?: string
}

export type WireMessage =
  | { role: 'user'; text: string; images?: UserImage[] }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[]; raw?: unknown[] }
  | { role: 'tool'; results: ToolResult[] }

export interface Grounding {
  documentRevision: number
  documentName: string
  catalogVersion: string
  autonomy: AutonomyMode
  partCount: number
  selection: string[]
  subassemblies: Array<{ id: string; name: string; partCount: number; locked: boolean }>
  constraints: Array<{ id: string; kind: string; label: string; hard: boolean; status?: string }>
  openNotes: Array<{ id: string; text: string; anchorPartIds: string[] }>
  validation: { healthy: boolean; collisions: number; components: number; boundsStuds?: [number, number, number] }
  /** Kernel-authored next move. Present so the model does not have to invent a plan. */
  nextAction?: string
  nextTool?: string
  nextArgs?: Record<string, unknown>
  references?: Array<{ token: string; kind: string; partIds: string[]; label: string }>
  brief?: {
    subject: string
    scale: string
    envelopeStuds: [number, number, number] | null
    functions: string[]
    palette: number[]
    symmetry: string
    partBudget: number | null
    style: string[]
    conflicts: Array<{ field: string; detail: string }>
  }
}

export interface ChatRequest {
  protocol: typeof ASSISTANT_PROTOCOL
  kind: 'chat'
  mode: AutonomyMode
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxToolTurns?: number
  grounding: Grounding
  messages: WireMessage[]
}

export interface StructuredRequest {
  protocol: typeof ASSISTANT_PROTOCOL
  kind: 'structured'
  model?: string
  system: string
  prompt: string
  schema: Record<string, unknown>
  maxTokens?: number
  temperature?: number
}

export type AssistantErrorCode =
  | 'BAD_REQUEST'
  | 'AUTH_REQUIRED'
  | 'ACCOUNT_RESTRICTED'
  | 'PAYLOAD_TOO_LARGE'
  | 'MODEL_PROVIDER_UNAVAILABLE'
  | 'TOOL_TURN_LIMIT'
  | 'SCHEMA_VIOLATION'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INTERNAL_ERROR'

export type AssistantStop = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'aborted' | 'error'

export type AssistantEvent =
  | { type: 'start'; requestId: string; model: string; toolTurn: number; maxToolTurns: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'turn'; raw: unknown[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadInputTokens?: number }
  | { type: 'done'; stop: AssistantStop }
  | { type: 'error'; code: AssistantErrorCode; message: string; retryable: boolean }

export const ASSISTANT_EVENT_TYPES = ['start', 'text', 'tool_call', 'turn', 'usage', 'done', 'error'] as const

export interface StructuredResponseBody {
  ok: boolean
  value?: unknown
  provenance?: { provider: string; model: string; promptHash: string; seed: number; createdAt: string }
  usage?: { inputTokens: number; outputTokens: number }
  error?: { code: AssistantErrorCode; message: string; retryable: boolean }
}

/** True for a value that is a well-formed event from the assistant route. */
export function isAssistantEvent(value: unknown): value is AssistantEvent {
  const record = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  const text = (entry: unknown) => typeof entry === 'string' && entry.length > 0
  const count = (entry: unknown) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0
  if (!record(value)) return false
  switch (value.type) {
    case 'start':
      return text(value.requestId) && text(value.model) && count(value.toolTurn) && count(value.maxToolTurns)
    case 'text':
      return typeof value.text === 'string'
    case 'tool_call':
      return record(value.call) && text(value.call.id) && text(value.call.name) && record(value.call.input)
    case 'turn':
      return Array.isArray(value.raw) && value.raw.length <= 64
    case 'usage':
      return (
        count(value.inputTokens) &&
        count(value.outputTokens) &&
        (value.cacheReadInputTokens === undefined || count(value.cacheReadInputTokens))
      )
    case 'done':
      return (
        typeof value.stop === 'string' &&
        ['end_turn', 'tool_use', 'max_tokens', 'refusal', 'aborted', 'error'].includes(value.stop)
      )
    case 'error':
      return (
        typeof value.message === 'string' &&
        typeof value.retryable === 'boolean' &&
        typeof value.code === 'string' &&
        [
          'BAD_REQUEST',
          'AUTH_REQUIRED',
          'ACCOUNT_RESTRICTED',
          'PAYLOAD_TOO_LARGE',
          'MODEL_PROVIDER_UNAVAILABLE',
          'TOOL_TURN_LIMIT',
          'SCHEMA_VIOLATION',
          'RATE_LIMITED',
          'UPSTREAM_ERROR',
          'TIMEOUT',
          'ABORTED',
          'INTERNAL_ERROR',
        ].includes(value.code)
      )
    default:
      return false
  }
}
