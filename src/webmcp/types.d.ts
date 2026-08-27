export {}

declare global {
  interface ModelContextToolResult {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    structuredContent?: unknown
  }

  interface ModelContextToolDefinition {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }
    execute: (input: unknown) => Promise<ModelContextToolResult> | ModelContextToolResult
  }

  interface ModelContext {
    registerTool: (tool: ModelContextToolDefinition, options?: { signal?: AbortSignal }) => void
  }

  interface Document {
    modelContext?: ModelContext
  }

  interface Window {
    __brickwrightCanvas?: HTMLCanvasElement
    __brickwrightRenderStats?: () => {
      drawCalls: number
      triangles: number
      geometries: number
      programs: number
    }
    brickwright?: {
      tools: Map<string, ModelContextToolDefinition>
      invoke: (name: string, input?: unknown) => Promise<ModelContextToolResult>
      getDocument: () => unknown
    }
  }
}
