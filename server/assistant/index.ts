import type { RouteModule } from '../index.ts'
import { createAssistantRoute } from './handler.ts'

/**
 * Published entry point for the assistant API.
 *
 * `server/index.ts` discovers this module and calls `route.handle`. Everything
 * else here is exported for tests and for anyone embedding the route in another
 * host: the route object is constructed once, at import, so the process holds a
 * single provider and a single key reference.
 */
export const route: RouteModule = createAssistantRoute()

export { createAssistantRoute, toApiMessages, toolTurnsUsed, structuralCheck } from './handler.ts'
export { AnthropicModelProvider, ProviderRequestError, classifyUpstream } from './provider.ts'
export { SYSTEM_PROMPT, groundingBlock } from './prompt.ts'
export { anthropicTools, ADVERTISED_TOOL_NAMES } from './tools.ts'
export { sanitizeMessage, redactSecret } from './sanitize.ts'
export * from './protocol.ts'

export default route
