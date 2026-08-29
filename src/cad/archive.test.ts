import { describe, expect, it } from 'vitest'
import {
  parseArchive,
  persistArchive,
  serializeArchive,
  exportProjectArchive,
  attestationOf,
  type BrickwrightArchive,
} from './archive'
import { IDENTITY_BASIS } from './math'
import { MemoryDriver, ProjectRepository, type StoredTransaction } from './persistence'
import { createBlankDocument, createShowcaseDocument } from './sample'
import type { BuilderNote, Constraint, ModelDocument, ModuleDefinition } from './types'
import { validateDocument } from './validation'

const collidingDocument = (): ModelDocument => {
  const document = createBlankDocument('Colliding')
  const base = {
    definitionId: '3001',
    color: 4,
    subassemblyId: 'main',
    stepId: 'step_1',
    provenance: 'human' as const,
    protected: false,
    transform: { position: [0, 0, 0] as const, basis: IDENTITY_BASIS },
  }
  document.parts.a = { ...base, id: 'a' }
  document.parts.b = { ...base, id: 'b', transform: { position: [4, 0, 0], basis: IDENTITY_BASIS } }
  document.revision = 1
  return document
}

describe('project archive', () => {
  it('round-trips connections, notes, constraints and modules', async () => {
    const document = createShowcaseDocument()
    const note: BuilderNote = {
      id: 'note_archive',
      anchorPartIds: [Object.keys(document.parts)[0]!],
      text: 'Keep this edge',
      status: 'open',
      author: 'human',
      revisionCreated: document.revision,
    }
    const constraint: Constraint = {
      id: 'c_archive',
      kind: 'piece-count',
      label: 'Archive budget',
      value: 12,
      hard: false,
    }
    const module: ModuleDefinition = {
      id: 'mod_archive',
      name: 'Bay',
      parts: [{ definitionId: '3001', color: 15, transform: { position: [0, 0, 0], basis: IDENTITY_BASIS } }],
      sizeLdu: [80, 24, 40],
      createdAtRevision: document.revision,
      author: 'human',
    }
    document.notes = [...document.notes, note]
    document.constraints = [...document.constraints, constraint]
    document.modules = [...(document.modules ?? []), module]

    const json = serializeArchive({
      checkpoint: {
        projectId: document.id,
        revision: document.revision,
        savedAt: '2026-08-28T00:00:00.000Z',
        document,
      },
      transactions: [],
      catalogVersion: document.catalogVersion,
      lastValidation: attestationOf(validateDocument(document)),
    })
    const parsed = parseArchive(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const driver = new MemoryDriver()
    const repository = new ProjectRepository(driver)
    const report = await persistArchive(repository, parsed.archive, 'doc_imported_archive')
    const loaded = await repository.loadProject('doc_imported_archive')
    expect(loaded?.document.connections).toEqual(document.connections)
    expect(loaded?.document.notes).toEqual(document.notes)
    expect(loaded?.document.constraints).toEqual(document.constraints)
    expect(loaded?.document.modules).toEqual(document.modules)
    expect(report.importedRevision).toBe(document.revision)
  })

  it('imports the checkpoint when the transaction log is broken', async () => {
    const document = createShowcaseDocument()
    document.revision = 8
    const gap: StoredTransaction = {
      key: `${document.id}:${String(10).padStart(12, '0')}`,
      projectId: document.id,
      resultRevision: 10,
      transaction: {
        id: 'tx_gap',
        author: 'human',
        label: 'Orphan',
        baseRevision: 9,
        resultRevision: 10,
        timestamp: '2026-08-28T00:00:00.000Z',
        operations: [],
        affectedPartIds: [],
        patch: { baseRevision: 9, forward: [], inverse: [], touched: { partIds: [], subassemblyIds: [] } },
      },
    }
    const archive: BrickwrightArchive = JSON.parse(
      serializeArchive({
        checkpoint: {
          projectId: document.id,
          revision: 8,
          savedAt: '2026-08-28T00:00:00.000Z',
          document,
        },
        transactions: [gap],
        catalogVersion: document.catalogVersion,
        lastValidation: attestationOf(validateDocument(document)),
      }),
    )
    const repository = new ProjectRepository(new MemoryDriver())
    const report = await persistArchive(repository, archive, 'doc_gapped')
    expect(report.transactionsAvailable).toBe(1)
    expect(report.transactionsImported).toBe(0)
    const loaded = await repository.loadProject('doc_gapped')
    expect(loaded?.document.revision).toBe(8)
    expect(Object.keys(loaded?.document.parts ?? {})).toEqual(Object.keys(document.parts))
  })

  it('assigns a fresh project id on import', async () => {
    const document = createShowcaseDocument()
    const json = serializeArchive({
      checkpoint: {
        projectId: document.id,
        revision: document.revision,
        savedAt: '2026-08-28T00:00:00.000Z',
        document,
      },
      transactions: [],
      catalogVersion: document.catalogVersion,
      lastValidation: attestationOf(validateDocument(document)),
    })
    const parsed = parseArchive(json)
    if (!parsed.ok) throw new Error(parsed.message)
    const repository = new ProjectRepository(new MemoryDriver())
    await persistArchive(repository, parsed.archive, 'doc_first')
    await persistArchive(repository, parsed.archive, 'doc_second')
    const projects = await repository.listProjects()
    expect(projects.map((project) => project.projectId).sort()).toEqual(['doc_first', 'doc_second'])
  })

  it('reports a catalog version mismatch instead of discarding', async () => {
    const document = createShowcaseDocument()
    const json = serializeArchive({
      checkpoint: {
        projectId: document.id,
        revision: document.revision,
        savedAt: '2026-08-28T00:00:00.000Z',
        document,
      },
      transactions: [],
      catalogVersion: '1999-01',
      lastValidation: attestationOf(validateDocument(document)),
    })
    const parsed = parseArchive(json)
    if (!parsed.ok) throw new Error(parsed.message)
    const repository = new ProjectRepository(new MemoryDriver())
    const report = await persistArchive(repository, parsed.archive, 'doc_mismatch')
    expect(report.catalogVersionMatch).toBe(false)
    const loaded = await repository.loadProject('doc_mismatch')
    expect(loaded?.document.parts).toEqual(document.parts)
  })

  it('recomputes validation rather than trusting the attestation', async () => {
    const document = collidingDocument()
    const json = serializeArchive({
      checkpoint: {
        projectId: document.id,
        revision: document.revision,
        savedAt: '2026-08-28T00:00:00.000Z',
        document,
      },
      transactions: [],
      catalogVersion: document.catalogVersion,
      lastValidation: {
        asOfRevision: document.revision,
        healthy: true,
        collisionCount: 0,
        unverifiedCollisions: 0,
        componentCount: 1,
      },
    })
    const parsed = parseArchive(json)
    if (!parsed.ok) throw new Error(parsed.message)
    const report = await persistArchive(new ProjectRepository(new MemoryDriver()), parsed.archive, 'doc_lie')
    expect(report.storedHealthy).toBe(true)
    expect(report.recomputedHealthy).toBe(false)
  })

  it('refuses an archive whose attestation or annex is missing', () => {
    const document = createShowcaseDocument()
    const json = serializeArchive({
      checkpoint: {
        projectId: document.id,
        revision: document.revision,
        savedAt: '2026-08-28T00:00:00.000Z',
        document,
      },
      transactions: [],
      catalogVersion: document.catalogVersion,
      lastValidation: attestationOf(validateDocument(document)),
    })
    const stripped = JSON.parse(json) as Record<string, unknown>
    delete stripped.lastValidation
    expect(parseArchive(JSON.stringify(stripped)).ok).toBe(false)
    stripped.lastValidation = { healthy: true }
    expect(parseArchive(JSON.stringify(stripped)).ok).toBe(false)
    const withAttestation = JSON.parse(json) as Record<string, unknown>
    withAttestation.transactions = [{ resultRevision: 1 }]
    expect(parseArchive(JSON.stringify(withAttestation)).ok).toBe(false)
  })

  it('serialises the live document when the stored checkpoint is behind', async () => {
    const document = createShowcaseDocument()
    document.revision = 3
    const repository = new ProjectRepository(new MemoryDriver())
    await repository.saveCheckpoint({ ...document, revision: 1 })
    const json = await exportProjectArchive(repository, document, validateDocument(document))
    const parsed = parseArchive(json)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.archive.checkpoint.revision).toBe(3)
  })

  it('counts only annex entries that were actually written', async () => {
    const document = createBlankDocument('Annex')
    document.revision = 0
    const tx = (revision: number): StoredTransaction => ({
      key: `${document.id}:${String(revision).padStart(12, '0')}`,
      projectId: document.id,
      resultRevision: revision,
      transaction: {
        id: `tx_${revision}`,
        author: 'human',
        label: 'Edit',
        baseRevision: revision - 1,
        resultRevision: revision,
        timestamp: '2026-08-28T00:00:00.000Z',
        operations: [],
        affectedPartIds: [],
        patch: {
          baseRevision: revision - 1,
          forward: [],
          inverse: [],
          touched: { partIds: [], subassemblyIds: [] },
        },
      },
    })
    const archive: BrickwrightArchive = JSON.parse(
      serializeArchive({
        checkpoint: {
          projectId: document.id,
          revision: 0,
          savedAt: '2026-08-28T00:00:00.000Z',
          document,
        },
        transactions: [tx(1), tx(2)],
        catalogVersion: document.catalogVersion,
        lastValidation: attestationOf(validateDocument(document)),
      }),
    )
    const repository = new ProjectRepository(new MemoryDriver())
    const original = repository.appendTransaction.bind(repository)
    repository.appendTransaction = async (projectId, transaction) => {
      if (transaction.resultRevision === 2) throw new Error('quota')
      return original(projectId, transaction)
    }
    const report = await persistArchive(repository, archive, 'doc_quota')
    expect(report.transactionsAvailable).toBe(2)
    expect(report.transactionsImported).toBe(1)
  })
})
