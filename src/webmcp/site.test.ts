import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLandingNavigator } from '../features/landing/navigation'
import { hostAvailable, registerModelContextTool, resetRegistry } from './register'
import { setAutonomyGate, startSiteTools, stopSiteTools } from './site'

/**
 * The site surface is the part a judge or an assistant meets first, so what it
 * is worth asserting is reachability: tools exist with no editor mounted, they
 * reach the *real* `document.modelContext`, and navigation is a client
 * transition rather than a page load that would unregister everything.
 */

interface FakeHost {
  registered: string[]
  live: () => string[]
}

/**
 * A `document.modelContext` that drops a tool by *registration identity*.
 *
 * Keying the drop by name instead would make a re-registration of the same name
 * look like a tool that had already been withdrawn, which is the opposite of
 * what a real host does and would have hidden the restart case below.
 */
function installFakeHost(behaviour: 'resolve' | 'reject' | 'throw' = 'resolve'): FakeHost {
  const registered: string[] = []
  const entries = new Set<ModelContextToolDefinition>()
  document.modelContext = {
    registerTool(tool, options) {
      registered.push(tool.name)
      entries.add(tool)
      options?.signal?.addEventListener('abort', () => entries.delete(tool), { once: true })
      if (behaviour === 'throw') throw new Error('pre-draft signature')
      if (behaviour === 'reject') return Promise.reject(new Error('host refused'))
      return Promise.resolve()
    },
  }
  return { registered, live: () => [...entries].map((tool) => tool.name) }
}

const workspaceTool = (name: string): ModelContextToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  execute: () => ({ content: [] }),
})

const invoke = async (name: string, input: unknown = {}) => {
  const result = await window.brickwright!.invoke(name, input)
  return result.structuredContent as Record<string, unknown>
}

