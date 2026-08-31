import { describe, expect, it } from 'vitest'
import { getDocumentBounds } from './geometry'
import { floatingPartIds } from './validation'
import { createBlankDocument } from './sample'
import { IDENTITY_BASIS } from './math'
import type { ModelDocument, PartInstance } from './types'

/**
 * A document larger than an argument list.
 *
 * `Math.max(...values)` throws `RangeError: Maximum call stack size exceeded`
 * past roughly 100,000 arguments — measured on this engine, between 100,000 and
 * 125,000. Every "extent of the whole document" helper used to be written that
 * way, one argument per part, so a large enough imported model would have taken
 * the kernel down during validation rather than merely being slow.
 *
 * 130,000 parts is well past the largest shipped demo (11,493) and is not a
 * performance target; it is the smallest size that proves the ceiling is gone.
 */
describe('a document past the argument-spread ceiling', () => {
  const document = ((): ModelDocument => {
    const base = createBlankDocument('Scale')
    const parts: Record<string, PartInstance> = {}
    for (let index = 0; index < 130_000; index += 1) {
      parts[`p${index}`] = {
        id: `p${index}`,
        definitionId: '3005',
        color: 72,
        transform: { position: [(index % 400) * 20, -24 * Math.floor(index / 400), 0], basis: IDENTITY_BASIS },
        subassemblyId: 'hull',
        stepId: 'step_1',
        provenance: 'human',
        protected: false,
      }
    }
    return { ...base, parts, subassemblies: { ...base.subassemblies, hull: { ...base.subassemblies.hull, partIds: Object.keys(parts) } } }
  })()

  it('measures its extent instead of throwing', () => {
    const bounds = getDocumentBounds(document)
    expect(Number.isFinite(bounds.min[0])).toBe(true)
    expect(Number.isFinite(bounds.max[1])).toBe(true)
    expect(bounds.size[0]).toBeGreaterThan(0)
  }, 60_000)

  it('finds its ground plane instead of throwing', () => {
    // `floatingPartIds` derives the ground the same way, and is on the commit path.
    expect(() => floatingPartIds(document)).not.toThrow()
  }, 120_000)
})
