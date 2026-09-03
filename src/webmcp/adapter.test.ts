import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createRoverDocument } from '../cad/__fixtures__/rover'
import { WebMcpAdapter } from './adapter'
import { resetChrome, setChromeRevealHandler, setModelHealthHandler, setProposalReviewHandler } from './chrome'
import { resetRegistry } from './register'
import { setAutonomyGate, startSiteTools } from './site'

describe('WebMCP adapter', () => {
  const adapter = new WebMcpAdapter()
  beforeEach(() => {
    adapter.stop()
    cadEngine.replaceDocument(createRoverDocument())
    cadEngine.setAutonomy('inspect')
  })
  afterEach(() => {
    adapter.stop()
    resetChrome()
    cadEngine.replaceDocument(createRoverDocument())
  })

  it('dynamically changes the write surface with autonomy mode', async () => {
    cadEngine.setAutonomy('inspect')
    adapter.start()
    expect(window.brickwright?.tools.has('workspace_get')).toBe(true)
    expect(window.brickwright?.tools.has('build_preflight')).toBe(false)
    expect(window.brickwright?.tools.has('build_apply')).toBe(false)

    cadEngine.setAutonomy('propose')
    expect(window.brickwright?.tools.has('build_preflight')).toBe(true)
    expect(window.brickwright?.tools.has('build_apply')).toBe(false)

    cadEngine.setAutonomy('build')
    expect(window.brickwright?.tools.has('build_apply')).toBe(true)
    const result = await window.brickwright?.invoke('workspace_get', {})
    expect(result?.structuredContent).toMatchObject({ documentRevision: expect.any(Number) })
  })

  it('discovers the same named capability and nested arguments used by the capability sheet', async () => {
    adapter.start()
    const search = await window.brickwright?.invoke('capabilities_search', { query: 'array' })
    expect(search?.structuredContent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'linear_array',
        kind: 'mutate',
        parity: { human: true, agent: true },
      }),
    ]))

    const help = await window.brickwright?.invoke('capabilities_help', { capability: 'linear_array' })
    expect(help?.structuredContent).toMatchObject({
      id: 'linear_array',
      call: 'action_mutate',
      input: {
        action: 'linear_array',
        expectedRevision: 'integer',
        args: { copies: expect.any(String), offsetLdu: expect.any(String) },
      },
    })
  })

  it('implements connected-selection reads instead of only advertising them', async () => {
    cadEngine.setSelection(['part_0001'])
    adapter.start()
    const result = await window.brickwright?.invoke('action_read', {
      action: 'selection_connected',
      args: { partIds: ['part_0001'] },
    })
    expect(result?.structuredContent).toMatchObject({
      documentRevision: 1,
      seedPartIds: ['part_0001'],
      partIds: expect.arrayContaining(['part_0001']),
      count: expect.any(Number),
    })
    expect((result?.structuredContent as { count: number }).count).toBeGreaterThan(1)
  })

  it('puts every successful agent preflight into the human review surface', async () => {
    cadEngine.setAutonomy('propose')
    adapter.start()
    const part = Object.values(cadEngine.getDocument().parts)[0]
    const focused: string[] = []
    setChromeRevealHandler(() => undefined)
    setProposalReviewHandler((proposalId) => {
      if (proposalId) focused.push(proposalId)
      return { activeProposalId: proposalId ?? null, found: Boolean(proposalId), pending: 1 }
    })

    const result = await window.brickwright?.invoke('build_preflight', {
      label: 'Review the selected colour evidence',
      expectedRevision: cadEngine.getDocument().revision,
      operations: [{ op: 'recolor', partId: part.id, color: part.color }],
    })

    expect(result?.structuredContent).toMatchObject({ id: expect.any(String), status: 'pending' })
    expect(focused).toEqual([(result?.structuredContent as { id: string }).id])
    expect(cadEngine.getSnapshot().transactions).toHaveLength(0)
  })

  it('hands an agent validation scan to the exact human Model Health issue without mutating', async () => {
    const document = createRoverDocument()
    document.constraints = [{
      id: 'health_palette',
      kind: 'palette',
      label: 'Health palette',
      value: [999],
      hard: true,
    }]
    cadEngine.replaceDocument(document)
    adapter.start()
    const focused: Array<string | undefined> = []
    setChromeRevealHandler(() => undefined)
    setModelHealthHandler((issueId) => {
      focused.push(issueId)
      return {
        activeIssueId: issueId ?? null,
        found: Boolean(issueId),
        revision: cadEngine.getDocument().revision,
        blockers: 1,
        warnings: 0,
        selectedPartIds: [],
        truncated: false,
      }
    })
    const revision = cadEngine.getDocument().revision

    const result = await window.brickwright?.invoke('validate_model', {})

    expect(result?.structuredContent).toMatchObject({
      health: {
        ready: false,
        blockers: expect.any(Number),
        issues: expect.arrayContaining([
          expect.objectContaining({ id: 'constraint:health_palette', severity: 'blocker' }),
        ]),
      },
      focused: {
        activeIssueId: 'constraint:health_palette',
        revealed: { surface: 'health', section: 'health' },
      },
    })
    expect(focused).toEqual(['constraint:health_palette'])
    expect(cadEngine.getDocument().revision).toBe(revision)
    expect(cadEngine.getSnapshot().transactions).toHaveLength(0)
  })

  it('executes agent actions through the same planner, engine and transaction history', async () => {
    cadEngine.setAutonomy('build')
    adapter.start()
    const revision = cadEngine.getSnapshot().document.revision
    const result = await window.brickwright?.invoke('action_mutate', {
      action: 'rename_document',
      expectedRevision: revision,
      args: { name: 'Agent-coauthored rover' },
    })

    expect(result?.structuredContent).toMatchObject({
      author: 'agent',
      baseRevision: revision,
      resultRevision: revision + 1,
      sourceTool: 'action_mutate',
      capability: 'rename_document',
    })
    expect(cadEngine.getSnapshot().document.name).toBe('Agent-coauthored rover')
    expect(cadEngine.getSnapshot().transactions.at(-1)).toMatchObject({
      author: 'agent',
      sourceTool: 'action_mutate',
      operations: [{ type: 'document.rename', name: 'Agent-coauthored rover' }],
    })

    expect(cadEngine.undo('human').ok).toBe(true)
    expect(cadEngine.getSnapshot().document.name).toBe('Survey rover')
  })
})

