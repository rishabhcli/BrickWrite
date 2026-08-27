import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createShowcaseDocument } from '../cad/sample'
import { WebMcpAdapter } from './adapter'

describe('WebMCP adapter', () => {
  const adapter = new WebMcpAdapter()
  beforeEach(() => {
    adapter.stop()
    cadEngine.replaceDocument(createShowcaseDocument())
    cadEngine.setAutonomy('inspect')
  })
  afterEach(() => {
    adapter.stop()
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
