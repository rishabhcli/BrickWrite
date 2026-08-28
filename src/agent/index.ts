/**
 * Published entry point for the agent workbench.
 *
 * Everything another workstream needs is here; nothing else in `src/agent` is
 * part of the contract. In particular the API process is *not* reachable from
 * this module graph — `src/agent/provider.ts` talks to it over HTTP and holds
 * no credential, which is what `boundary.test.ts` proves.
 */

export { AgentWorkbench, type AgentWorkbenchProps } from './AgentWorkbench'
export { AgentWorkbenchContribution } from './contribution'
export { AgentSession, type SessionState, type SessionOptions, type TranscriptMessage, type SessionStatus, type SendOptions } from './session'
export {
  WaveLedger,
  capabilitiesFor,
  currentMode,
  setMode,
  type AgentMode,
  type ModeCapabilities,
  type Wave,
  type WaveFailure,
  type WaveResult,
  type WaveStatus,
} from './modes'
export { TraceLedger, type TraceEntry, type TraceKind, type TraceStatus } from './trace'
export {
  compileBrief,
  briefProvenance,
  briefGrounding,
  editBrief,
  resolveConflict,
  refineBriefWithModel,
  BriefRefinementSchema,
  type BriefCompileOptions,
  type BriefPatch,
} from './brief'
export {
  describeScope,
  expandToConnectedIsland,
  parseReferenceTokens,
  resolveReference,
  resolveMessageReferences,
  type ParsedToken,
  type ReferenceContext,
  type ReferenceKind,
  type ReferenceScope,
  type SpatialReference,
  type ViewportPin,
} from './references'
export {
  createToolHost,
  verifyDefinition,
  verifyIdentities,
  TOOL_NAMES,
  type ToolHost,
  type ToolHostOptions,
  type ToolFailure,
  type ToolMesh,
} from './tools'
export {
  ASSISTANT_TOOLS,
  ASSISTANT_TOOL_NAMES,
  toolJsonSchema,
  toolsForMode,
  type AssistantToolDeclaration,
} from './toolschemas'
export {
  capabilityJsonSchema,
  capabilitySchema,
  mutationSchema,
  parseCapabilityArgs,
  advertisedFields,
  CAPABILITY_IDS,
  type CapabilityArgsResult,
} from './schemas'
export {
  AssistantTransportError,
  HttpModelProvider,
  assistantHealth,
  createAssistantTransport,
  type AgentModelTransport,
  type AssistantClientOptions,
  type AssistantHealth,
  type StreamHandlers,
} from './provider'
export {
  ASSISTANT_ENDPOINT,
  ASSISTANT_EVENT_TYPES,
  ASSISTANT_PROTOCOL,
  DEFAULT_MAX_TOOL_TURNS,
  isAssistantEvent,
  type AssistantErrorCode,
  type AssistantEvent,
  type AssistantStop,
  type ChatRequest,
  type Grounding,
  type ToolCall,
  type ToolResult,
  type UserImage,
  type WireMessage,
} from './protocol'