describe('WebMCP site surface', () => {
  let stop: (() => void) | undefined

  beforeEach(() => {
    resetRegistry()
    setAutonomyGate(null)
    delete document.modelContext
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    stop?.()
    stopSiteTools()
    resetRegistry()
    setAutonomyGate(null)
    setLandingNavigator(null)
    delete document.modelContext
  })

  it('registers tools with no editor mounted, which is the whole point', async () => {
    stop = startSiteTools()
    const names = [...window.brickwright!.tools.keys()]
    expect(names).toEqual([
      'brickwright_overview',
      'brickwright_navigate',
      'brickwright_tools_list',
      'brickwright_demos_list',
      'brickwright_autonomy',
    ])
    const overview = await invoke('brickwright_overview')
    expect(overview).toMatchObject({ currentSurface: 'landing', workspaceToolsLive: 0 })
    expect(overview.nextStep).toContain('brickwright_navigate')
  })

  it('hands every tool to document.modelContext, not only to the in-page bridge', () => {
    const host = installFakeHost()
    expect(hostAvailable()).toBe(true)
    stop = startSiteTools()
    expect(host.registered).toEqual([
      'brickwright_overview',
      'brickwright_navigate',
      'brickwright_tools_list',
      'brickwright_demos_list',
      'brickwright_autonomy',
    ])
  })

  it('unregisters through the abort signal it passed the host', () => {
    const host = installFakeHost()
    stop = startSiteTools()
    expect(host.live()).toHaveLength(5)
    stop()
    expect(host.live()).toEqual([])
    expect(window.brickwright!.tools.size).toBe(0)
  })

  it('survives a host that rejects the registration promise', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    installFakeHost('reject')
    stop = startSiteTools()
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    // The bridge still serves it, so a rejected native registration degrades to
    // the same place a browser without WebMCP lands.
    expect(window.brickwright!.tools.has('brickwright_overview')).toBe(true)
  })

  it('survives a host with the pre-draft synchronous signature', () => {
    installFakeHost('throw')
    expect(() => (stop = startSiteTools())).not.toThrow()
    expect(window.brickwright!.tools.size).toBe(5)
  })

  it('navigates through the shell router rather than reloading the document', async () => {
    const soft = vi.fn(() => true)
    setLandingNavigator(soft)
    stop = startSiteTools()
    const result = await invoke('brickwright_navigate', { surface: 'explore', demoId: 'heron-sculpture', step: 4 })
    expect(soft).toHaveBeenCalledWith(
      { kind: 'path', href: '/explore?demo=heron-sculpture&step=4' },
      '/explore?demo=heron-sculpture&step=4',
      {},
    )
    expect(result).toMatchObject({ requested: '/explore?demo=heron-sculpture&step=4', surface: 'explore' })
  })

  it('builds the editor and share hrefs the shell actually routes', async () => {
    const seen: string[] = []
    setLandingNavigator((_target, href) => {
      seen.push(href)
      return true
    })
    stop = startSiteTools()
    // Stand in for a mounted workbench so the editor hop does not wait on one.
    registerModelContextTool(workspaceTool('workspace_get'))
    await invoke('brickwright_navigate', { surface: 'editor', blank: true })
    await invoke('brickwright_navigate', { surface: 'editor', showcase: true })
    await invoke('brickwright_navigate', { surface: 'editor', projectId: 'p 1' })
    await invoke('brickwright_navigate', { surface: 'share', slug: 'abc' })
    await invoke('brickwright_navigate', { surface: 'projects' })
    expect(seen).toEqual([
      '/editor?doc=blank',
      '/editor?doc=showcase',
      '/editor?project=p+1',
      '/share/abc',
      '/projects',
    ])
  })

  it('refuses an unknown surface and a share with no slug instead of navigating', async () => {
    const soft = vi.fn(() => true)
    setLandingNavigator(soft)
    stop = startSiteTools()
    const unknown = await window.brickwright!.invoke('brickwright_navigate', { surface: 'nope' })
    expect(unknown.isError).toBe(true)
    const noSlug = await window.brickwright!.invoke('brickwright_navigate', { surface: 'share' })
    expect(noSlug.isError).toBe(true)
    expect(soft).not.toHaveBeenCalled()
  })

  it('waits for the editor surface to register before reporting success', async () => {
    setLandingNavigator(() => true)
    stop = startSiteTools()
    const pending = invoke('brickwright_navigate', { surface: 'editor' })
    // Nothing has registered yet, so the call must still be open.
    const raced = await Promise.race([pending, Promise.resolve('open' as const)])
    expect(raced).toBe('open')
    registerModelContextTool(workspaceTool('workspace_get'))
    await expect(pending).resolves.toMatchObject({ toolsRegistered: ['workspace_get'] })
  })

  it('names what is gated and what unlocks it', async () => {
    stop = startSiteTools()
    const cold = await invoke('brickwright_tools_list')
    expect(cold.gated).toEqual([expect.objectContaining({ requires: 'brickwright_navigate { "surface": "editor" }' })])

    let mode = 'inspect'
    setAutonomyGate({ get: () => mode, set: (next) => (mode = next) })
    registerModelContextTool(workspaceTool('workspace_get'))
    const inspecting = await invoke('brickwright_tools_list')
    expect(inspecting).toMatchObject({ autonomy: 'inspect' })
    expect(JSON.stringify(inspecting.gated)).toContain('action_mutate')

    await invoke('brickwright_autonomy', { mode: 'build' })
    expect(mode).toBe('build')
    const building = await invoke('brickwright_tools_list')
    expect(building.gated).toEqual([])
  })

  it('reports the autonomy gate as absent rather than guessing when no editor owns it', async () => {
    stop = startSiteTools()
    const result = await window.brickwright!.invoke('brickwright_autonomy', { mode: 'build' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.structuredContent)).toContain('brickwright_navigate')
  })

  it('rejects an autonomy mode it does not have', async () => {
    let mode = 'propose'
    setAutonomyGate({ get: () => mode, set: (next) => (mode = next) })
    stop = startSiteTools()
    const result = await window.brickwright!.invoke('brickwright_autonomy', { mode: 'yolo' })
    expect(result.isError).toBe(true)
    expect(mode).toBe('propose')
  })

  it('serves the demo catalogue with no document and no catalog boot', async () => {
    stop = startSiteTools()
    const result = (await invoke('brickwright_demos_list')) as { demos: Array<Record<string, unknown>> }
    expect(result.demos.length).toBeGreaterThan(0)
    expect(result.demos[0]).toMatchObject({
      id: expect.any(String),
      partCount: expect.any(Number),
      stepCount: expect.any(Number),
      openWith: { tool: 'brickwright_navigate' },
    })
  })

  it('advertises a JSON Schema for every tool, since the host validates against it', () => {
    stop = startSiteTools()
    for (const tool of window.brickwright!.tools.values()) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' })
      expect(tool.description.length, tool.name).toBeGreaterThan(40)
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean')
    }
  })

  it('replaces its own registration instead of stacking a second generation', () => {
    const host = installFakeHost()
    stop = startSiteTools()
    const second = startSiteTools()
    expect(window.brickwright!.tools.size).toBe(5)
    expect(host.live()).toHaveLength(5)
    second()
    expect(window.brickwright!.tools.size).toBe(0)
  })
})
