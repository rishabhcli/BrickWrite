/**
 * The WebMCP surface that exists on every route, including `/`.
 *
 * The editor's `WebMcpAdapter` owns 41 tools over a live CAD document, and for
 * most of this app's life they were the *only* tools: they register when the
 * workbench mounts, so an agent handed the site's front door found
 * `document.modelContext` with nothing in it and no way to learn otherwise. A
 * judge, or anyone's assistant, opens the deployed origin — not `/editor`.
 *
 * So this host registers at boot, before any route resolves, and is deliberately
 * small: an orientation read, a navigation write, a tool census, the demo
 * catalogue, and the autonomy gate. `brickwright_navigate` is the load-bearing
 * one — it is what turns "zero tools here" into the full workspace surface
 * without a document navigation that would tear the registration down again.
 *
 * It must stay out of the CAD kernel's import graph: it is reachable from
 * `src/platform/index.ts`, which `import-graph.test.ts` asserts never statically
 * reaches `src/cad/**` or `src/editor/**`, and it must not pull zod into the
 * landing document's entry chunk (see `platform/zod-jitless.ts`). Everything
 * heavier than a string check is therefore hand-validated here or reached
 * through `import()` inside `execute`.
 */

import { navigate } from '../features/landing/navigation'
import { PLATFORM_ROUTES } from '../platform/routes'
import type { RouteId } from '../platform/contracts'
import { installBridge, liveTools, onLiveToolsChanged, registerModelContextTool } from './register'

type ToolDefinition = ModelContextToolDefinition

const json = (value: unknown): ModelContextToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
})

const fail = (message: string, repair: string): ModelContextToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: { message, repair } }, null, 2) }],
  structuredContent: { error: { message, repair } },
  isError: true,
})

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}

