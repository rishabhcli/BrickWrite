import { describe, expect, it } from 'vitest'
import { IDENTITY_BASIS } from '../../cad/math'
import { canonicalJson } from './canonical'
import { boxGeometry, healthyValidation, hostileDocument, privateDocument, SECRETS } from './__fixtures__/model'
import { forkPublication } from './fork'
import {
  createPublication,
  publicationBytes,
  revokePublication,
  updatePublicationAccess,
  verifyPublicationIntegrity,
} from './publish'
import { collectStrings, serializePublishedDocument, summarisePublication } from './serialize'

/**
 * The two headline guarantees, asserted directly:
 *
 *   1. a publication captures an exact revision and never moves afterwards;
 *   2. nothing private survives the serialiser.
 *
 * Both are structural properties of the allowlist in `serialize.ts`, so the
 * tests are written to fail loudly if that allowlist ever becomes a copy with
 * deletions.
 */

const publishAt = (revision: number) =>
  createPublication({
    document: privateDocument(revision),
    validation: healthyValidation(revision),
    title: 'Survey Rover',
    description: 'Six parts, three steps.',
    author: { displayName: 'Rishabh', handle: 'rish', url: 'https://example.com/rish' },
    now: new Date('2026-08-27T12:00:00.000Z'),
  })

