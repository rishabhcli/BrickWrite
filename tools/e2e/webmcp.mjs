#!/usr/bin/env node
/**
 * WebMCP acceptance run — the agent's path through the site, not a person's.
 *
 * Everything else in this directory drives the DOM. This one installs a
 * `document.modelContext` recorder before any script runs and then only ever
 * calls the tools the page registered with it, because that is the whole
 * interface an assistant in the ChatGPT desktop browser or in Chrome with
 * `chrome://flags/#enable-webmcp-testing` actually has.
 *
 * The bug it exists to prevent: for most of this app's life the tools were
 * registered by the editor's `useWorkbench`, so `document.modelContext` on the
 * deployed origin's front page held nothing at all, and an agent handed the
 * live URL had no way to discover otherwise. Asserting through
 * `window.brickwright` — as the other suites do — cannot catch that, because
 * the bridge is populated by the same code either way.
 */
import { chromium } from 'playwright'

const url = (process.env.BRICKWRIGHT_E2E_URL ?? 'http://127.0.0.1:4174').replace(/\/+$/, '')

/**
 * A recorder shaped like the draft host.
 *
 * Tools are keyed by identity and dropped when their registration signal
 * aborts, which is what the spec says `AbortSignal` does and what lets this
 * suite observe the write surface appearing and disappearing with the autonomy
 * mode. Unhandled rejections are collected too: `registerTool` resolves
 * asynchronously, so a host that refuses one registration must not poison the
 * page's error channel.
 */
const RECORDER = `
  window.__mcp = new Set()
  window.__unhandled = []
  window.addEventListener('unhandledrejection', (event) => window.__unhandled.push(String(event.reason)))
  document.modelContext = {
    registerTool(tool, options) {
      window.__mcp.add(tool)
      options?.signal?.addEventListener('abort', () => window.__mcp.delete(tool), { once: true })
      return Promise.resolve()
    },
    getTools: async () => [...window.__mcp],
    async executeTool(tool, input) { return tool.execute(input, {}) },
    addEventListener() {},
    removeEventListener() {},
  }
`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const SITE_TOOLS = [
  'brickwright_overview',
  'brickwright_navigate',
  'brickwright_tools_list',
  'brickwright_demos_list',
  'brickwright_autonomy',
]

const browser = await chromium.launch()
const context = await browser.newContext()
await context.addInitScript(RECORDER)
const page = await context.newPage()
const failures = []
page.on('pageerror', (error) => failures.push(error.message))

/** Call a tool the way the host does: through the descriptor it was handed. */
const call = (name, input = {}) =>
  page.evaluate(
    async ([toolName, toolInput]) => {
      const tool = [...window.__mcp].find((entry) => entry.name === toolName)
      if (!tool)
        throw new Error(`${toolName} is not registered. Have: ${[...window.__mcp].map((t) => t.name).join(', ')}`)
      const result = await document.modelContext.executeTool(tool, toolInput)
      if (result.isError) throw new Error(`${toolName} failed: ${result.content?.[0]?.text}`)
      return result.structuredContent ?? result
    },
    [name, input],
  )

const names = () => page.evaluate(() => [...window.__mcp].map((tool) => tool.name))

