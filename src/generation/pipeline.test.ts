import { describe, expect, it, vi } from 'vitest'
import { ModelProviderUnavailableError, type DesignBrief } from '../platform/contracts'
import { CadEngine } from '../cad/engine'
import { createBlankDocument } from '../cad/sample'
import { STUD_LDU } from '../cad/catalog'
import { IDENTITY_BASIS } from '../cad/math'
import type { CadOperation, ModelDocument, PartInstance } from '../cad/types'
import { compileBrief, compileBriefDeterministically, matchColours } from './brief'
import { GenerationEngine } from './engine'
import {
  structuralHash,
  subgraph,
  topologicalOrder,
  validateGraph,
  mergeProtected,
  type BuildGraph,
} from './graph'
import { GenerationAbortedError, realizeGraph } from './realize'
import {
  DETAIL_SYSTEM,
  GenerationCancelled,
  MAX_DETAIL_FEATURES,
  parseDetail,
  runPipeline,
  runPipelineSync,
  stabilizeMassing,
} from './phases'
import { createGenerationProvider } from './provider'
import { referencesFromEnvelope, compareMasks, frameForEnvelope, maskFromEnvelope, rasteriseSilhouette } from './silhouette'
import { createTestModelProvider } from './testing'

const base = () => createBlankDocument('Generation properties')

const brickField = (id: string, widthStuds: number, depthStuds: number) =>
  ({
    id,
    kind: 'region' as const,
    colour: 71,
    role: 'base',
    anchorLdu: [0, 0, 0] as const,
    region: {
      shape: 'field' as const,
      widthStuds,
      depthStuds,
      courses: 2,
      family: 'plate' as const,
    },
  })

describe('the build graph refuses structures that could not be realised', () => {
  it('rejects an edge that names two families which never mate', () => {
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        brickField('deck', 8, 4),
        { id: 'pin', kind: 'part', colour: 0, role: 'detail', part: { query: 'technic pin' } },
      ],
      edges: [
        {
          id: 'e1',
          from: 'deck',
          to: 'pin',
          fromConnector: { family: 'stud', pick: { kind: 'index', index: 0 } },
          toConnector: { family: 'axle-hole', pick: { kind: 'index', index: 0 } },
          family: 'stud',
        },
      ],
    }
    const violations = validateGraph(graph)
    expect(violations.map((entry) => entry.code)).toContain('INCOMPATIBLE_FAMILIES')
    // Nothing is placed when the structure itself is impossible.
    const result = realizeGraph(graph, base())
    expect(result.operations).toEqual([])
    expect(result.graphViolations.join(' ')).toContain('INCOMPATIBLE_FAMILIES')
  })

  it('rejects two edges competing to place the same node', () => {
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        brickField('a', 4, 4),
        brickField('b', 4, 4),
        { id: 'tile', kind: 'part', colour: 0, role: 'detail', part: { query: 'tile 1 x 2 with groove' } },
      ],
      edges: (['a', 'b'] as const).map((from) => ({
        id: `e_${from}`,
        from,
        to: 'tile',
        fromConnector: { family: 'stud' as const, pick: { kind: 'index' as const, index: 0 } },
        toConnector: { family: 'anti-stud' as const, pick: { kind: 'index' as const, index: 0 } },
        family: 'stud' as const,
      })),
    }
    expect(validateGraph(graph).map((entry) => entry.code)).toContain('MULTIPLE_PARENTS')
  })

  it('hashes shape rather than node names', () => {
    const one: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [brickField('deck', 6, 4)],
      edges: [],
    }
    const renamed: BuildGraph = { ...one, nodes: [{ ...one.nodes[0], id: 'floor' }] }
    expect(structuralHash(renamed)).toBe(structuralHash(one))

    const resized: BuildGraph = {
      ...one,
      nodes: [{ ...one.nodes[0], region: { ...one.nodes[0].region!, widthStuds: 8 } }],
    }
    expect(structuralHash(resized)).not.toBe(structuralHash(one))
  })

  it('orders parents before children and extracts reachable subgraphs', () => {
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        brickField('deck', 8, 4),
        { id: 'wall', kind: 'region', colour: 71, role: 'shell', region: { shape: 'wall', widthStuds: 6, depthStuds: 1, courses: 2, family: 'brick', axis: 'x' } },
        { id: 'loose', kind: 'part', colour: 0, role: 'detail', anchorLdu: [200, 0, 0], part: { query: 'plate 1 x 1' } },
      ],
      edges: [
        {
          id: 'e1',
          from: 'deck',
          to: 'wall',
          fromConnector: { family: 'stud', pick: { kind: 'grid', uStuds: 0, vStuds: 0, level: 'top' } },
          toConnector: { family: 'anti-stud', pick: { kind: 'grid', uStuds: 0, vStuds: 0 } },
          family: 'stud',
        },
      ],
    }
    expect(validateGraph(graph)).toEqual([])
    const order = topologicalOrder(graph).map((node) => node.id)
    expect(order.indexOf('deck')).toBeLessThan(order.indexOf('wall'))
    expect(subgraph(graph, ['deck']).nodes.map((node) => node.id).sort()).toEqual(['deck', 'wall'])
  })

  it('folds approved parts in as fixed inputs and refuses to write to them', () => {
    const graph: BuildGraph = { version: 1, strategy: 'test', nodes: [brickField('deck', 4, 4)], edges: [] }
    const merged = mergeProtected(graph, ['part_0001', 'missing'], new Set(['part_0001']))
    expect(merged.missing).toEqual(['missing'])
    const node = merged.graph.nodes.find((entry) => entry.kind === 'protected')
    expect(node?.existingPartId).toBe('part_0001')

    const writing: BuildGraph = {
      ...merged.graph,
      edges: [
        {
          id: 'bad',
          from: 'deck',
          to: node!.id,
          fromConnector: { family: 'stud', pick: { kind: 'index', index: 0 } },
          toConnector: { family: 'anti-stud', pick: { kind: 'index', index: 0 } },
          family: 'stud',
        },
      ],
    }
    expect(validateGraph(writing).map((entry) => entry.code)).toContain('PROTECTED_WRITE')
  })
})

