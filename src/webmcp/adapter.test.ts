import { afterEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { WebMcpAdapter } from './adapter'

describe('WebMCP adapter', () => {
  const adapter = new WebMcpAdapter()
  afterEach(() => adapter.stop())

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
})
