import { describe, expect, it } from 'vitest'
import { buildBooklet, type BookletMesh } from './booklet'
import { IDENTITY_BASIS } from './math'
import { createEmptyDocument } from './sample'

const box = (): BookletMesh => {
  const points = [
    [-10, -4, -10], [10, -4, -10], [10, 24, -10], [-10, 24, -10],
    [-10, -4, 10], [10, -4, 10], [10, 24, 10], [-10, 24, 10],
  ]
  const faces = [
    [0, 1, 2], [0, 2, 3], [5, 4, 7], [5, 7, 6],
    [4, 0, 3], [4, 3, 7], [1, 5, 6], [1, 6, 2],
    [4, 5, 1], [4, 1, 0], [3, 2, 6], [3, 6, 7],
  ]
  return {
    positions: new Float32Array(points.flat()),
    indices: new Uint32Array(faces.flat()),
    slices: [{ colour: 16, start: 0, count: faces.length * 3 }],
  }
}

const documentWithOnePart = () => {
  const document = createEmptyDocument()
  document.name = 'Scout <script>alert(1)</script>'
  document.revision = 7
  document.parts.p1 = {
    id: 'p1',
    definitionId: '3001',
    color: 15,
    transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
    subassemblyId: 'chassis',
    stepId: 'step_1',
    provenance: 'human',
    protected: false,
  }
  document.subassemblies.chassis.partIds = ['p1']
  document.steps = [{ id: 'step_1', index: 1, name: 'Place <base>', partIds: ['p1'] }]
  return document
}

describe('printable build booklet', () => {
  it('renders one deterministic, self-contained artifact with escaped model text', () => {
    const input = {
      document: documentWithOnePart(),
      geometry: () => box(),
      encode: (image: { coverage: number }) => `data:image/test,${image.coverage.toFixed(4)}`,
      pageWidth: 96,
      pageHeight: 72,
      supersample: 1,
      generatedAt: '2026-08-27T12:00:00.000Z',
    }
    const first = buildBooklet(input)
    const second = buildBooklet(input)

    expect(first.html).toBe(second.html)
    expect(first.steps).toBe(1)
    expect(first.parts).toBe(1)
    expect(first.bom).toHaveLength(1)
    expect(first.buildOrderVerified).toBe(true)
    expect(first.warnings).toEqual([])
    expect(first.html).toContain('Scout &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(first.html).toContain('Place &lt;base&gt;')
    expect(first.html).not.toContain('<script>alert(1)</script>')
    expect(first.html).toContain('data:image/test,')
    expect(first.html).toContain('every part after the first step attaches')
    expect(first.html).toContain('LDCad Shadow Library')
  })

  it('reports missing compiled geometry instead of silently implying a complete guide', () => {
    const result = buildBooklet({
      document: documentWithOnePart(),
      geometry: () => null,
      encode: () => 'data:image/test,empty',
      pageWidth: 64,
      pageHeight: 48,
      supersample: 1,
      generatedAt: '2026-08-27T12:00:00.000Z',
    })
    expect(result.warnings).toEqual([expect.stringMatching(/could not be drawn.*3001/i)])
    expect(result.html).toContain('absent from the step images')
    expect(result.html).toContain('no geometry')
  })
})