function str(input: unknown, key: string): string | undefined {
  const value = record(input)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function int(input: unknown, key: string): number | undefined {
  const value = record(input)[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/* --- what the agent is looking at --------------------------------------- */

const ROUTE_IDS = PLATFORM_ROUTES.map((route) => route.id)

/**
 * What each route is for, and what it gives an agent.
 *
 * Written for a model reading it cold: it has one `brickwright_overview` call
 * to work out where to go, and "editor — 40+ tools over a live document" is the
 * sentence that has to carry that decision.
 */
const ROUTE_GUIDE: Record<RouteId, string> = {
  landing: 'Product front door. No document. Navigate away to do work.',
  explore:
    'Ten pre-built, measured demo models with step-by-step build orders. Read-only; good for grounding a request in a real model.',
  editor:
    'The workspace. Mounting it registers 40+ tools over a live CAD document — reads, previews, validation, and (in build autonomy) mutations.',
  projects: 'Saved cloud projects. Requires sign-in. Open one to load it into the editor.',
  account: 'Account settings. Requires sign-in. Nothing here for an agent.',
  share: 'A published, content-addressed model at /share/:slug. Read-only; can be forked into a project.',
  gallery: 'Published models from other builders. Read-only browse.',
}

function currentRouteId(): RouteId {
  if (typeof window === 'undefined') return 'landing'
  const path = window.location.pathname
  if (path === '/' || path === '') return 'landing'
  if (path.startsWith('/share/')) return 'share'
  const match = PLATFORM_ROUTES.find((route) => route.path !== '/' && path.startsWith(route.path))
  return match?.id ?? 'landing'
}

const SITE_TOOL_NAMES = new Set([
  'brickwright_overview',
  'brickwright_navigate',
  'brickwright_tools_list',
  'brickwright_demos_list',
  'brickwright_autonomy',
])

const workspaceTools = () => [...liveTools().keys()].filter((name) => !SITE_TOOL_NAMES.has(name))

/* --- the autonomy gate --------------------------------------------------- */

export type AutonomyGate = {
  get: () => string
  set: (mode: string) => void
}

let autonomyGate: AutonomyGate | null = null

/**
 * Handed over by the editor's adapter on start, taken back on stop.
 *
 * Inverted so this module never imports `cadEngine`: the gate is the kernel's
 * to own, and reading it from here would put the CAD chunk in front of the
 * landing page.
 */
export function setAutonomyGate(gate: AutonomyGate | null): void {
  autonomyGate = gate
}

const AUTONOMY_MODES = ['inspect', 'propose', 'build'] as const

const AUTONOMY_HELP: Record<string, string> = {
  inspect: 'Reads only. No preflight, no writes.',
  propose: 'Reads plus build_preflight and proposal_create. A person applies the result. Default.',
  build: 'Reads, preflights and direct writes via action_mutate / build_apply. Every write is still revision-checked.',
}

/* --- navigation ---------------------------------------------------------- */

function hrefForRoute(input: unknown): { href: string; route: RouteId } | { error: ModelContextToolResult } {
  const surface = str(input, 'surface')
  if (!surface || !ROUTE_IDS.includes(surface as RouteId)) {
    return {
      error: fail(
        `surface must be one of: ${ROUTE_IDS.join(', ')}.`,
        'Call brickwright_overview to see what each surface offers.',
      ),
    }
  }
  const route = surface as RouteId
  const query = new URLSearchParams()
  const demoId = str(input, 'demoId')
  const projectId = str(input, 'projectId')
  const slug = str(input, 'slug')
  const step = int(input, 'step')

  if (route === 'share') {
    if (!slug) return { error: fail('The share surface needs a slug.', 'Pass { surface: "share", slug: "<slug>" }.') }
    return { href: `/share/${encodeURIComponent(slug)}`, route }
  }
  if (route === 'explore') {
    if (demoId) query.set('demo', demoId)
    if (step !== undefined) query.set('step', String(step))
  }
  if (route === 'editor') {
    // These three, and only these three — see `applyEditorQuery` in
    // `platform/boot.ts`. A flag advertised here and ignored there is worse for
    // an agent than one not offered: it would report success on a document it
    // never loaded.
    if (projectId) query.set('project', projectId)
    else if (record(input).blank === true) query.set('doc', 'blank')
    else if (record(input).showcase === true) query.set('doc', 'showcase')
  }
  const search = query.toString()
  return { href: search ? `${routePath(route)}?${search}` : routePath(route), route }
}

const routePath = (route: RouteId) => PLATFORM_ROUTES.find((entry) => entry.id === route)?.path ?? '/'

/**
 * Wait for the destination's tools to show up.
 *
 * A soft route transition returns immediately, but `/editor` then downloads the
 * compiled catalog and warms geometry before the adapter registers anything.
 * Returning before that happened would tell the agent "you are on /editor" and
 * hand it an empty tool list, which reads as a broken page; so the tool blocks
 * until the surface is actually usable, or says plainly that it timed out.
 */
function toolsSettled(expectTools: boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (!expectTools) return Promise.resolve(true)
  if (workspaceTools().length > 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    const unsubscribe = onLiveToolsChanged(() => {
      if (workspaceTools().length > 0) finish(true)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* --- the tools ----------------------------------------------------------- */

function siteTools(): ToolDefinition[] {
  return [
    {
      name: 'brickwright_overview',
      description:
        'Start here. Describes Brickwright — agent-native CAD for physically buildable LEGO models — reports which page is open, which tools are live right now, and which surface to navigate to for the rest. Call this before anything else.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => {
        const route = currentRouteId()
        const workspace = workspaceTools()
        return json({
          product:
            'Brickwright designs LEGO models that can actually be built: every part comes from a compiled 900-part catalogue with real LDraw geometry, every connection is checked against the stud/clutch graph, and the build order is verified step by step.',
          currentPath: typeof window === 'undefined' ? '/' : window.location.pathname,
          currentSurface: route,
          surfaces: ROUTE_GUIDE,
          liveToolCount: liveTools().size,
          workspaceToolsLive: workspace.length,
          autonomy: autonomyGate
            ? { mode: autonomyGate.get(), modes: AUTONOMY_HELP }
            : { mode: null, note: 'The workspace is not loaded, so there is no write gate yet.' },
          nextStep:
            workspace.length > 0
              ? 'The workspace surface is live. Call workspace_get for the document, then capabilities_search to find an operation.'
              : 'Call brickwright_navigate with { "surface": "editor" } to load the workspace and register the CAD tools.',
        })
      },
    },
    {
      name: 'brickwright_navigate',
      description:
        'Open one of the site surfaces and wait until its tools are registered. This is how the CAD tool surface becomes available: navigating to "editor" loads the workspace and registers 40+ document tools. Uses a client-side transition, so already-registered tools survive.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          surface: { type: 'string', enum: [...ROUTE_IDS], description: 'Which surface to open.' },
          demoId: {
            type: 'string',
            description: 'Demo to open. Surface "explore" only; ids come from brickwright_demos_list.',
          },
          step: { type: 'integer', minimum: 0, description: 'Build step to open on explore.' },
          projectId: { type: 'string', description: 'Saved project to load into the editor.' },
          slug: { type: 'string', description: 'Publication slug. Required for surface "share".' },
          blank: { type: 'boolean', description: 'Open the editor on an empty document.' },
          showcase: {
            type: 'boolean',
            description:
              'Open a fresh copy of the shipped showcase — a 2,000-part civic building with a verified build order. Good for taking a finished model apart rather than starting from nothing.',
          },
        },
        required: ['surface'],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const resolved = hrefForRoute(input)
        if ('error' in resolved) return resolved.error
        const before = new Set(liveTools().keys())
        navigate({ kind: 'path', href: resolved.href })
        // Only the editor brings a tool surface with it; waiting on the others
        // would just burn the timeout.
        const settled = await toolsSettled(resolved.route === 'editor', 30_000, context?.signal)
        const added = [...liveTools().keys()].filter((name) => !before.has(name))
        return json({
          // The live URL, not the requested one: `/editor` consumes `?doc=blank`
          // once it has acted on it, and reporting the request back would have
          // the agent believe a one-shot flag is still in the address bar.
          path: typeof window === 'undefined' ? resolved.href : window.location.pathname + window.location.search,
          requested: resolved.href,
          surface: resolved.route,
          surfacePurpose: ROUTE_GUIDE[resolved.route],
          toolsRegistered: added,
          liveToolCount: liveTools().size,
          ...(settled
            ? {}
            : {
                warning:
                  'The surface did not register its tools within 30s. It may need sign-in, or the compiled catalogue may still be downloading. Call brickwright_tools_list to check again.',
              }),
        })
      },
    },
    {
      name: 'brickwright_tools_list',
      description:
        'List every Brickwright tool registered right now, plus the families that are gated behind a surface or an autonomy mode and what unlocks each. Use it when a tool you expected is missing.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => {
        const live = [...liveTools().values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          readOnly: tool.annotations?.readOnlyHint === true,
        }))
        const mode = autonomyGate?.get() ?? null
        const gated: Array<{ family: string; requires: string }> = []
        if (workspaceTools().length === 0) {
          gated.push({
            family:
              'workspace_*, catalog_*, scene_query, validate_model, action_*, generation_*, refinement_*, project_*, share_*',
            requires: 'brickwright_navigate { "surface": "editor" }',
          })
        } else if (mode === 'inspect') {
          gated.push({
            family: 'build_preflight, proposal_create, action_mutate, build_apply, undo_edit, redo_edit',
            requires: 'brickwright_autonomy { "mode": "propose" } for previews, or "build" to write',
          })
        } else if (mode === 'propose') {
          gated.push({
            family: 'action_mutate, build_apply, undo_edit, redo_edit',
            requires: 'brickwright_autonomy { "mode": "build" }',
          })
        }
        return json({ autonomy: mode, live, gated, total: live.length })
      },
    },
    {
      name: 'brickwright_demos_list',
      description:
        'The built-in demo models: measured part counts, dimensions, and the verification each one passed. Available on every page, needs no document. Use it to ground a request in a real buildable model, then open one with brickwright_navigate.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        // Dynamic so the 29 KiB demo projection stays out of the entry chunk.
        const { DEMO_SUMMARIES } = await import('../demos/summary')
        return json({
          demos: DEMO_SUMMARIES.map((demo) => ({
            id: demo.id,
            title: demo.title,
            tagline: demo.tagline,
            discipline: demo.discipline,
            category: demo.category,
            partCount: demo.validation.partCount,
            stepCount: demo.validation.steps,
            footprintStuds: demo.validation.footprintStuds,
            stable: demo.validation.statics.stable,
            collisionCount: demo.validation.collisionCount,
            openWith: { tool: 'brickwright_navigate', input: { surface: 'explore', demoId: demo.id } },
          })),
        })
      },
    },
    {
      name: 'brickwright_autonomy',
      description:
        'Read or set the write gate for agent tools. "inspect" is reads only, "propose" adds previews a person applies, "build" allows direct writes. Called with no mode it only reports. Every write is revision-checked regardless of mode, and the person at the keyboard sees the mode in the editor toolbar and can change it back.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { mode: { type: 'string', enum: [...AUTONOMY_MODES] } },
        additionalProperties: false,
      },
      execute: (input) => {
        if (!autonomyGate) {
          return fail(
            'The workspace is not loaded, so there is no write gate to read.',
            'Call brickwright_navigate { "surface": "editor" } first.',
          )
        }
        const requested = str(input, 'mode')
        if (requested === undefined) {
          return json({ mode: autonomyGate.get(), modes: AUTONOMY_HELP })
        }
        if (!(AUTONOMY_MODES as readonly string[]).includes(requested)) {
          return fail(`mode must be one of: ${AUTONOMY_MODES.join(', ')}.`, 'Omit mode to read the current one.')
        }
        autonomyGate.set(requested)
        return json({
          mode: autonomyGate.get(),
          effect: AUTONOMY_HELP[requested],
          toolsNow: workspaceTools(),
        })
      },
    },
  ]
}

/* --- lifecycle ----------------------------------------------------------- */

let controller: AbortController | null = null

/**
 * Register the site surface. Safe to call more than once; the previous
 * registration is aborted first so a hot reload cannot leave two generations of
 * the same tool answering.
 */
export function startSiteTools(): () => void {
  if (typeof document === 'undefined') return () => {}
  controller?.abort()
  const own = new AbortController()
  controller = own
  installBridge()
  for (const tool of siteTools()) registerModelContextTool(tool, own.signal)
  return () => {
    own.abort()
    if (controller === own) controller = null
  }
}

export function stopSiteTools(): void {
  controller?.abort()
  controller = null
}
