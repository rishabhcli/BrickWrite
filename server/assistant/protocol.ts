import { z } from 'zod'

/**
 * The wire contract between the browser workbench and the API process.
 *
 * Two shapes, because they answer two different questions:
 *
 *   `chat`       — a streaming conversational leg. The API process owns the key,
 *                  the system prompt, the tool surface and the turn budget; the
 *                  browser owns tool execution, because the document lives there
 *                  and nowhere else. One leg is one model call: when the model
 *                  asks for tools the leg ends with `stop: "tool_use"`, the
 *                  browser executes them against the kernel, and posts the next
 *                  leg with the results appended. The transcript is carried in
 *                  the request, so this process holds no session state.
 *
 *   `structured` — one non-streaming completion validated against a caller
 *                  supplied JSON Schema. This is the `ModelProvider.complete`
 *                  contract from `src/platform/contracts.ts` crossing the
 *                  process boundary intact.
 *
 * Everything is bounded. A transcript, a tool result, an image and a prompt all
 * have explicit ceilings, because an unbounded request body is an unbounded
 * bill and an unbounded context.
 */

export const ASSISTANT_PROTOCOL = 'brickwright.assistant/1'

export const DEFAULT_MODEL = 'claude-sonnet-5'
export const DEFAULT_MAX_TOOL_TURNS = 8
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024

const AutonomyMode = z.enum(['inspect', 'propose', 'build'])

/**
 * The compact projection of the live document sent with every leg.
 *
 * The model is grounded on facts the kernel measured, not on a description the
 * browser wrote. Full detail is fetched through tools; this is the standing
 * context that makes the first tool call an informed one, and it is what lets
 * the system prompt state the exact revision every plan must target.
 */
export const GroundingSchema = z.object({
  documentRevision: z.number().int().min(0),
  documentName: z.string().max(200),
  catalogVersion: z.string().max(80),
  autonomy: AutonomyMode,
  partCount: z.number().int().min(0),
  selection: z.array(z.string().max(80)).max(200),
  subassemblies: z
    .array(
      z.object({
        id: z.string().max(80),
        name: z.string().max(120),
        partCount: z.number().int().min(0),
        locked: z.boolean(),
      }),
    )
    .max(100),
  constraints: z
    .array(
      z.object({
        id: z.string().max(80),
        kind: z.string().max(40),
        label: z.string().max(160),
        hard: z.boolean(),
        status: z.string().max(20).optional(),
      }),
    )
    .max(50),
  openNotes: z
    .array(z.object({ id: z.string().max(80), text: z.string().max(800), anchorPartIds: z.array(z.string().max(80)).max(50) }))
    .max(50),
  validation: z.object({
    healthy: z.boolean(),
    collisions: z.number().int().min(0),
    components: z.number().int().min(0),
    boundsStuds: z.tuple([z.number(), z.number(), z.number()]).optional(),
  }),
  nextAction: z.string().max(800).optional(),
  nextTool: z.string().max(80).optional(),
  nextArgs: z.record(z.string(), z.unknown()).optional(),
  /** Resolved reference chips the operator attached to this message. */
  references: z
    .array(
      z.object({
        token: z.string().max(120),
        kind: z.string().max(40),
        partIds: z.array(z.string().max(80)).max(500),
        label: z.string().max(160),
      }),
    )
    .max(20)
    .optional(),
  /** The editable design brief, when the operator has compiled one. */
  brief: z
    .object({
      subject: z.string().max(400),
      scale: z.string().max(40),
      envelopeStuds: z.tuple([z.number(), z.number(), z.number()]).nullable(),
      functions: z.array(z.string().max(200)).max(40),
      palette: z.array(z.number().int()).max(64),
      symmetry: z.string().max(40),
      partBudget: z.number().int().nullable(),
      style: z.array(z.string().max(80)).max(40),
      conflicts: z.array(z.object({ field: z.string().max(80), detail: z.string().max(400) })).max(40),
    })
    .optional(),
})

export type Grounding = z.infer<typeof GroundingSchema>

export const ToolCallSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(80),
  input: z.record(z.string(), z.unknown()),
})

