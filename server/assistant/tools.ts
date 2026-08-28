import type Anthropic from '@anthropic-ai/sdk'
import { ASSISTANT_TOOLS, toolJsonSchema, toolsForMode } from '../../src/agent/toolschemas.ts'

/**
 * The tool surface advertised to the model.
 *
 * Derived from `src/agent/toolschemas.ts` rather than restated here, so the
 * schema the model is shown and the schema the browser enforces before touching
 * the kernel are the same object. That file imports Zod and nothing else — no
 * kernel, no React — which is what makes it safe for this process to load.
 *
 * Autonomy gating is structural: in Inspect the preflight tools are simply not
 * in the array, so there is no path by which the model can ask for a ghost edit
 * it is not allowed to make. Nothing here can commit at all — the only route to
 * `commandBus` is `src/agent/modes.ts`, after a human accepts a wave.
 */
export function anthropicTools(mode: 'inspect' | 'propose' | 'build'): Anthropic.Tool[] {
  return toolsForMode(mode).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toolJsonSchema(tool) as Anthropic.Tool['input_schema'],
  }))
}

/** Every tool name this process can advertise, for the parity test. */
export const ADVERTISED_TOOL_NAMES: readonly string[] = ASSISTANT_TOOLS.map((tool) => tool.name)
