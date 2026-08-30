import { describe, expect, it } from 'vitest'
import { validateTransactionPayload } from '../../../convex/model/transactionValidation'
import { storageJsonProblem } from '../../../convex/model/storageJson'
import { verifyHistoryRecord } from '../../../convex/model/history'
import { CadEngine } from '../../cad/engine'
import { touchedBy, type EntityMutation } from '../../cad/patch'
import type { CadOperation, Transaction } from '../../cad/types'
import { blankProject, commitAll, part, placements } from './harness'
import { canonicalJson, transactionChecksum } from '../serialize'

const base = blankProject('validated-transaction')
const original = placements(base, ['brick']).transactions[0]
const fresh = () => structuredClone(original)
const withPatch = (forward: EntityMutation[], inverse: EntityMutation[]): Transaction => ({
  ...fresh(),
  operations: [],
  patch: { baseRevision: 0, forward, inverse, touched: touchedBy(forward) },
  affectedPartIds: [...touchedBy(forward).partIds],
})

describe('complete stored CAD transactions', () => {
  it.each([
    ['author', { author: 'robot' }],
    ['label', { label: null }],
    ['id', { id: '' }],
    ['timestamp', { timestamp: 'not-a-date' }],
    ['negative revision', { baseRevision: -1 }],
    ['fractional revision', { resultRevision: 1.5 }],
    ['skipped revision', { resultRevision: 3 }],
    ['unsafe revision', { resultRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['operations', { operations: null }],
    ['kind', { kind: 'surprise' }],
    ['sourceTool', { sourceTool: 1 }],
    ['affected ids', { affectedPartIds: [] }],
    ['duplicate affected ids', { affectedPartIds: ['brick', 'brick'] }],
    ['missing patch', { patch: null }],
    ['unsafe id', { id: '__proto__' }],
  ])('refuses an invalid %s', (_name, change) => {
    expect(validateTransactionPayload({ ...fresh(), ...change })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it.each(['forward', 'inverse'] as const)(
    'validates complete entity and collection values in %s patches',
    (direction) => {
      const bad: unknown[] = [
        { kind: 'part', id: 'brick', value: { ...part('brick'), transform: { position: [0, 1], basis: [] } } },
        { kind: 'part', id: 'brick', value: { ...part('brick'), protected: 'yes' } },
        { kind: 'part', id: 'brick', value: { ...part('brick'), id: 'wrong' } },
        { kind: 'subassembly', id: 'hull', value: { id: 'hull', partIds: null } },
        { kind: 'connection', id: 'joint', value: { id: 'joint', a: {}, b: {} } },
        { kind: 'steps', value: [base.steps[0], base.steps[0]] },
        { kind: 'notes', value: [{ id: 'note', text: 'Missing anchor and author' }] },
        { kind: 'constraints', value: [{ id: 'rule', kind: 'anything', value: true }] },
        { kind: 'modules', value: [{ id: 'module', parts: 'not-parts' }] },
        { kind: 'document-name', value: 12 },
        { kind: 'unknown', value: [] },
      ]
      for (const value of bad) {
        const transaction = fresh()
        transaction.patch = { ...transaction.patch, [direction]: [value] }
        expect(validateTransactionPayload(transaction), JSON.stringify(value)).toMatchObject({ ok: false })
      }
    },
  )

  it('requires inverse target coverage without forbidding repeated forward edits', () => {
    const name = (value: string): EntityMutation => ({ kind: 'document-name', value })
    expect(validateTransactionPayload(withPatch([name('first'), name('second')], [name('original')])).ok).toBe(true)
    for (const inverse of [[], [name('original'), name('duplicate')], [{ kind: 'steps', value: [] } as EntityMutation]])
      expect(validateTransactionPayload(withPatch([name('new')], inverse)).ok).toBe(false)
  })

  it('rejects underreported touched sets but permits conservative extra ids', () => {
    for (const touched of [
      { partIds: [], subassemblyIds: ['hull'] },
      { partIds: ['brick'], subassemblyIds: [] },
    ]) {
      const transaction = fresh()
      transaction.patch = { ...transaction.patch, touched }
      expect(validateTransactionPayload(transaction).ok).toBe(false)
    }
    const transaction = fresh()
    transaction.patch = {
      ...transaction.patch,
      touched: { partIds: ['brick', 'extra'], subassemblyIds: ['hull', 'extra'] },
    }
    transaction.affectedPartIds.push('extra')
    expect(validateTransactionPayload(transaction).ok).toBe(true)
  })

  it('preserves optional legacy fields and unknown JSON extensions without normalization', () => {
    const transaction = fresh()
    delete transaction.kind
    delete transaction.sourceTool
    const extended = { ...transaction, extension: { future: ['human', 'agent'] } }
    Object.assign(extended.patch.forward[0], { extension: { review: true } })
    const before = canonicalJson(extended)
    const result = validateTransactionPayload(extended)
    expect(result.ok && result.value).toBe(extended)
    expect(canonicalJson(extended)).toBe(before)
    const name = withPatch([{ kind: 'document-name', value: 'new' }], [{ kind: 'document-name', value: 'old' }])
    Object.assign(name.patch.forward[0], { id: 'extension-not-a-mutation-target' })
    expect(validateTransactionPayload(name).ok).toBe(true)
  })

  it('returns bounded field paths, never model content or schema error values', () => {
    const transaction = fresh()
    const secret = 'private-model-content-do-not-repeat'
    transaction.operations = [{ type: secret, name: secret } as never]
    const error = validateTransactionPayload(transaction)
    expect(error).toMatchObject({ ok: false, error: { details: { path: 'operations.0.type' } } })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('keeps checksum and revision-envelope verification in addition to shape checks', () => {
    const transaction = fresh()
    const record = {
      transaction,
      baseRevision: 0,
      resultRevision: 1,
      clientTransactionId: transaction.id,
      checksum: 'bad',
    }
    expect(verifyHistoryRecord(record, 0)).toMatchObject({ ok: false, error: { code: 'CHECKSUM_MISMATCH' } })
    expect(
      verifyHistoryRecord({ ...record, checksum: transactionChecksum(transaction), clientTransactionId: 'other' }, 0),
    ).toMatchObject({ ok: false, error: { code: 'INCOMPLETE_HISTORY' } })
  })
})

describe('bounded JSON before recursive serialization', () => {
  it.each([NaN, Infinity, -Infinity, 1n, new Date(), new Map(), new Set(), new Uint8Array(2), () => {}, Symbol('no')])(
    'refuses non-JSON or non-finite extension values (%s)',
    (value) => {
      expect(validateTransactionPayload({ ...fresh(), extension: value }).ok).toBe(false)
    },
  )
  it.each(['__proto__', 'constructor', 'prototype'])('refuses unsafe object key %s', (key) => {
    expect(validateTransactionPayload({ ...fresh(), extension: JSON.parse(`{"${key}":true}`) }).ok).toBe(false)
  })
  it('rejects cycles and excessive depth while allowing shared references', () => {
    const shared = { nested: true }
    expect(validateTransactionPayload({ ...fresh(), left: shared, right: shared }).ok).toBe(true)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(validateTransactionPayload({ ...fresh(), extension: cycle }).ok).toBe(false)
    let deep: unknown = true
    for (let i = 0; i < 130; i++) deep = { next: deep }
    expect(validateTransactionPayload({ ...fresh(), extension: deep }).ok).toBe(false)
  })
  it('does not execute getters while inspecting malformed local objects', () => {
    let reads = 0
    const extension = {
      get secret() {
        reads++
        throw new Error('Never called')
      },
    }
    expect(validateTransactionPayload({ ...fresh(), extension }).ok).toBe(false)
    expect(reads).toBe(0)
  })
  it('allows undefined optional properties but not sparse or undefined array entries', () => {
    expect(validateTransactionPayload({ ...fresh(), sourceTool: undefined }).ok).toBe(true)
    for (const extension of [[undefined], new Array(3)])
      expect(validateTransactionPayload({ ...fresh(), extension }).ok).toBe(false)
  })
  it('bounds width and returns a typed failure for unreadable proxies', () => {
    expect(storageJsonProblem(Array(1_000_001).fill(null))).toContain('collection size')
    expect(
      validateTransactionPayload(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('Do not leak')
            },
          },
        ),
      ),
    ).toMatchObject({ ok: false })
  })
})

it('accepts real human/agent edits covering every operation kind and their undo/redo histories', () => {
  const engine = new CadEngine(base)
  engine.setAutonomy('build')
  const assembly = { id: 'room', name: 'Room', locked: false, accent: '#abcdef', partIds: [] }
  const operations: CadOperation[] = [
    { type: 'document.rename', name: 'Validated build' },
    { type: 'part.add', part: part('brick') },
    { type: 'subassembly.add', subassembly: assembly },
    { type: 'part.assign-subassembly', partId: 'brick', subassemblyId: 'room' },
    { type: 'subassembly.rename', subassemblyId: 'room', name: 'Renamed room' },
    { type: 'subassembly.lock', subassemblyId: 'room', locked: true },
    { type: 'subassembly.lock', subassemblyId: 'room', locked: false },
    { type: 'part.transform', partId: 'brick', transform: { ...part('brick').transform, position: [100, 0, 0] } },
    { type: 'part.recolor', partId: 'brick', color: 15 },
    { type: 'part.protect', partId: 'brick', protected: true },
    { type: 'part.protect', partId: 'brick', protected: false },
    {
      type: 'note.add',
      note: {
        id: 'note',
        text: 'Review',
        anchorPartIds: ['brick'],
        author: 'human',
        status: 'open',
        revisionCreated: 0,
      },
    },
    { type: 'note.respond', noteId: 'note', response: 'Reviewed', resolved: true },
    {
      type: 'constraint.set',
      constraint: { id: 'rule', kind: 'piece-count', label: 'Limit', value: 100, hard: false },
    },
    { type: 'constraint.remove', constraintId: 'rule' },
    {
      type: 'module.define',
      module: {
        id: 'module',
        name: 'Module',
        author: 'human',
        createdAtRevision: 0,
        sizeLdu: [40, 24, 80],
        parts: [part('brick')],
      },
    },
    { type: 'module.remove', moduleId: 'module' },
    { type: 'steps.replace', steps: [{ ...base.steps[0], name: 'Complete build', partIds: ['brick'] }] },
    { type: 'part.remove', partId: 'brick' },
  ]
  for (const operation of operations) {
    const committed = engine.execute(operation.type, [operation], 'human', engine.getSnapshot().document.revision)
    expect(committed.ok, operation.type).toBe(true)
    if (committed.ok) expect(validateTransactionPayload(committed.value), operation.type).toMatchObject({ ok: true })
  }
  for (let i = 0; i < operations.length; i++) {
    const undone = engine.undo('human')
    expect(undone.ok).toBe(true)
    if (undone.ok) expect(validateTransactionPayload(undone.value)).toMatchObject({ ok: true })
  }
  for (let i = 0; i < operations.length; i++) {
    const redone = engine.redo('human')
    expect(redone.ok).toBe(true)
    if (redone.ok) expect(validateTransactionPayload(redone.value)).toMatchObject({ ok: true })
  }
  const agent = engine.execute(
    'Agent rename',
    [{ type: 'document.rename', name: 'Agent reviewed' }],
    'agent',
    engine.getSnapshot().document.revision,
  )
  expect(agent.ok && validateTransactionPayload(agent.value).ok).toBe(true)
})

it('accepts real connected geometry without importing the geometry engine into the validator', () => {
  const history = commitAll(base, [
    [{ type: 'part.add', part: part('bottom') }],
    [{ type: 'part.add', part: part('top', [0, -24, 0]) }],
    [{ type: 'part.remove', partId: 'top' }],
  ])
  expect(Object.keys(history.documents[1].connections).length).toBeGreaterThan(0)
  for (const transaction of history.transactions)
    expect(validateTransactionPayload(transaction)).toMatchObject({ ok: true })
})