try {
  /* --- 1. the front door is not empty ----------------------------------- */

  for (const path of ['/', '/explore', '/gallery']) {
    await page.goto(`${url}${path}`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__mcp.size > 0, null, { timeout: 30_000 })
    const registered = await names()
    for (const tool of SITE_TOOLS) {
      assert(
        registered.includes(tool),
        `${path} did not register ${tool} with document.modelContext (has: ${registered})`,
      )
    }
  }
  process.stdout.write(`site tools on every route: ${SITE_TOOLS.length}\n`)

  /* --- 2. every tool is host-legible ------------------------------------ */

  const descriptors = await page.evaluate(() =>
    [...window.__mcp].map((tool) => ({
      name: tool.name,
      description: tool.description,
      schemaType: tool.inputSchema?.type,
      executable: typeof tool.execute === 'function',
      readOnly: tool.annotations?.readOnlyHint,
    })),
  )
  for (const tool of descriptors) {
    assert(tool.schemaType === 'object', `${tool.name} advertises no object inputSchema`)
    assert(tool.executable, `${tool.name} has no execute`)
    assert(typeof tool.description === 'string' && tool.description.length > 40, `${tool.name} has a thin description`)
    assert(typeof tool.readOnly === 'boolean', `${tool.name} declares no readOnlyHint`)
  }

  /* --- 3. orientation, from `/`, with nothing else known ---------------- */

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__mcp.size > 0, null, { timeout: 30_000 })

  const overview = await call('brickwright_overview')
  assert(overview.currentSurface === 'landing', `overview reported ${overview.currentSurface} on /`)
  assert(overview.workspaceToolsLive === 0, 'the landing page should carry no workspace tools')
  assert(/brickwright_navigate/.test(overview.nextStep), 'overview must name the tool that unlocks the workspace')

  const demos = await call('brickwright_demos_list')
  assert(demos.demos.length > 0, 'no demos were reported')
  assert(
    demos.demos.every((demo) => Number.isInteger(demo.partCount) && demo.partCount > 0),
    'a demo reported no measured part count',
  )
  process.stdout.write(`demos readable with no document: ${demos.demos.length}\n`)

  /* --- 4. navigation is what unlocks the workspace ---------------------- */

  const navigated = await call('brickwright_navigate', { surface: 'editor', blank: true })
  assert(!navigated.warning, `navigate reported: ${navigated.warning}`)
  assert(navigated.toolsRegistered.length > 20, `only ${navigated.toolsRegistered.length} tools appeared on /editor`)
  assert(navigated.toolsRegistered.includes('workspace_get'), 'workspace_get did not register')
  assert(new URL(page.url()).pathname === '/editor', `navigate landed on ${page.url()}`)
  // A client transition, not a document load: the site tools must have survived.
  const afterNav = await names()
  for (const tool of SITE_TOOLS) assert(afterNav.includes(tool), `${tool} was lost by navigating`)
  process.stdout.write(`workspace tools after navigate: ${navigated.toolsRegistered.length}\n`)

  /* --- 5. the write gate is discoverable, and it moves ------------------ */

  const gated = await call('brickwright_tools_list')
  assert(gated.autonomy === 'propose', `expected the propose default, got ${gated.autonomy}`)
  assert(
    gated.gated.some((entry) => /action_mutate/.test(entry.family) && /brickwright_autonomy/.test(entry.requires)),
    'tools_list did not say what unlocks the write surface',
  )
  assert(!(await names()).includes('action_mutate'), 'action_mutate is registered before build mode')

  const opened = await call('brickwright_autonomy', { mode: 'build' })
  assert(opened.mode === 'build', `autonomy did not move: ${opened.mode}`)
  assert((await names()).includes('action_mutate'), 'build mode registered no write tools with the host')

  await call('brickwright_autonomy', { mode: 'inspect' })
  assert(!(await names()).includes('action_mutate'), 'inspect mode did not withdraw the write tools from the host')
  await call('brickwright_autonomy', { mode: 'build' })

  /* --- 6. a real read and a real write, through the host --------------- */

  const workspace = await call('workspace_get')
  assert(Number.isInteger(workspace.documentRevision), 'workspace_get returned no revision')

  const placed = await call('action_mutate', {
    action: 'build_field',
    expectedRevision: workspace.documentRevision,
    args: { widthStuds: 4, depthStuds: 4 },
  })
  assert(
    placed.resultRevision > workspace.documentRevision,
    `the write did not advance the revision: ${JSON.stringify(placed).slice(0, 400)}`,
  )
  assert(placed.report?.parts > 0, 'the write reported no parts')
  const after = await call('workspace_get')
  assert(after.partCount > 0, `expected parts after the write, got ${after.partCount}`)
  process.stdout.write(
    `wrote through document.modelContext: revision ${workspace.documentRevision} -> ${placed.resultRevision}, ${after.partCount} parts\n`,
  )

  /* --- 7. a stale revision is still refused --------------------------- */

  const stale = await page.evaluate(async (revision) => {
    const tool = [...window.__mcp].find((entry) => entry.name === 'action_mutate')
    const result = await tool.execute(
      { action: 'build_field', expectedRevision: revision, args: { widthStuds: 2, depthStuds: 2 } },
      {},
    )
    return result.structuredContent
  }, workspace.documentRevision)
  assert(stale?.error?.code === 'STALE_DOCUMENT', `a stale write was not refused: ${JSON.stringify(stale)}`)
  process.stdout.write('a stale write is still refused through the host\n')

  /* --- 8. nothing was swallowed -------------------------------------- */

  const unhandled = await page.evaluate(() => window.__unhandled)
  assert(unhandled.length === 0, `unhandled rejections: ${unhandled.join(' | ')}`)
  assert(failures.length === 0, `page errors: ${failures.join(' | ')}`)

  process.stdout.write('webmcp acceptance ok\n')
} finally {
  await browser.close()
}