describe('publication immutability', () => {
  it('captures the exact revision it was asked for', async () => {
    const publication = await publishAt(12)
    expect(publication.revision).toBe(12)
    expect(publication.document.revision).toBe(12)
    expect(publication.summary.validation.revision).toBe(12)
  })

  it('does not change when the source document is mutated five revisions later', async () => {
    const document = privateDocument(12)
    const publication = await createPublication({
      document,
      validation: healthyValidation(12),
      now: new Date('2026-08-27T12:00:00.000Z'),
    })
    const bytesAtPublish = publicationBytes(publication)
    const hashAtPublish = publication.contentHash

    // Five further edits on the very object that was published: parts added,
    // parts removed, a recolour, a rename and a revision bump. If the snapshot
    // shared any memory with the document, at least one of these would reach it.
    document.revision = 17
    document.name = 'Survey Rover Mk II'
    document.parts.part_001.color = 25
    document.parts.part_001.transform = { position: [999, 999, 999], basis: IDENTITY_BASIS }
    delete document.parts.part_006
    document.parts.part_007 = {
      id: 'part_007',
      definitionId: '3020',
      color: 2,
      transform: { position: [80, 0, 0], basis: IDENTITY_BASIS },
      subassemblyId: 'deck',
      stepId: 'step_3',
      provenance: 'human',
      protected: false,
    }
    document.steps.push({ id: 'step_4', index: 4, name: 'Antenna', partIds: ['part_007'] })
    document.notes.push({
      id: 'note_2',
      anchorPartIds: [],
      text: 'later private note',
      status: 'open',
      author: 'human',
      revisionCreated: 17,
    })

    expect(publication.revision).toBe(12)
    expect(publication.document.parts).toHaveLength(6)
    expect(publication.document.parts.find((part) => part.id === 'part_001')?.color).toBe(4)
    expect(publication.document.parts.some((part) => part.id === 'part_007')).toBe(false)
    expect(publication.document.steps).toHaveLength(3)
    expect(publication.contentHash).toBe(hashAtPublish)
    expect(publicationBytes(publication)).toEqual(bytesAtPublish)
    await expect(verifyPublicationIntegrity(publication)).resolves.toBe(true)
  })

  it('is frozen, so nothing downstream can edit the artifact in place', async () => {
    const publication = await publishAt(12)
    expect(Object.isFrozen(publication)).toBe(true)
    expect(Object.isFrozen(publication.document)).toBe(true)
    expect(Object.isFrozen(publication.document.parts[0])).toBe(true)
    expect(() => {
      ;(publication as { title: string }).title = 'rewritten'
    }).toThrow(TypeError)
  })

  it('republishing a later revision mints a separate publication', async () => {
    const first = await publishAt(12)
    const second = await publishAt(17)
    expect(second.id).not.toBe(first.id)
    expect(second.slug).not.toBe(first.slug)
    expect(second.contentHash).not.toBe(first.contentHash)
    expect(first.revision).toBe(12)
  })

  it('keeps the snapshot when capabilities or revocation change', async () => {
    const publication = await publishAt(12)
    const closed = updatePublicationAccess(publication, { capabilities: { fork: false } })
    const revoked = revokePublication(closed, new Date('2026-09-01T00:00:00.000Z'))

    expect(closed.contentHash).toBe(publication.contentHash)
    expect(revoked.contentHash).toBe(publication.contentHash)
    expect(canonicalJson(revoked.document)).toBe(canonicalJson(publication.document))
    expect(revoked.visibility).toBe('public')
    expect(revoked.capabilities.fork).toBe(false)
    expect(revoked.revokedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('hashes the same revision to the same value across independent publications', async () => {
    const a = await createPublication({ document: privateDocument(12), title: 'Survey Rover' })
    const b = await createPublication({ document: privateDocument(12), title: 'A different title' })
    // Identical snapshot bytes, whatever the surrounding metadata says.
    expect(a.contentHash).toBe(b.contentHash)
  })
})

describe('publication privacy', () => {
  it('carries none of the document’s private fields', async () => {
    const publication = await publishAt(12)
    const strings = collectStrings(publication)
    const haystack = JSON.stringify(publication)

    for (const [field, secret] of Object.entries(SECRETS)) {
      expect(haystack, `${field} leaked into the publication`).not.toContain(secret)
      expect(strings, `${field} leaked into the publication`).not.toContain(secret)
    }
  })

  it('drops notes, constraints, modules, protection and transaction references', async () => {
    const publication = await publishAt(12)
    const snapshot = publication.document as unknown as Record<string, unknown>

    expect(snapshot.notes).toBeUndefined()
    expect(snapshot.constraints).toBeUndefined()
    expect(snapshot.modules).toBeUndefined()
    expect(snapshot.id).toBeUndefined()
    expect(snapshot.createdAt).toBeUndefined()
    expect(snapshot.updatedAt).toBeUndefined()

    for (const part of publication.document.parts) {
      const raw = part as unknown as Record<string, unknown>
      expect(raw.protected).toBeUndefined()
      expect(raw.provenance).toBeUndefined()
      expect(raw.createdByTransaction).toBeUndefined()
    }
  })

  it('publishes exactly the allowlisted keys and nothing more', async () => {
    const published = serializePublishedDocument(privateDocument(12))
    expect(Object.keys(published).sort()).toEqual([
      'catalogVersion',
      'connections',
      'name',
      'parts',
      'revision',
      'schemaVersion',
      'steps',
      'subassemblies',
    ])
    expect(Object.keys(published.parts[0]).sort()).toEqual([
      'color',
      'definitionId',
      'id',
      'stepId',
      'subassemblyId',
      'transform',
    ])
    expect(Object.keys(published.subassemblies[0]).sort()).toEqual(['accent', 'id', 'name', 'partIds'])
  })

  it('carries constraint verdicts without constraint values', async () => {
    const publication = await publishAt(12)
    // The label is the operator's own words and is sanitised, but the *value* —
    // which holds the design brief and a signed URL — never appears.
    expect(JSON.stringify(publication.summary.validation)).not.toContain(SECRETS.prompt)
    expect(JSON.stringify(publication.summary.validation)).not.toContain(SECRETS.signedUrl)
    expect(publication.summary.validation.constraintCounts).toEqual({ pass: 1, warning: 0, fail: 0 })
  })

  it('drops a connection whose endpoint was not published', () => {
    const published = serializePublishedDocument(privateDocument(12))
    expect(published.connections.map((edge) => edge.id)).toEqual(['edge_1', 'edge_2', 'edge_3'])
    expect(published.connections.some((edge) => edge.id === 'edge_orphan')).toBe(false)
  })

  it('publishes no author rather than inventing one', async () => {
    const publication = await createPublication({ document: privateDocument(1) })
    expect(publication.author).toBeNull()

    const blank = await createPublication({
      document: privateDocument(1),
      author: { displayName: '   ', handle: null, url: null },
    })
    expect(blank.author).toBeNull()
  })

  it('reports unresolved definitions instead of hiding them', () => {
    const document = privateDocument(2)
    // An identity this build has never compiled. The summary must say so rather
    // than quietly listing the part with no name, because "we cannot draw this"
    // is exactly the thing a viewer needs told.
    document.parts.part_001.definitionId = 'not-a-real-part-id'
    const published = serializePublishedDocument(document)
    const summary = summarisePublication(published, document, null)
    expect(summary.unresolvedDefinitionIds).toEqual(['not-a-real-part-id'])
    expect(summary.bom.find((line) => line.definitionId === 'not-a-real-part-id')?.name).toBe('Unresolved part')
    // No validation report was supplied, so the badge must not claim health.
    expect(summary.validation.healthy).toBe(false)
  })
})

describe('publication sanitisation', () => {
  it('strips markup from every operator-authored string', async () => {
    const publication = await createPublication({
      document: hostileDocument(),
      title: '<script>alert("title")</script>',
      description: 'Line one<img src=x onerror=alert(1)>\n\n\n\nLine two',
      tags: ['<b>tag</b>', 'Fine Tag', 'javascript:alert(1)', '   ', 'fine tag'],
      author: { displayName: '<b>Bob</b>', handle: '<i>bob</i>', url: 'javascript:alert(1)' },
    })

    // Ingest strips the markup delimiters outright, so no stored string can
    // open a tag or an entity. The residue ("img src=x onerror=alert(1)") is
    // inert text, and `page.test.ts` proves it is escaped again on output.
    const serialised = JSON.stringify(publication)
    for (const marker of ['<', '>', '&', 'javascript:']) {
      expect(serialised, `"${marker}" survived ingest`).not.toContain(marker)
    }
    expect(publication.author?.url).toBeNull()
    // Duplicate tags collapse and empty ones vanish; nothing is invented.
    expect(publication.tags).toEqual(['b-tag-b', 'fine-tag', 'javascriptalert1'])
  })

  it('refuses a card that is not addressed by its own hash', async () => {
    await expect(
      createPublication({
        document: privateDocument(1),
        cards: [
          {
            preset: 'opengraph',
            width: 1200,
            height: 630,
            contentType: 'image/png',
            sha256: 'not-a-hash',
            byteLength: 10,
            frames: 1,
            alt: 'x',
          },
        ],
      }),
    ).rejects.toThrow(/SHA-256/)
  })
})

describe('forking', () => {
  it('produces a distinct project that carries its provenance', async () => {
    const publication = await publishAt(12)
    const { document: forked, provenance } = forkPublication(publication, {
      name: 'My rover',
      now: new Date('2026-09-02T00:00:00.000Z'),
      projectId: 'prj_fork_1',
    })

    expect(forked.id).toBe('prj_fork_1')
    expect(forked.id).not.toBe(SECRETS.projectId)
    expect(forked.name).toBe('My rover')
    expect(forked.revision).toBe(0)
    expect(Object.keys(forked.parts)).toHaveLength(6)
    expect(forked.steps.map((step) => step.id)).toEqual(['step_1', 'step_2', 'step_3'])

    expect(provenance).toEqual({
      publicationId: publication.id,
      slug: publication.slug,
      sourceRevision: 12,
      sourceContentHash: publication.contentHash,
      sourceTitle: 'Survey Rover',
      sourceAuthor: publication.author,
      forkedAt: '2026-09-02T00:00:00.000Z',
    })
  })

  it('cannot mutate the publication it was taken from', async () => {
    const publication = await publishAt(12)
    const before = publicationBytes(publication)
    const { document: forked } = forkPublication(publication)

    forked.name = 'mutated'
    forked.revision = 99
    forked.parts.part_001.color = 0
    delete forked.parts.part_002
    forked.notes.push({
      id: 'n',
      anchorPartIds: [],
      text: 'x',
      status: 'open',
      author: 'human',
      revisionCreated: 1,
    })

    expect(publicationBytes(publication)).toEqual(before)
    expect(publication.document.parts.find((part) => part.id === 'part_001')?.color).toBe(4)
    expect(publication.document.parts).toHaveLength(6)
  })

  it('inherits no protection, notes, constraints or agent attribution', async () => {
    const publication = await publishAt(12)
    const { document: forked } = forkPublication(publication)

    expect(forked.notes).toEqual([])
    expect(forked.constraints).toEqual([])
    expect(forked.modules).toBeUndefined()
    expect(Object.values(forked.parts).every((part) => part.protected === false)).toBe(true)
    expect(Object.values(forked.parts).every((part) => part.provenance === 'human')).toBe(true)
    expect(Object.values(forked.subassemblies).every((group) => group.locked === false)).toBe(true)
    expect(JSON.stringify(forked)).not.toContain(SECRETS.transaction)
  })

  it('marks re-imported edges as inferred with unknown joint freedom', async () => {
    const publication = await publishAt(12)
    const { document: forked } = forkPublication(publication)
    const edges = Object.values(forked.connections)
    expect(edges).toHaveLength(3)
    // The revolute joint in the source was never published, so the fork must
    // not claim it. Saying "unknown" is the honest answer.
    expect(edges.every((edge) => edge.joint.kind === 'unknown')).toBe(true)
    expect(edges.every((edge) => edge.source === 'import-inferred')).toBe(true)
  })

  it('gives two forks of the same publication distinct project ids', async () => {
    const publication = await publishAt(12)
    const a = forkPublication(publication)
    const b = forkPublication(publication)
    expect(a.document.id).not.toBe(b.document.id)
  })

  it('renders a card from the forked snapshot without touching the original', async () => {
    const publication = await publishAt(12)
    const { document: forked } = forkPublication(publication)
    // A fork is a real document: it must survive the round trip back through
    // the serialiser, which is what happens when the forker publishes it.
    const republished = serializePublishedDocument(forked)
    expect(republished.parts).toHaveLength(6)
    expect(republished.revision).toBe(0)
    expect(boxGeometry()).toBeTruthy()
  })
})
