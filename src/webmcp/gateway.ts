import { cadEngine } from '../cad/engine'
import { toErrorEnvelope } from './contract'

type ToolDefinition = ModelContextToolDefinition
type ToolResult = ModelContextToolResult

export const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
})

export const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

export const revisionProperty = {
  type: 'integer',
  description: 'Revision returned by the most recent read. Mutations reject stale revisions.',
}

export const resultOf = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): ToolResult =>
  result.ok ? json(result.value) : json({ error: result.error })

/**
 * Catches gateway-level failures so a thrown Zod or contract error becomes the
 * same envelope the CAD tools already return, rather than a transport crash.
 */
export function tool(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    execute: async (input) => {
      try {
        return await definition.execute(input)
      } catch (cause) {
        return json(toErrorEnvelope(cause, { currentRevision: cadEngine.getDocument().revision }))
      }
    },
  }
}
