import { describe, expect, it } from 'vitest'
import { basisFromEulerDegrees, IDENTITY_BASIS } from '../cad/math'
import {
  assertExpectations,
  CatalogSearchSchema,
  ContractError,
  jsonSchemaOf,
  MAX_OPERATIONS_PER_BATCH,
  OperationSchema,
  PreflightSchema,
  resolveBasis,
  sanitizeMessage,
  toErrorEnvelope,
  toKernelOperations,
  TOOL_PROFILE,
  toolProfileHash,
} from './contract'

const context = {
  parts: {} as Record<string, { transform: { position: readonly [number, number, number]; basis: typeof IDENTITY_BASIS } }>,
  defaultSubassemblyId: 'hull',
  defaultStepId: 'step_1',
  idPrefix: 'agent_test',
  revision: 7,
}

describe('operation schema', () => {
  it('advertises the same shape it enforces', () => {
    const schema = jsonSchemaOf(PreflightSchema) as {
      required: string[]
      properties: { operations: { maxItems: number; items: { anyOf?: unknown[]; oneOf?: unknown[] } } }
    }
    expect(schema.required).toContain('operations')
    expect(schema.properties.operations.maxItems).toBe(MAX_OPERATIONS_PER_BATCH)
    // The advertised operation type is a real union, not a bare object.
    const variants = schema.properties.operations.items.anyOf ?? schema.properties.operations.items.oneOf
    expect(Array.isArray(variants)).toBe(true)
    expect(variants!.length).toBeGreaterThan(3)
  })

  it('rejects an unknown operation verb', () => {
    const result = OperationSchema.safeParse({ op: 'demolish', partId: 'p1' })
    expect(result.success).toBe(false)
  })

  it('rejects non-finite coordinates', () => {
    const result = OperationSchema.safeParse({ op: 'add', definitionId: '3001', position: [0, Number.NaN, 0] })
    expect(result.success).toBe(false)
  })

  it('rejects a batch beyond the operation ceiling', () => {
    const operations = Array.from({ length: MAX_OPERATIONS_PER_BATCH + 1 }, () => ({ op: 'add', definitionId: '3001' }))
    const result = PreflightSchema.safeParse({ expectedRevision: 0, label: 'Too many', operations })
    expect(result.success).toBe(false)
  })

  it('requires at least one operation', () => {
    expect(PreflightSchema.safeParse({ expectedRevision: 0, label: 'Empty', operations: [] }).success).toBe(false)
  })

  it('accepts an exact basis and an Euler convenience form alike', () => {
    const withBasis = OperationSchema.parse({
      op: 'add',
      definitionId: '3001',
      basis: [...basisFromEulerDegrees([0, 90, 0])],
    })
    const withEuler = OperationSchema.parse({ op: 'add', definitionId: '3001', rotation: [0, 90, 0] })
    const [a] = toKernelOperations([withBasis], context)
    const [b] = toKernelOperations([withEuler], context)
    if (a.type !== 'part.add' || b.type !== 'part.add') throw new Error('expected adds')
    a.part.transform.basis.forEach((value, index) => expect(value).toBeCloseTo(b.part.transform.basis[index], 9))
  })

  it('refuses a sheared basis rather than silently correcting it', () => {
    expect(() => resolveBasis({ basis: [1, 0, 0, 0, 1, 0, 0, 0, 2] }, IDENTITY_BASIS)).toThrow(ContractError)
    try {
      resolveBasis({ basis: [2, 0, 0, 0, 1, 0, 0, 0, 1] }, IDENTITY_BASIS)
    } catch (cause) {
      expect((cause as ContractError).code).toBe('INVALID_INPUT')
      expect((cause as ContractError).repair).toContain('unit length')
    }
  })

  it('translates every verb into a kernel operation', () => {
    const inputs = [
      { op: 'add', definitionId: '3001', color: 15 },
      { op: 'move', partId: 'p1', position: [0, -24, 0] },
      { op: 'remove', partId: 'p2' },
      { op: 'recolor', partId: 'p3', color: 4 },
      { op: 'protect', partId: 'p4', protected: true },
      { op: 'lock-subassembly', subassemblyId: 'cockpit', locked: true },
      { op: 'assign-subassembly', partId: 'p5', subassemblyId: 'deck' },
      { op: 'add-subassembly', subassemblyId: 'sensors', name: 'Sensor suite', accent: '#41d6c3' },
      { op: 'rename-subassembly', subassemblyId: 'deck', name: 'Equipment bay' },
      { op: 'add-note', noteId: 'note_agent', partIds: ['p1', 'p1'], text: 'Check this interface.' },
      { op: 'respond-note', noteId: 'note_1', response: 'Cleared.', resolved: true },
      { op: 'rename-document', name: 'Survey rover v2' },
      { op: 'replace-steps', steps: [{ id: 'generated_1', index: 1, name: 'Foundation', partIds: ['p1', 'p1'] }] },
    ].map((input) => OperationSchema.parse(input))
    expect(toKernelOperations(inputs, context).map((operation) => operation.type)).toEqual([
      'part.add',
      'part.transform',
      'part.remove',
      'part.recolor',
      'part.protect',
      'subassembly.lock',
      'part.assign-subassembly',
      'subassembly.add',
      'subassembly.rename',
      'note.add',
      'note.respond',
      'document.rename',
      'steps.replace',
    ])
    const translated = toKernelOperations(inputs, context)
    expect(translated[9]).toMatchObject({
      type: 'note.add',
      note: { id: 'note_agent', anchorPartIds: ['p1'], author: 'agent', revisionCreated: 7 },
    })
    expect(translated[12]).toMatchObject({
      type: 'steps.replace',
      steps: [{ partIds: ['p1'] }],
    })
  })

  it('bounds catalog search input', () => {
    expect(CatalogSearchSchema.safeParse({ limit: 5000 }).success).toBe(false)
    expect(CatalogSearchSchema.safeParse({ text: 'x'.repeat(500) }).success).toBe(false)
    expect(CatalogSearchSchema.safeParse({ text: 'brick', limit: 20 }).success).toBe(true)
  })
})