export type ToolCall = z.infer<typeof ToolCallSchema>

export const ToolResultSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(80),
  ok: z.boolean(),
  /** Serialized tool output. Capped so one result cannot flood the context. */
  content: z.string().max(60_000),
})

export type ToolResult = z.infer<typeof ToolResultSchema>

export const WireMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    text: z.string().max(20_000),
    images: z
      .array(
        z.object({
          mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
          dataBase64: z.string().max(5_000_000),
          label: z.string().max(160).optional(),
        }),
      )
      .max(4)
      .optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    text: z.string().max(60_000),
    toolCalls: z.array(ToolCallSchema).max(16).optional(),
    /**
     * The model's own content blocks, carried back verbatim.
     *
     * Extended thinking and tool use have to travel together: an assistant turn
     * replayed without the blocks the model actually produced is a different
     * turn, and the API is entitled to reject it. The browser treats this as
     * opaque — it never inspects or renders it.
     */
    raw: z.array(z.unknown()).max(64).optional(),
  }),
  z.object({ role: z.literal('tool'), results: z.array(ToolResultSchema).min(1).max(16) }),
])

export type WireMessage = z.infer<typeof WireMessageSchema>

export const ChatRequestSchema = z.object({
  protocol: z.literal(ASSISTANT_PROTOCOL),
  kind: z.literal('chat'),
  mode: AutonomyMode,
  model: z.string().min(1).max(80).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxToolTurns: z.number().int().min(1).max(24).optional(),
  grounding: GroundingSchema,
  messages: z.array(WireMessageSchema).min(1).max(120),
})

export type ChatRequest = z.infer<typeof ChatRequestSchema>

export const StructuredRequestSchema = z.object({
  protocol: z.literal(ASSISTANT_PROTOCOL),
  kind: z.literal('structured'),
  model: z.string().min(1).max(80).optional(),
  system: z.string().max(20_000),
  prompt: z.string().max(60_000),
  /** JSON Schema the response must satisfy. Validated again by the caller. */
  schema: z.record(z.string(), z.unknown()),
  maxTokens: z.number().int().min(64).max(32_000).optional(),
  temperature: z.number().min(0).max(1).optional(),
})

export type StructuredRequest = z.infer<typeof StructuredRequestSchema>

export const AssistantRequestSchema = z.discriminatedUnion('kind', [ChatRequestSchema, StructuredRequestSchema])

export type AssistantRequest = z.infer<typeof AssistantRequestSchema>

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

/** Codes worth offering as a retry rather than a replan. */
export const RETRYABLE_CODES: ReadonlySet<AssistantErrorCode> = new Set<AssistantErrorCode>([
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'TIMEOUT',
])

export type AssistantStop = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'aborted' | 'error'

/**
 * One NDJSON line of a chat leg.
 *
 * There is no "thinking" event. The workbench shows a pending state driven by
 * the real lifecycle — `start` seen, no `text` yet — so a stalled or failed
 * stream can never be presented as deliberation.
 */
export type AssistantEvent =
  | { type: 'start'; requestId: string; model: string; toolTurn: number; maxToolTurns: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'turn'; raw: unknown[] }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      /** Prefix served from cache. Excluded from `inputTokens`, billed at a tenth. */
      cacheReadInputTokens?: number
      /** Prefix written to cache. Excluded from `inputTokens`, billed at 1.25x. */
      cacheCreationInputTokens?: number
    }
  | { type: 'done'; stop: AssistantStop }
  | { type: 'error'; code: AssistantErrorCode; message: string; retryable: boolean }

export interface StructuredSuccess {
  ok: true
  value: unknown
  provenance: { provider: string; model: string; promptHash: string; seed: number; createdAt: string }
  usage: { inputTokens: number; outputTokens: number }
}

export interface StructuredFailure {
  ok: false
  error: { code: AssistantErrorCode; message: string; retryable: boolean }
}

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson'

/** Event type names, so both sides can assert they agree on the vocabulary. */
export const ASSISTANT_EVENT_TYPES = ['start', 'text', 'tool_call', 'turn', 'usage', 'done', 'error'] as const