describe('an attachment that cannot be built is repaired or refused, never kept', () => {
  it('repairs a body collision by moving to another connector, and says which', () => {
    // A windscreen is the honest test case: six anti-studs under a six-by-three
    // body, so two of them can claim entirely different studs and still occupy
    // the same space. Occupancy alone cannot predict that — only the collision
    // check can — which is exactly the situation repair exists for.
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        brickField('deck', 8, 4),
        { id: 'canopyA', kind: 'part', colour: 4, role: 'shell', part: { query: 'windscreen', definitionId: '62360' } },
        { id: 'canopyB', kind: 'part', colour: 4, role: 'shell', part: { query: 'windscreen', definitionId: '62360' } },
      ],
      edges: (['canopyA', 'canopyB'] as const).map((to, index) => ({
        id: `e_${to}`,
        from: 'deck',
        to,
        fromConnector: { family: 'stud' as const, pick: { kind: 'grid' as const, uStuds: index, vStuds: 0, level: 'top' as const } },
        toConnector: { family: 'anti-stud' as const, pick: { kind: 'grid' as const, uStuds: 0, vStuds: 0 } },
        family: 'stud' as const,
      })),
    }

    const result = realizeGraph(graph, base(), { seed: 3 })
    const canopyB = result.nodes.find((node) => node.nodeId === 'canopyB')!
    expect(['repaired', 'rejected']).toContain(canopyB.status)
    expect(canopyB.reason, 'a repair or refusal must carry its reason').toBeTruthy()

    const edgeB = result.edges.find((edge) => edge.edgeId === 'e_canopyB')!
    expect(edgeB.attemptLog?.length ?? 0).toBeGreaterThan(0)
    expect(edgeB.attemptLog![0]).toMatch(/^primary: it collides with /)
    expect(edgeB.attempts).toBeGreaterThan(1)

    if (canopyB.status === 'rejected') {
      expect(canopyB.partIds).toEqual([])
    } else {
      expect(edgeB.repairKind).not.toBe('primary')
      expect(canopyB.partIds).toHaveLength(1)
    }
    // Whatever happened, the document holds exactly the parts the outcomes claim.
    const added = result.operations.filter((operation) => operation.type === 'part.add')
    expect(added.length).toBe(result.partCount)
    expect(Object.keys(result.document.parts)).toHaveLength(result.partCount)
  })

  it('refuses an attachment whose part carries no such connector, naming the part', () => {
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        brickField('deck', 4, 4),
        { id: 'axle', kind: 'part', colour: 4, role: 'detail', part: { query: 'technic axle 6', definitionId: '3706' } },
      ],
      edges: [
        {
          id: 'impossible',
          from: 'deck',
          to: 'axle',
          // Stud to anti-stud is a legal pairing, so the graph itself is valid;
          // a bare Technic axle simply has no anti-stud to offer. There is no
          // repair for that, and the realiser must say so rather than seating it
          // on something else that happens to fit.
          fromConnector: { family: 'stud', pick: { kind: 'grid', uStuds: 0, vStuds: 0, level: 'top' } },
          toConnector: { family: 'anti-stud', pick: { kind: 'index', index: 0 } },
          family: 'stud',
        },
      ],
    }

    expect(validateGraph(graph)).toEqual([])
    const result = realizeGraph(graph, base(), { seed: 1 })
    const node = result.nodes.find((entry) => entry.nodeId === 'axle')!
    expect(node.status).toBe('rejected')
    expect(node.partIds).toEqual([])
    expect(node.reason).toMatch(/anti-stud/)
    expect(result.edges.find((edge) => edge.edgeId === 'impossible')!.status).toBe('rejected')
    // The refused part is genuinely absent from the document, not merely flagged.
    expect(Object.values(result.document.parts).some((part) => part.definitionId === '3706')).toBe(false)
  })

  it('refuses a region that would land clear of its host', () => {
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        brickField('deck', 4, 4),
        {
          id: 'floater',
          kind: 'region',
          colour: 4,
          role: 'floater',
          region: { shape: 'field', widthStuds: 3, depthStuds: 3, courses: 1, family: 'plate', offsetStuds: [40, 40] },
        },
      ],
      edges: [
        {
          id: 'e_floater',
          from: 'deck',
          to: 'floater',
          fromConnector: { family: 'stud', pick: { kind: 'grid', uStuds: 0, vStuds: 0, level: 'top' } },
          toConnector: { family: 'anti-stud', pick: { kind: 'grid', uStuds: 0, vStuds: 0 } },
          family: 'stud',
        },
      ],
    }
    const result = realizeGraph(graph, base(), { seed: 5, repairBudget: 3 })
    const node = result.nodes.find((entry) => entry.nodeId === 'floater')!
    expect(node.status).toBe('rejected')
    expect(node.reason).toMatch(/clear of its host|mate|hover|float/)
  })

  it('rejects a region that would hover beside an already-grounded building', () => {
    const occupied = base()
    occupied.parts.ground = {
      id: 'ground',
      definitionId: '3001',
      color: 72,
      transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
      subassemblyId: Object.keys(occupied.subassemblies)[0] ?? 'main',
      stepId: occupied.steps[0]?.id ?? 'step_1',
      provenance: 'human',
      protected: false,
    }
    const graph: BuildGraph = {
      version: 1,
      strategy: 'test',
      nodes: [
        {
          id: 'ghost',
          kind: 'region',
          colour: 71,
          role: 'base',
          anchorLdu: [400, -200, 0],
          region: { shape: 'field', widthStuds: 4, depthStuds: 2, courses: 1, family: 'plate' },
        },
      ],
      edges: [],
    }
    const result = realizeGraph(graph, occupied, { seed: 1, repairBudget: 2 })
    const node = result.nodes.find((entry) => entry.nodeId === 'ghost')!
    expect(node.status).toBe('rejected')
    expect(node.reason).toMatch(/hover|float/i)
    expect(node.partIds).toEqual([])
  })
})