describe('error envelope', () => {
  it('redacts credentials, signed URLs and blobs from tool output', () => {
    expect(sanitizeMessage('failed with Authorization: Bearer abc.def-ghi123')).not.toContain('abc.def-ghi123')
    expect(sanitizeMessage('api_key=sk-live-9182736455')).not.toContain('sk-live-9182736455')
    expect(sanitizeMessage('fetch https://cdn.example.com/a.bin?sig=deadbeefcafe failed')).toContain('[REDACTED_SIGNED_URL]')
    expect(sanitizeMessage(`data:image/png;base64,${'A'.repeat(200)}`)).toBe('[REDACTED_DATA_URL]')
    expect(sanitizeMessage(`blob ${'Z'.repeat(400)}`)).toContain('[REDACTED_BLOB]')
  })

  it('strips local filesystem paths', () => {
    const message = sanitizeMessage('ENOENT: no such file /Users/someone/secret-project/model.ldr')
    expect(message).not.toContain('someone')
    expect(message).toContain('[path]')
  })

  it('caps message length so one error cannot flood the context', () => {
    expect(sanitizeMessage('word '.repeat(5000)).length).toBeLessThanOrEqual(2049)
  })

  it('never relays a stack trace', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at /Users/someone/app/src/secret.ts:12:3'
    const envelope = toErrorEnvelope(error)
    expect(JSON.stringify(envelope)).not.toContain('secret.ts')
    expect(envelope.error.code).toBe('INTERNAL_ERROR')
  })

  it('turns a schema failure into an actionable envelope', () => {
    const failure = PreflightSchema.safeParse({ expectedRevision: -1, label: '', operations: [] })
    expect(failure.success).toBe(false)
    if (failure.success) return
    const envelope = toErrorEnvelope(failure.error)
    expect(envelope.error.code).toBe('INVALID_INPUT')
    expect(envelope.error.retryable).toBe(false)
    expect(envelope.error.repair).toContain('capabilities_help')
    // Issues are summarized, not dumped exhaustively.
    expect((envelope.error.details as { issues: unknown[] }).issues.length).toBeLessThanOrEqual(5)
  })

  it('marks staleness retryable and everything else not', () => {
    const stale = toErrorEnvelope(
      new ContractError('STALE_DOCUMENT', 'Expected 4, current 5.', 'Reread and replan.'),
      { currentRevision: 5 },
    )
    expect(stale.error).toMatchObject({ retryable: true, currentRevision: 5 })
    const protectedRegion = toErrorEnvelope(
      new ContractError('PROTECTED_REGION', 'Locked.', 'Work elsewhere.'),
    )
    expect(protectedRegion.error.retryable).toBe(false)
  })
})

describe('tool profile', () => {
  const base = { toolProfile: TOOL_PROFILE, catalogVersion: '2026-07', documentRevision: 4 }

  it('changes when the exposed tool set changes', () => {
    const inspect = toolProfileHash(['workspace_get', 'catalog_search'], '2026-07')
    const build = toolProfileHash(['workspace_get', 'catalog_search', 'build_apply'], '2026-07')
    expect(inspect).not.toBe(build)
  })

  it('is order-independent and catalog-sensitive', () => {
    expect(toolProfileHash(['b', 'a'], '2026-07')).toBe(toolProfileHash(['a', 'b'], '2026-07'))
    expect(toolProfileHash(['a', 'b'], '2026-07')).not.toBe(toolProfileHash(['a', 'b'], '2026-08'))
  })

  it('refuses a call planned against a surface that no longer exists', () => {
    const context = { ...base, profileHash: toolProfileHash(['a'], '2026-07') }
    expect(() => assertExpectations({ expectedToolProfileHash: 'fnv1a:00000000' }, context)).toThrow(ContractError)
    try {
      assertExpectations({ expectedToolProfileHash: 'fnv1a:00000000' }, context)
    } catch (cause) {
      expect((cause as ContractError).code).toBe('STALE_TOOL_PROFILE')
      expect(toErrorEnvelope(cause).error.retryable).toBe(true)
    }
  })

  it('refuses a call planned against a different catalog revision', () => {
    const context = { ...base, profileHash: toolProfileHash(['a'], '2026-07') }
    expect(() => assertExpectations({ expectedCatalogVersion: '2025-01' }, context)).toThrow(/Catalog changed/)
  })

  it('accepts a call whose expectations still hold', () => {
    const profileHash = toolProfileHash(['a'], '2026-07')
    expect(() =>
      assertExpectations({ expectedToolProfileHash: profileHash, expectedCatalogVersion: '2026-07' }, { ...base, profileHash }),
    ).not.toThrow()
  })
})
