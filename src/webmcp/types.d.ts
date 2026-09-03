export {}

declare global {
  interface ModelContextToolResult {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    structuredContent?: unknown
    isError?: boolean
  }

  /** Second argument the host passes to `execute`, so a long read can be cancelled. */
  interface ModelContextExecuteContext {
    signal?: AbortSignal
  }

  interface ModelContextToolDefinition {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean; destructiveHint?: boolean }
    execute: (
      input: unknown,
      context?: ModelContextExecuteContext,
    ) => Promise<ModelContextToolResult> | ModelContextToolResult
  }

  interface ModelContextRegisterOptions {
    /** Aborting it unregisters the tool without disturbing an in-flight call. */
    signal?: AbortSignal
    /** Secure origins allowed to see the tool through `getTools({ fromOrigins })`. */
    exposedTo?: string[]
  }

  /**
   * The shape of `document.modelContext` this app codes against.
   *
   * `registerTool` is declared as returning `void | Promise<void>` because the
   * draft resolves it asynchronously while shipped builds have returned both —
   * see `registerModelContextTool` in `register.ts` for why that matters.
   */
  interface ModelContext {
    registerTool: (tool: ModelContextToolDefinition, options?: ModelContextRegisterOptions) => void | Promise<void>
    getTools?: (options?: { fromOrigins?: string[] }) => Promise<readonly ModelContextToolDefinition[]>
    executeTool?: (
      tool: ModelContextToolDefinition,
      input: unknown,
      options?: { signal?: AbortSignal },
    ) => Promise<ModelContextToolResult>
    addEventListener?: (type: string, listener: () => void) => void
    removeEventListener?: (type: string, listener: () => void) => void
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
