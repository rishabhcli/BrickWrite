import { describe, expect, it } from 'vitest'
import { CadEngine } from './engine'
import { createShowcaseDocument } from './sample'

describe('snapshot identity', () => {
  it('preserves document and validation across selection-only updates', () => {
    const engine = new CadEngine(createShowcaseDocument())
    const before = engine.getSnapshot()
    const report = before.validation
    const id = Object.keys(before.document.parts)[0]
    engine.setSelection([id])
    const after = engine.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.document).toBe(before.document)
    expect(after.validation).toBe(report)
    expect(after.selection).toEqual([id])
    engine.setAutonomy('build')
    expect(engine.getSnapshot().validation).toBe(report)
    engine.replaceDocument(createShowcaseDocument())
    expect(engine.getSnapshot().validation).not.toBe(report)
  })
})
