import type { RouteModule } from '../index.js'
import { createAssistantRoute } from './handler.js'

/**
 * Published entry point for the assistant API.
 *
 * `server/index.ts` discovers this module and calls `route.handle`. Everything
 * else here is exported for tests and for anyone embedding the route in another
 * host: the route object is constructed once, at import, so the process holds a
 * single provider and a single key reference.
 */
export const route: RouteModule = createAssistantRoute()

export { createAssistantRoute, toApiMessages, toolTurnsUsed, structuralCheck } from './handler.js'
export { AnthropicModelProvider, ProviderRequestError, classifyUpstream } from './provider.js'
export { SYSTEM_PROMPT, groundingBlock } from './prompt.js'
export { anthropicTools, ADVERTISED_TOOL_NAMES } from './tools.js'
export { sanitizeMessage, redactSecret } from './sanitize.js'
export * from './protocol.js'

export default route