/**
 * Nothing used to assert the *native* path: the suite drove
 * `window.brickwright`, which exists whether or not `document.modelContext`
 * was ever called. So a regression in the one line that hands a tool to the
 * browser would have left every test green and every agent toolless.
 */
describe('WebMCP adapter native host', () => {
  const adapter = new WebMcpAdapter()
  let registered: ModelContextToolDefinition[]

  beforeEach(() => {
    registered = []
    document.modelContext = {
      registerTool(tool, options) {
        registered.push(tool)
        options?.signal?.addEventListener(
          'abort',
          () => {
            registered = registered.filter((entry) => entry !== tool)
          },
          { once: true },
        )
        return Promise.resolve()
      },
    }
    cadEngine.replaceDocument(createRoverDocument())
    cadEngine.setAutonomy('inspect')
  })

  afterEach(() => {
    adapter.stop()
    setAutonomyGate(null)
    resetRegistry()
    delete document.modelContext
  })

  it('hands the CAD tools to document.modelContext and reports the host as native', () => {
    adapter.start()
    expect(adapter.getStatus().native).toBe(true)
    expect(registered.map((tool) => tool.name)).toContain('workspace_get')
    expect(registered.map((tool) => tool.name)).not.toContain('build_apply')
  })

  it('registers and withdraws the write surface at the host as autonomy changes', () => {
    adapter.start()
    cadEngine.setAutonomy('build')
    expect(registered.map((tool) => tool.name)).toContain('build_apply')
    cadEngine.setAutonomy('inspect')
    expect(registered.map((tool) => tool.name)).not.toContain('build_apply')
    expect(registered.map((tool) => tool.name)).toContain('workspace_get')
  })

  it('lets the site surface open the write gate, end to end', async () => {
    adapter.start()
    const stopSite = startSiteTools()
    expect(window.brickwright?.tools.has('build_apply')).toBe(false)

    const opened = await window.brickwright!.invoke('brickwright_autonomy', { mode: 'build' })
    expect(cadEngine.getSnapshot().autonomy).toBe('build')
    expect(opened.structuredContent).toMatchObject({ mode: 'build' })
    expect(window.brickwright?.tools.has('build_apply')).toBe(true)
    // A write tool reached through the bridge must be the real one, not a stub.
    const preflight = await window.brickwright!.invoke('build_preflight', {
      operations: [{ kind: 'delete_part', partId: 'nope' }],
    })
    expect(preflight.structuredContent).toBeDefined()

    adapter.stop()
    expect(window.brickwright?.tools.has('build_apply')).toBe(false)
    // The site tools outlive the editor, so the front door still answers.
    expect(window.brickwright?.tools.has('brickwright_overview')).toBe(true)
    expect(() => window.brickwright!.getDocument()).toThrow(/brickwright_navigate/)
    stopSite()
  })
})
