// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ASSISTANT_TOOLS, toolJsonSchema, toolsForMode } from '../../src/agent/toolschemas'
import { TOOL_NAMES } from '../../src/agent/tools'
import { ADVERTISED_TOOL_NAMES, anthropicTools } from './tools.ts'

describe('advertised tool surface', () => {
  it('advertises exactly the tools the browser can execute', () => {
    expect([...ADVERTISED_TOOL_NAMES].sort()).toEqual([...TOOL_NAMES].sort())
  })

  it('covers every grounding channel the workbench promises', () => {
    expect(ADVERTISED_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'catalog_search',
        'capability_search',
        'scene_query',
        'selection_geometry',
        'notes_read',
        'render_capture',
        'validate_model',
        'preflight_capability',
        'preflight_placement',
        'repair_suggest',
      ]),
    )
  })

  it('derives the advertised JSON Schema from the schema that is enforced', () => {
    for (const tool of anthropicTools('build')) {
      const declaration = ASSISTANT_TOOLS.find((entry) => entry.name === tool.name)!
      expect(tool.input_schema).toEqual(toolJsonSchema(declaration))
      expect((tool.input_schema as { type: string }).type).toBe('object')
      expect(tool.description?.length ?? 0).toBeGreaterThan(40)
    }
  })

  it('withholds the preflight tools in Inspect, structurally', () => {
    const inspect = anthropicTools('inspect').map((tool) => tool.name)
    expect(inspect).not.toContain('preflight_capability')
    expect(inspect).not.toContain('preflight_placement')
    expect(inspect).toContain('scene_overview')
    expect(toolsForMode('inspect').every((tool) => tool.kind === 'read')).toBe(true)
  })

  it('offers preflight — and nothing that commits — in Propose and Build', () => {
    for (const mode of ['propose', 'build'] as const) {
      const names = anthropicTools(mode).map((tool) => tool.name)
      expect(names).toContain('preflight_capability')
      expect(names).toContain('preflight_placement')
      // There is no apply/commit/undo tool in any mode. Committing is an
      // operation of `src/agent/modes.ts`, invoked by a person.
      expect(names.some((name) => /apply|commit|undo|redo|execute|mutate/.test(name))).toBe(false)
    }
  })
})
