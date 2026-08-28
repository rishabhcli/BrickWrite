import { createId } from '../../cad/ids'
import type { BuildStep, ConnectionEdge, ModelDocument, PartInstance, Subassembly } from '../../cad/types'
import { sanitizeTitle } from './sanitize'
import type { ForkProvenance, Publication, PublishedDocument } from './types'

/**
 * "Edit a copy".
 *
 * The read-only viewer holds a frozen snapshot and has no command bus, no
 * engine and no repository handle, so it is structurally incapable of writing
 * to the canonical project — there is nothing to write *through*. Forking is
 * therefore not "unlock the publication", it is "construct a new document from
 * the published bytes", which is what this module does.
 *
 * What the fork inherits and what it deliberately does not:
 *
 *   inherits   parts, colours, transforms, subassembly grouping, the build
 *              sequence and the connection graph
 *   does not   the source project's id, its notes, its transaction history, its
 *              constraints, its protected regions or its modules — none of
 *              those were published, so none of them exist to inherit
 *
 * Connection edges come back with `source: 'import-inferred'` and an unknown
 * joint freedom. The publication carries which parts are connected and by what
 * connector family, but not how the pair may still move; claiming a joint the
 * snapshot never recorded would be an invention, and the kernel re-derives
 * freedom from the catalog on the next validation pass anyway.
 */

export interface ForkOptions {
  /** Title for the new project. Defaults to the source title. */
  name?: string
  now?: Date
  /** Overrides the generated project id; used by tests and by the importer. */
  projectId?: string
}

export interface ForkResult {
  document: ModelDocument
  provenance: ForkProvenance
}

export function forkPublication(publication: Publication, options: ForkOptions = {}): ForkResult {
  const timestamp = (options.now ?? new Date()).toISOString()
  const document = documentFromPublished(publication.document, {
    id: options.projectId ?? createId('prj'),
    name: sanitizeTitle(options.name || publication.title) || 'Untitled build',
    timestamp,
  })

  return {
    document,
    provenance: {
      publicationId: publication.id,
      slug: publication.slug,
      sourceRevision: publication.revision,
      sourceContentHash: publication.contentHash,
      sourceTitle: publication.title,
      sourceAuthor: publication.author,
      forkedAt: timestamp,
    },
  }
}

/**
 * Rebuilds an editable `ModelDocument` from a published snapshot.
 *
 * Exposed separately from `forkPublication` because the read-only viewer needs
 * exactly this to hand the snapshot to `computeBuildOrder` and the validation
 * kernel, both of which take a `ModelDocument`. It produces a *new* object every
 * call, so a viewer cannot accidentally hand out a shared mutable document.
 */
export function documentFromPublished(
  published: PublishedDocument,
  identity: { id: string; name: string; timestamp: string },
): ModelDocument {
  const parts: Record<string, PartInstance> = {}
  for (const part of published.parts) {
    parts[part.id] = {
      id: part.id,
      definitionId: part.definitionId,
      color: part.color,
      transform: {
        position: [part.transform.position[0], part.transform.position[1], part.transform.position[2]],
        basis: [...part.transform.basis] as PartInstance['transform']['basis'],
      },
      subassemblyId: part.subassemblyId,
      stepId: part.stepId,
      // A forked part is the forker's own work from here on, and nothing in it
      // is protected: protection is an authoring policy that was never
      // published.
      provenance: 'human',
      protected: false,
    }
  }

  const subassemblies: Record<string, Subassembly> = {}
  for (const group of published.subassemblies) {
    subassemblies[group.id] = {
      id: group.id,
      name: group.name,
      partIds: group.partIds.filter((partId) => partId in parts),
      locked: false,
      accent: group.accent,
    }
  }
  // Every part needs a home; a snapshot whose grouping did not cover everything
  // would otherwise produce an inspector with orphans in it.
  const orphans = Object.keys(parts).filter((partId) => !published.subassemblies.some((group) => group.partIds.includes(partId)))
  if (orphans.length) {
    subassemblies.imported ??= { id: 'imported', name: 'Imported', partIds: [], locked: false, accent: '#738085' }
    subassemblies.imported.partIds = [...new Set([...subassemblies.imported.partIds, ...orphans])]
    for (const partId of orphans) parts[partId].subassemblyId = 'imported'
  }

  const connections: Record<string, ConnectionEdge> = {}
  for (const edge of published.connections) {
    if (!(edge.a.partId in parts) || !(edge.b.partId in parts)) continue
    connections[edge.id] = {
      id: edge.id,
      a: { partId: edge.a.partId, featureId: edge.a.featureId },
      b: { partId: edge.b.partId, featureId: edge.b.featureId },
      family: edge.family,
      joint: { kind: 'unknown' },
      createdAtRevision: 0,
      source: 'import-inferred',
    }
  }

  const steps: BuildStep[] = published.steps.map((step) => ({
    id: step.id,
    index: step.index,
    name: step.name,
    partIds: step.partIds.filter((partId) => partId in parts),
  }))
  const knownSteps = new Set(steps.map((step) => step.id))
  for (const part of Object.values(parts)) {
    if (!knownSteps.has(part.stepId)) part.stepId = steps[0]?.id ?? 'step_1'
  }
  if (!steps.length && Object.keys(parts).length) {
    steps.push({ id: 'step_1', index: 1, name: 'Imported build', partIds: Object.keys(parts) })
    for (const part of Object.values(parts)) part.stepId = 'step_1'
  }

  return {
    schemaVersion: 2,
    id: identity.id,
    name: identity.name,
    // A fork starts its own history at zero. Carrying the source revision would
    // imply a transaction log that does not exist.
    revision: 0,
    catalogVersion: published.catalogVersion,
    createdAt: identity.timestamp,
    updatedAt: identity.timestamp,
    parts,
    connections,
    subassemblies,
    steps,
    notes: [],
    constraints: [],
  }
}

/**
 * A one-line credit for the fork's own publication, if it is ever published.
 *
 * Kept here rather than in the page renderer so the wording is identical
 * wherever provenance is shown.
 */
export function describeFork(provenance: ForkProvenance): string {
  const author = provenance.sourceAuthor?.displayName
  return author
    ? `Forked from "${provenance.sourceTitle}" by ${author}, at revision ${provenance.sourceRevision}.`
    : `Forked from "${provenance.sourceTitle}", at revision ${provenance.sourceRevision}.`
}