describe('cancellation leaves nothing behind', () => {
  it('aborts mid-phase, rejects promptly and leaves the base document untouched', async () => {
    const brief = compileBriefDeterministically('Build a grey tower 12 x 12 studs, 20 studs tall, under 400 pieces')
    const document = base()
    const before = JSON.stringify(document)
    const controller = new AbortController()

    const startedAt = Date.now()
    const promise = runPipeline(brief, {
      seed: 9,
      base: document,
      signal: controller.signal,
      // Fired after massing lands; the next phase must not run.
      onPhase: (event) => {
        if (event.phase === 'massing') controller.abort()
      },
    })

    await expect(promise).rejects.toThrow()
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(5_000)
    await promise.catch((cause) => {
      expect(cause instanceof GenerationCancelled || cause instanceof GenerationAbortedError).toBe(true)
    })
    expect(JSON.stringify(document)).toBe(before)
  }, 30_000)

  it('leaves the engine untouched when a run is aborted before it starts', async () => {
    const brief = compileBriefDeterministically('A white cube 6 x 6 studs, 6 studs tall, under 80 pieces')
    const engine = new CadEngine(base())
    engine.setAutonomy('build')
    const before = JSON.stringify(engine.getSnapshot().document)
    const controller = new AbortController()
    controller.abort()

    await expect(
      new GenerationEngine({ provider: createTestModelProvider() }).generate(brief, {
        base: engine.getSnapshot().document,
        seed: 4,
        count: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(JSON.stringify(engine.getSnapshot().document)).toBe(before)
  }, 30_000)
})

describe('silhouette fidelity improves as the pipeline refines', () => {
  it('measures IoU against the requested envelope and improves from massing to detail', async () => {
    const brief = compileBriefDeterministically(
      'Build a light bluish grey tower 10 x 10 studs, 14 studs tall, under 400 pieces',
    )
    expect(brief.envelopeStuds).toEqual([10, 14, 10])
    const references = referencesFromEnvelope(brief.envelopeStuds!)

    const candidate = await runPipeline(brief, {
      seed: 21,
      strategy: 'stacked-slab',
      base: base(),
      references,
    })

    const series = candidate.phases.map((phase) => ({ phase: phase.phase, iou: phase.metrics.silhouetteIou ?? 0 }))
    for (const entry of series) expect(entry.iou, `${entry.phase} produced no IoU`).toBeGreaterThan(0)
    for (let index = 1; index < series.length; index += 1) {
      expect(
        series[index].iou,
        `${series[index].phase} lost ground against ${series[index - 1].phase}`,
      ).toBeGreaterThanOrEqual(series[index - 1].iou - 1e-9)
    }
    expect(series.at(-1)!.iou).toBeGreaterThan(series[0].iou)
    expect(candidate.metrics.silhouetteIou).toBeCloseTo(series.at(-1)!.iou, 10)
  }, 60_000)

  it('scores an empty document at zero and a filled envelope near one', () => {
    const frame = frameForEnvelope('front', [4, 4, 4], { cellLdu: STUD_LDU })
    const reference = maskFromEnvelope(frame, [4, 4, 4])
    const empty = rasteriseSilhouette(base(), frame)
    expect(compareMasks(empty, reference).iou).toBe(0)
    expect(compareMasks(reference, reference).iou).toBe(1)
  })
})

describe('protected regions are inputs, not material', () => {
  it('leaves every protected part byte-identical and never names one in an operation', async () => {
    // The kept parts sit behind the origin, where generation grows away from
    // them, so this measures the protection rule rather than a lucky gap.
    const keepers: PartInstance[] = [0, 1].map((index) => ({
      id: `keep_${index}`,
      definitionId: '3001',
      color: 14,
      transform: { position: [index * 4 * STUD_LDU, 0, -8 * STUD_LDU], basis: IDENTITY_BASIS },
      subassemblyId: 'main',
      stepId: 'step_1',
      provenance: 'human',
      protected: true,
    }))

    const engine = new CadEngine(base())
    const seed = engine.execute(
      'Seed protected region',
      keepers.map((part): CadOperation => ({ type: 'part.add', part })),
      'human',
      engine.getSnapshot().document.revision,
    )
    expect(seed.ok).toBe(true)
    const document: ModelDocument = engine.getSnapshot().document
    const snapshots = keepers.map((part) => JSON.stringify(document.parts[part.id]))

    const brief: DesignBrief = {
      ...compileBriefDeterministically('Build a red platform under 200 pieces'),
      protectedPartIds: keepers.map((part) => part.id),
    }
    expect(brief.envelopeStuds).toBeNull()

    const run = await new GenerationEngine({ provider: createTestModelProvider() }).generate(brief, {
      base: document,
      seed: 5,
      count: 2,
    })
    const all = [...run.candidates, ...run.rejected.map((entry) => entry.candidate)]
    expect(all.length).toBe(2)

    for (const candidate of all) {
      for (let index = 0; index < keepers.length; index += 1) {
        expect(
          JSON.stringify(candidate.document.parts[keepers[index].id]),
          `${candidate.id} altered ${keepers[index].id}`,
        ).toBe(snapshots[index])
      }
      const touched = JSON.stringify(candidate.realize.operations)
      for (const part of keepers) expect(touched.includes(`"${part.id}"`)).toBe(false)
      // Every emitted operation is additive; nothing removes, moves or recolours.
      for (const operation of candidate.realize.operations) {
        expect(['part.add', 'subassembly.add']).toContain(operation.type)
      }
    }
  }, 120_000)
})

describe('the brief compiler is honest about how it read the request', () => {
  it('reports a deterministic compile as deterministic, with no model', async () => {
    const result = await compileBrief('A blue crane 12 x 8 studs, 14 studs tall, under 250 pieces')
    expect(result.method).toBe('deterministic')
    expect(result.provenance.provider).toBe('deterministic')
    expect(result.provenance.model).toBeNull()
    expect(result.notes.join(' ')).toMatch(/no model provider/i)
    expect(result.brief.partBudget).toBe(250)
  })

  it('reports a model compile with the model that produced it', async () => {
    const provider = createTestModelProvider({ id: 'test-double', model: 'double/7' })
    const result = await compileBrief('A green tractor', { provider })
    expect(result.method).toBe('model')
    expect(result.provenance.provider).toBe('test-double')
    expect(result.provenance.model).toBe('double/7')
  })

  it('surfaces a contradiction instead of choosing between the readings', () => {
    const brief = compileBriefDeterministically('A micro-scale but large red castle')
    expect(brief.conflicts.some((entry) => entry.field === 'scale')).toBe(true)
  })

  it('resolves colour words against the compiled LDraw table and drops the rest', () => {
    expect(matchColours('dark bluish grey hull').map((entry) => entry.code)).toEqual([72])
    // A longer name must claim the words a shorter one would otherwise take.
    expect(matchColours('dark bluish grey hull').map((entry) => entry.name)).toEqual(['Dark Bluish Grey'])
    expect(matchColours('a sort of octarine')).toEqual([])
  })
})

describe('the browser client never holds a credential', () => {
  it('reads a newline-delimited result stream', async () => {
    const lines = [
      JSON.stringify({ type: 'accepted', requestId: 'r1' }),
      JSON.stringify({ type: 'progress', stage: 'calling model' }),
      JSON.stringify({
        type: 'result',
        value: { boxes: [] },
        provenance: { provider: 'anthropic', model: 'claude-sonnet-5', promptHash: 'abc', seed: 0, createdAt: '1970-01-01T00:00:00.000Z' },
        usage: { inputTokens: 12, outputTokens: 34 },
      }),
    ].join('\n')

    const stages: string[] = []
    const provider = createGenerationProvider({
      fetchImpl: (async () => new Response(lines, { status: 200 })) as unknown as typeof fetch,
      onProgress: (stage) => stages.push(stage),
    })
    const result = await provider.complete({
      system: 's',
      prompt: 'p',
      schema: { type: 'object' },
      parse: (raw) => raw as { boxes: unknown[] },
    })
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
    expect(result.provenance.model).toBe('claude-sonnet-5')
    expect(stages).toEqual(['calling model'])
  })

  it('turns a missing server credential into ModelProviderUnavailableError', async () => {
    const provider = createGenerationProvider({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: 'model_provider_unavailable', detail: 'ANTHROPIC_API_KEY is not set.' }), {
          status: 503,
        })) as unknown as typeof fetch,
    })
    await expect(
      provider.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => raw }),
    ).rejects.toBeInstanceOf(ModelProviderUnavailableError)
  })

  it('passes an abort straight through to the request', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      expect(init?.signal).toBeDefined()
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    const provider = createGenerationProvider({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(
      provider.complete({ system: 's', prompt: 'p', schema: {}, parse: (raw) => raw, signal: controller.signal }),
    ).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('model massing is audited before it becomes geometry', () => {
  it('compacts missing levels and keeps upper volumes on the deck below', () => {
    const result = stabilizeMassing([
      {
        id: 'base',
        role: 'base',
        atStuds: [0, 0],
        widthStuds: 10,
        depthStuds: 8,
        courses: 3,
        level: 2,
        fill: 'solid',
      },
      {
        id: 'crown',
        role: 'crown',
        atStuds: [9, 7],
        widthStuds: 6,
        depthStuds: 5,
        courses: 2,
        level: 7,
        fill: 'shell',
      },
    ])

    expect(result.boxes).toEqual([
      expect.objectContaining({ id: 'base', level: 0, atStuds: [0, 0] }),
      expect.objectContaining({ id: 'crown', level: 1, atStuds: [7, 5], widthStuds: 3, depthStuds: 3 }),
    ])
    expect(result.repairedBoxes).toBe(2)
    expect(result.droppedBoxes).toBe(0)
    expect(result.notes.join(' ')).toMatch(/Massing audit repaired 2 stack issue/)
  })

  it('drops an upper volume when the preceding level cannot carry a 3 x 3 footprint', () => {
    const result = stabilizeMassing([
      {
        id: 'pin',
        role: 'base',
        atStuds: [0, 0],
        widthStuds: 2,
        depthStuds: 2,
        courses: 1,
        level: 0,
        fill: 'solid',
      },
      {
        id: 'upper',
        role: 'crown',
        atStuds: [0, 0],
        widthStuds: 4,
        depthStuds: 4,
        courses: 1,
        level: 1,
        fill: 'shell',
      },
    ])

    expect(result.boxes.map((box) => box.id)).toEqual(['pin'])
    expect(result.droppedBoxes).toBe(1)
    expect(result.notes.join(' ')).toMatch(/no 3 x 3 supporting deck/)
  })
})

describe('model-driven detail', () => {
  const brief = compileBriefDeterministically('A three-storey workshop 20 x 16 studs, 18 studs tall')

  const withDetail = (features: readonly Record<string, unknown>[]) => {
    const delegate = createTestModelProvider()
    return {
      ...delegate,
      async complete<T>(request: Parameters<typeof delegate.complete<T>>[0]) {
        const properties = (request.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
        if (!('features' in properties)) return delegate.complete<T>(request)
        return {
          value: request.parse({ features }),
          provenance: {
            provider: 'grounding-double',
            model: 'grounding-double/1',
            promptHash: 'detail',
            seed: 0,
            createdAt: new Date(0).toISOString(),
          },
          usage: { inputTokens: 31, outputTokens: 17 },
        }
      },
    }
  }

  it('waits for massing, skeleton and packing before asking for surface features', async () => {
    const timeline: string[] = []
    let detailPrompt = ''
    const provider = createTestModelProvider({
      onRequest: (request) => {
        const properties = (request.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
        const kind = 'boxes' in properties ? 'massing' : 'features' in properties ? 'detail' : 'other'
        timeline.push(`request:${kind}`)
        if (kind === 'detail') detailPrompt = request.prompt
      },
    })

    await runPipeline(brief, {
      seed: 11,
      base: base(),
      provider,
      onPhase: (event) => timeline.push(`phase:${event.phase}`),
    })

    expect(timeline).toEqual([
      'request:massing',
      'phase:massing',
      'phase:skeleton',
      'phase:packing',
      'request:detail',
      'phase:detail',
    ])
    expect(detailPrompt).toMatch(/volumes the kernel actually built/i)
    expect(detailPrompt).toMatch(/Feature budget: at most \d+/)
  })

  it('spends no detail request when the kernel produced no buildable surface', async () => {
    const requestKinds: string[] = []
    const provider = createTestModelProvider({
      onRequest: (request) => {
        const properties = (request.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
        requestKinds.push('boxes' in properties ? 'massing' : 'features' in properties ? 'detail' : 'other')
      },
    })
    const candidate = await runPipeline(brief, {
      seed: 12,
      base: base(),
      provider,
      constraints: { partBudget: 1 },
    })

    expect(requestKinds).toEqual(['massing'])
    expect(candidate.inference.requests).toBe(1)
    expect(candidate.notes.join(' ')).toMatch(/Detail model skipped because the structural phases produced no buildable surface/)
  })

  it('places what the model proposed, resolved from the placeable catalog', async () => {
    const provider = createTestModelProvider({ detail: 'legal' })
    const candidate = await runPipeline(brief, { seed: 11, base: base(), provider })

    const details = candidate.graph.nodes.filter((node) => node.role === 'detail')
    expect(details.length).toBeGreaterThan(0)
    // The proposal's own query, not the hard-coded groove tile every subject
    // used to get.
    expect(details.map((node) => node.part?.query)).toEqual(expect.arrayContaining(['grille tile 1 x 2']))
    expect(details.every((node) => node.part?.query !== 'tile 1 x 2 with groove')).toBe(true)
    expect(candidate.notes.join(' ')).toMatch(/proposed by the model/)
    expect(candidate.notes.join(' ')).not.toMatch(/detail:fallback/)
    expect(candidate.inference.requests).toBe(2)
    expect(candidate.inference.inputTokens).toBeGreaterThan(0)
  })

  it('falls back to the deterministic surface when the proposal is not usable', async () => {
    const provider = createTestModelProvider({ detail: 'illegal' })
    const candidate = await runPipeline(brief, { seed: 11, base: base(), provider })

    expect(candidate.notes.join(' ')).toMatch(/detail:fallback/)
    const details = candidate.graph.nodes.filter((node) => node.role === 'detail')
    expect(details.length).toBeGreaterThan(0)
    expect(details.every((node) => node.part?.query === 'tile 1 x 2 with groove')).toBe(true)
    // A refused proposal costs greebles, never the candidate.
    expect(candidate.metrics.partCount).toBeGreaterThan(40)
    expect(candidate.metrics.collisionCount).toBe(0)
  })

  it('grounds each feature to both a built volume and a placeable identity', async () => {
    const candidate = await runPipeline(brief, {
      seed: 11,
      base: base(),
      provider: withDetail([
        { id: 'good', role: 'base', query: 'grille tile 1 x 2', atXStuds: 1, atZStuds: 0, quarterTurns: 0 },
        { id: 'bad-role', role: 'imaginary-turret', query: 'tile 1 x 2', atXStuds: 1, atZStuds: 0, quarterTurns: 0 },
        { id: 'bad-part', role: 'base', query: 'zzzz_no_catalog_part_8472', atXStuds: 1, atZStuds: 0, quarterTurns: 0 },
      ]),
    })

    const details = candidate.graph.nodes.filter((node) => node.role === 'detail')
    expect(details.map((node) => node.part?.query)).toEqual(['grille tile 1 x 2'])
    expect(details[0]?.part?.definitionId).toBeTruthy()
    expect(candidate.notes.join(' ')).toMatch(/1 of 3 feature\(s\) proposed by the model/)
    expect(candidate.notes.join(' ')).toMatch(/skipped 2 ungrounded/)
  })

  it('uses deterministic detail when a schema-valid proposal grounds nothing', async () => {
    const candidate = await runPipeline(brief, {
      seed: 11,
      base: base(),
      provider: withDetail([
        { id: 'bad', role: 'imaginary-turret', query: 'zzzz_no_catalog_part_8472', atXStuds: 0, atZStuds: 0, quarterTurns: 0 },
      ]),
    })

    expect(candidate.notes.join(' ')).toMatch(/detail:fallback — none of 1 model-proposed/)
    const details = candidate.graph.nodes.filter((node) => node.role === 'detail')
    expect(details.length).toBeGreaterThan(0)
    expect(details.every((node) => node.part?.query === 'tile 1 x 2 with groove')).toBe(true)
  })

  it('records zero model usage for the deterministic path', () => {
    expect(runPipelineSync(brief, { seed: 11, base: base() }).inference).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
  })

  it('refuses a detail payload that names no part rather than inventing one', () => {
    expect(() => parseDetail({ features: [{ id: 'a', role: 'base', atXStuds: 0, atZStuds: 0, quarterTurns: 0 }] }))
      .toThrow(/has no "query"/)
    expect(() => parseDetail({ features: [] })).toThrow(/missing or empty/)
    expect(() =>
      parseDetail({
        features: Array.from({ length: MAX_DETAIL_FEATURES + 1 }, (_, index) => ({
          id: `f${index}`,
          role: 'base',
          query: 'tile',
          atXStuds: 0,
          atZStuds: 0,
          quarterTurns: 0,
        })),
      }),
    ).toThrow(/at most 24/)
  })

  it('tells the model it may not name an identity or a coordinate', () => {
    expect(DETAIL_SYSTEM).toMatch(/Never name a part number, a colour or a world coordinate/)
    expect(DETAIL_SYSTEM).toMatch(/counted from its minimum corner/)
  })
})

describe('the candidate pool', { timeout: 60_000 }, () => {
  const small = compileBriefDeterministically('A shed 8 x 8 studs, 6 studs tall')

  it('overlaps the model calls three at a time rather than one after another', async () => {
    // Concurrency is only observable where the pipeline actually waits, which
    // is the model call. The phases themselves are CPU-bound and synchronous,
    // so a deterministic run has nothing to overlap and measuring there would
    // assert something JavaScript cannot do.
    let inFlight = 0
    let peak = 0
    const double = createTestModelProvider()
    const slow = {
      ...double,
      async complete<T>(request: Parameters<typeof double.complete<T>>[0]) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return await double.complete<T>(request)
        } finally {
          inFlight -= 1
        }
      },
    }

    const seen = new Set<string>()
    const run = await new GenerationEngine({ provider: slow }).generate(small, {
      base: base(),
      count: 6,
      constraints: { partBudget: 120 },
      onPhase: (event) => seen.add(event.candidateId),
    })

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)

    // Interleaved events are exactly why each one has to name its candidate.
    const produced = new Set([...run.candidates, ...run.rejected.map((entry) => entry.candidate)].map((candidate) => candidate.id))
    expect(seen).toEqual(produced)
    expect(seen.size).toBeGreaterThan(1)
    expect(run.inference.requests).toBeGreaterThan(0)
  })

  it('keeps successful candidates when one provider call fails', async () => {
    const delegate = createTestModelProvider()
    const unstable = {
      ...delegate,
      async complete<T>(request: Parameters<typeof delegate.complete<T>>[0]) {
        const properties = (request.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
        if ('boxes' in properties && request.prompt.includes('Stacked slabs')) {
          throw new Error('candidate-specific provider failure')
        }
        return delegate.complete<T>(request)
      },
    }

    const run = await new GenerationEngine({ provider: unstable }).generate(small, {
      base: base(),
      count: 3,
      constraints: { partBudget: 120 },
    })

    expect(run.failed).toEqual([
      expect.objectContaining({
        candidateIndex: 1,
        strategy: 'stacked-slab',
        reason: 'candidate-specific provider failure',
      }),
    ])
    expect(run.candidates.length + run.rejected.length).toBe(2)
    expect(run.notes.join(' ')).toMatch(/successful candidates remain reviewable/)
  })

  it('cancels every candidate in the pool, not just the one that noticed', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      new GenerationEngine().generate(small, { base: base(), count: 6, signal: controller.signal }),
    ).rejects.toBeInstanceOf(GenerationCancelled)
  })
})
