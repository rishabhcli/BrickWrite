import { beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createRoverDocument } from '../cad/__fixtures__/rover'
import {
  describeScope,
  expandToConnectedIsland,
  parseReferenceTokens,
  resolveMessageReferences,
  resolveReference,
} from './references'

const context = () => {
  const state = cadEngine.getSnapshot()
  return { document: state.document, selection: state.selection }
}

describe('reference tokens', () => {
  beforeEach(() => {
    cadEngine.replaceDocument(createRoverDocument())
    cadEngine.setAutonomy('propose')
  })

  it('parses every supported kind in one message, left to right', () => {
    const tokens = parseReferenceTokens('Move @selection onto @part:part_0001 near @subassembly:hull, see @note:n1 and @view')
    expect(tokens.map((token) => token.kind)).toEqual(['selection', 'part', 'subassembly', 'note', 'view'])
    expect(tokens[1].targetId).toBe('part_0001')
  })

  it('ignores a bare kind with no id rather than addressing everything', () => {
    expect(parseReferenceTokens('touch up @part please')).toEqual([])
    // @selection and @view legitimately carry no id.
    expect(parseReferenceTokens('look at @view').map((token) => token.kind)).toEqual(['view'])
  })

  it('resolves the live selection to concrete ids', () => {
    cadEngine.setSelection(['part_0001', 'part_0002'])
    const [token] = parseReferenceTokens('@selection')
    const reference = resolveReference(token, context())
    expect(reference.resolved).toBe(true)
    expect(reference.partIds).toEqual(['part_0001', 'part_0002'])
    expect(reference.label).toContain('2 parts')
    expect(reference.revision).toBe(cadEngine.getSnapshot().document.revision)
  })

  it('refuses an empty selection with a reason rather than silently matching nothing', () => {
    cadEngine.setSelection([])
    const [token] = parseReferenceTokens('@selection')
    const reference = resolveReference(token, context())
    expect(reference.resolved).toBe(false)
    expect(reference.problem).toContain('Nothing is selected')
    expect(reference.partIds).toEqual([])
  })

  it('refuses a part id that does not exist at this revision', () => {
    const [token] = parseReferenceTokens('@part:part_9999')
    const reference = resolveReference(token, context())
    expect(reference.resolved).toBe(false)
    expect(reference.problem).toContain('part_9999')
    expect(reference.problem).toContain('revision 1')
  })

  it('resolves an assembly and reports that it is locked', () => {
    const [token] = parseReferenceTokens('@subassembly:cockpit')
    const reference = resolveReference(token, context())
    expect(reference.resolved).toBe(true)
    expect(reference.label).toContain('locked')
    expect(reference.partIds.length).toBe(3)
  })

  it('resolves a note to the parts it is anchored to', () => {
    const note = cadEngine.getSnapshot().document.notes[0]
    const [token] = parseReferenceTokens(`@note:${note.id}`)
    const reference = resolveReference(token, context())
    expect(reference.resolved).toBe(true)
    expect(reference.partIds).toEqual(note.anchorPartIds)
  })

  it('resolves a viewport pin, and refuses one whose parts have gone', () => {
    const pins = [
      { id: 'pin_a', label: 'Rear hatch', partIds: ['part_0001'] },
      { id: 'pin_b', label: 'Deleted bay', partIds: ['part_9998'] },
    ]
    const live = resolveReference(parseReferenceTokens('@pin:pin_a')[0], { ...context(), pins })
    expect(live.resolved).toBe(true)
    expect(live.partIds).toEqual(['part_0001'])

    const dead = resolveReference(parseReferenceTokens('@pin:pin_b')[0], { ...context(), pins })
    expect(dead.resolved).toBe(false)
    expect(dead.problem).toContain('no longer exist')
  })

  it('resolves the camera view to what is on screen', () => {
    const reference = resolveReference(parseReferenceTokens('@view')[0], { ...context(), view: 'isometric' })
    expect(reference.resolved).toBe(true)
    expect(reference.targetId).toBe('isometric')
    expect(reference.partIds.length).toBe(33)
  })

  it('re-resolves attached chips instead of trusting their cached ids', () => {
    cadEngine.setSelection(['part_0001'])
    const attached = resolveReference(parseReferenceTokens('@part:part_0001')[0], context())
    expect(attached.resolved).toBe(true)

    // The operator deletes the part, then sends the message that still carries
    // the chip. A cached id list would address a brick that no longer exists.
    cadEngine.setAutonomy('build')
    expect(cadEngine.execute('Remove', [{ type: 'part.remove', partId: 'part_0001' }], 'human').ok).toBe(true)

    const resolved = resolveMessageReferences('do the thing', context(), [attached])
    expect(resolved.hasUnresolved).toBe(true)
    expect(resolved.partIds).toEqual([])
    expect(resolved.references[0].problem).toContain('part_0001')
  })

  it('de-duplicates a token that appears in both the chips and the text', () => {
    cadEngine.setSelection(['part_0002'])
    const attached = resolveReference(parseReferenceTokens('@selection')[0], context())
    const resolved = resolveMessageReferences('raise @selection by one plate', context(), [attached])
    expect(resolved.references.length).toBe(1)
    expect(resolved.partIds).toEqual(['part_0002'])
  })
})

describe('scope measurement', () => {
  beforeEach(() => {
    cadEngine.replaceDocument(createRoverDocument())
  })

  it('measures bounds in LDraw units and studs from compiled geometry', () => {
    const scope = describeScope(cadEngine.getSnapshot().document, ['part_0001', 'part_0002'])
    expect(scope.boundsLdu).not.toBeNull()
    expect(scope.sizeStuds).not.toBeNull()
    expect(scope.sizeStuds![0]).toBeGreaterThan(0)
    expect(scope.partIds).toEqual(['part_0001', 'part_0002'])
  })

  it('reports neighbours from the persisted connection graph, not proximity', () => {
    const document = cadEngine.getSnapshot().document
    const scope = describeScope(document, ['part_0001'])
    expect(scope.neighbourPartIds.length).toBeGreaterThan(0)
    for (const id of scope.neighbourPartIds) {
      expect(scope.partIds).not.toContain(id)
      expect(document.parts[id]).toBeDefined()
    }
  })

  it('reports protection and locking so a planner is warned before the kernel refuses', () => {
    const scope = describeScope(cadEngine.getSnapshot().document, ['part_0023', 'part_0001'])
    expect(scope.protectedPartIds).toContain('part_0023')
    expect(scope.lockedSubassemblyIds).toContain('cockpit')
  })

  it('drops ids that do not exist rather than reporting a size for them', () => {
    const scope = describeScope(cadEngine.getSnapshot().document, ['part_0001', 'part_9999'])
    expect(scope.partIds).toEqual(['part_0001'])
  })

  it('expands a scope to its whole rigid island', () => {
    const island = expandToConnectedIsland(cadEngine.getSnapshot().document, ['part_0001'])
    expect(island.length).toBeGreaterThan(1)
    expect(island).toContain('part_0001')
  })
})
