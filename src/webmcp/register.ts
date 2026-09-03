/**
 * The one place a tool reaches `document.modelContext`.
 *
 * Two registrars share it: the always-on site host, which exists on every
 * route including `/`, and the editor's `WebMcpAdapter`, which layers the CAD
 * surface on once the workbench mounts. Routing both through here is what makes
 * `window.brickwright.tools` the *union* rather than whichever started last —
 * and the union is what an evaluation harness or a browser without WebMCP has
 * to drive, since it is the only view of the surface those callers get.
 */

type ToolDefinition = ModelContextToolDefinition

const tools = new Map<string, ToolDefinition>()
const listeners = new Set<() => void>()

/** Every tool currently offered to the host, in registration order. */
export function liveTools(): ReadonlyMap<string, ToolDefinition> {
  return tools
}

export function onLiveToolsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce() {
  for (const listener of [...listeners]) listener()
}

/**
 * Whether the browser implements WebMCP natively.
 *
 * False in the ChatGPT desktop app's in-app browser only if the API was removed;
 * false in Chrome without `chrome://flags/#enable-webmcp-testing` or an origin
 * trial token. Either way the in-page bridge below stays available, so a tool is
 * never silently dropped.
 */
export function hostAvailable(): boolean {
  return typeof document !== 'undefined' && Boolean(document.modelContext)
}

/**
 * Register one tool with the host and with the in-page bridge.
 *
 * `registerTool` resolves asynchronously in the current draft and returned
 * synchronously in earlier builds, so the call is wrapped twice: a `try` for a
 * synchronous throw on a pre-draft signature, and a `.catch` for a rejected
 * promise. Without the second, a host that rejects one registration — a
 * duplicate name, a schema it will not accept — takes the page's whole error
 * channel with it as an unhandled rejection, and the tool that *did* register
 * looks broken.
 */
export function registerModelContextTool(tool: ToolDefinition, signal?: AbortSignal): void {
  if (signal?.aborted) return
  tools.set(tool.name, tool)
  signal?.addEventListener(
    'abort',
    () => {
      if (tools.get(tool.name) === tool) {
        tools.delete(tool.name)
        announce()
      }
    },
    { once: true },
  )
  const host = document.modelContext
  if (host) {
    try {
      void Promise.resolve(host.registerTool(tool, signal ? { signal } : undefined)).catch(() => {})
    } catch {
      // Pre-draft signature. The bridge below still serves the tool.
    }
  }
  announce()
}

/** What `window.brickwright.getDocument()` reads, once the editor owns a document. */
export interface WorkspaceBridge {
  getDocument: () => unknown
}

let workspace: WorkspaceBridge | null = null

export function setWorkspaceBridge(bridge: WorkspaceBridge | null): void {
  workspace = bridge
}

/**
 * Publish the in-page bridge.
 *
 * Idempotent, and it hands out the live map rather than a copy so a caller that
 * captured `window.brickwright` before the editor mounted still sees the CAD
 * tools appear.
 */
export function installBridge(): void {
  if (typeof window === 'undefined') return
  window.brickwright = {
    tools: tools as Map<string, ToolDefinition>,
    invoke: async (name, input = {}) => {
      const tool = tools.get(name)
      if (!tool) {
        throw new Error(
          `Brickwright tool "${name}" is not registered here. Registered: ${[...tools.keys()].join(', ') || 'none'}.`,
        )
      }
      return tool.execute(input, {})
    },
    getDocument: () => {
      if (!workspace) throw new Error('No Brickwright document is open. Call brickwright_navigate to reach /editor.')
      return workspace.getDocument()
    },
  }
}

/** Test seam. Runtime code never needs it: registrations end with their signal. */
export function resetRegistry(): void {
  tools.clear()
  listeners.clear()
  workspace = null
  if (typeof window !== 'undefined') delete window.brickwright
}
