import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createShowcaseDocument } from '../cad/sample'
import { WebMcpAdapter } from './adapter'
import { resetChrome, setChromeRevealHandler, setModelHealthHandler, setProposalReviewHandler } from './chrome'

describe('WebMCP adapter', () => {
  const adapter = new WebMcpAdapter()
  beforeEach(() => {
    adapter.stop()
    cadEngine.replaceDocument(createShowcaseDocument())
    cadEngine.setAutonomy('inspect')
  })
  afterEach(() => {
    adapter.stop()
    resetChrome()
    cadEngine.replaceDocument(createShowcaseDocument())
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

  it('discovers the same named capability and nested arguments used by the Command Deck', async () => {
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
    const document = createShowcaseDocument()
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
        revealed: { surface: 'health', section: 'inspector' },
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
