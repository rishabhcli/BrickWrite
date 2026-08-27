import { describe, expect, it } from 'vitest'
import { createShowcaseDocument } from './sample'
import { validateDocument } from './validation'
import { STUD_LDU } from './catalog'

describe('showcase document', () => {
  const document = createShowcaseDocument()
  const report = validateDocument(document)

  it('is built from real catalog parts at exact LDU transforms', () => {
    expect(report.partCount).toBeGreaterThan(30)
    for (const part of Object.values(document.parts)) {
      expect(part.transform.position.every(Number.isFinite)).toBe(true)
    }
  })

  it('has no illegal intersections', () => {
    expect(report.collisions.map((issue) => issue.message)).toEqual([])
  })

  it('is a single connected assembly', () => {
    expect({ components: report.componentCount, loose: report.disconnectedPartIds }).toEqual({ components: 1, loose: [] })
  })

  it('satisfies its own hard constraints', () => {
    expect(report.constraints.filter((item) => item.status === 'fail')).toEqual([])
  })

  it('reports a real connection count and envelope', () => {
    expect(report.connectionCount).toBeGreaterThan(50)
    expect(report.bounds.size[0] / STUD_LDU).toBeLessThanOrEqual(10)
  })
})
