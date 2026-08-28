import { catalog, getColor, PLATE_LDU, STUD_LDU } from '../../cad/catalog'
import { getDocumentBounds } from '../../cad/geometry'
import type { ModelDocument, ValidationReport } from '../../cad/types'
import { canonicalBytes, contentHash } from './canonical'
import { LIMITS, sanitizeLabel, sanitizeText, sanitizeTitle } from './sanitize'
import {
  PUBLICATION_SCHEMA_VERSION,
  ShareError,
  type PublicationBomLine,
  type PublicationSummary,
  type PublicationValidation,
  type PublishedConnection,
  type PublishedDocument,
  type PublishedPart,
  type PublishedStep,
  type PublishedSubassembly,
} from './types'

/**
 * The publication serialiser.
 *
 * This is an **allowlist**, and that is the whole design. A denylist — "copy
 * the document, then delete the notes" — fails the first time somebody adds a
 * field to `ModelDocument`, and the failure mode is a private note on a public
 * page. Here, a new document field is invisible to publication until somebody
 * deliberately adds it below, so the default for anything unknown is "not
 * published".
 *
 * What is deliberately dropped, and why:
 *
 *   `id`                        the private project handle; it addresses the
 *                               owner's local and cloud storage
 *   `createdAt` / `updatedAt`   when somebody works is nobody else's business
 *   `notes`                     builder notes are a private conversation, and
 *                               they carry agent prompts and responses verbatim
 *   `constraints`              `value: unknown` — an arbitrary payload from the
 *                               design brief, including prompt text
 *   `modules`                   private reusable sub-builds with author labels
 *   `part.protected`            protection is an authoring policy, and it maps
 *                               the owner's locked regions for an attacker
 *   `part.provenance`           human-vs-agent attribution per part
 *   `part.createdByTransaction` a direct index into the transaction log
 *
 * Nothing about transactions, proposals, prompts or provenance reaches this
 * function at all: it takes a `ModelDocument`, and the log lives beside it in
 * `EngineSnapshot`.
 */

const bySortKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Captures the model payload of a publication at an exact revision.
 *
 * The result is a fresh structure built field-by-field from primitives, so it
 * shares no memory with the source document. That is what makes a later
 * in-place mutation of the live document unable to reach a captured
 * publication.
 */
export function serializePublishedDocument(document: ModelDocument): PublishedDocument {
  const partIds = Object.keys(document.parts).sort(bySortKey)
  if (partIds.length > LIMITS.parts) {
    throw new ShareError(
      'PAYLOAD_TOO_LARGE',
      `This model has ${partIds.length} parts, over the ${LIMITS.parts}-part publication limit.`,
      413,
    )
  }

  const parts: PublishedPart[] = partIds.map((id) => {
    const part = document.parts[id]
    const { position, basis } = part.transform
    return {
      id: part.id,
      definitionId: part.definitionId,
      color: part.color,
      // Copied element-by-element rather than spread: a typed array or a
      // getter-backed tuple would otherwise survive into the snapshot and stay
      // linked to the live document.
      transform: {
        position: [position[0], position[1], position[2]],
        basis: [basis[0], basis[1], basis[2], basis[3], basis[4], basis[5], basis[6], basis[7], basis[8]],
      },
      subassemblyId: part.subassemblyId,
      stepId: part.stepId,
    }
  })

  const known = new Set(partIds)
  const connections: PublishedConnection[] = Object.keys(document.connections)
    .sort(bySortKey)
    .map((id) => document.connections[id])
    // An edge to a part that is not in the snapshot would describe a structure
    // the viewer cannot draw; dropping it keeps the published graph closed.
    .filter((edge) => known.has(edge.a.partId) && known.has(edge.b.partId))
    .map((edge) => ({
      id: edge.id,
      a: { partId: edge.a.partId, featureId: edge.a.featureId },
      b: { partId: edge.b.partId, featureId: edge.b.featureId },
      family: edge.family,
    }))

  const subassemblies: PublishedSubassembly[] = Object.keys(document.subassemblies)
    .sort(bySortKey)
    .map((id) => document.subassemblies[id])
    .map((group) => ({
      id: group.id,
      // Group names are operator-authored free text and land in the viewer's
      // DOM, so they are sanitised here rather than at every render site.
      name: sanitizeLabel(group.name),
      partIds: group.partIds.filter((partId) => known.has(partId)).sort(bySortKey),
      accent: normaliseHex(group.accent),
    }))

  const steps: PublishedStep[] = [...document.steps]
    .sort((a, b) => a.index - b.index || bySortKey(a.id, b.id))
    .map((step, index) => ({
      id: step.id,
      // Renumbered from the sorted order so a published sequence is always
      // 1..n even if the source document had gaps.
      index: index + 1,
      name: sanitizeLabel(step.name),
      partIds: step.partIds.filter((partId) => known.has(partId)),
    }))
    .filter((step) => step.partIds.length > 0)

  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    name: sanitizeTitle(document.name),
    revision: document.revision,
    catalogVersion: sanitizeText(document.catalogVersion, 64),
    parts,
    connections,
    subassemblies,
    steps,
  }
}

/** `#rrggbb`, or a neutral line colour when the source is not a hex triple. */
function normaliseHex(value: unknown): string {
  if (typeof value !== 'string') return '#738085'
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim())
  if (!match) return '#738085'
  const digits = match[1].toLowerCase()
  return `#${digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits}`
}

/**
 * The public summary: what a stranger needs to judge the model.
 *
 * Built from the snapshot rather than the live document, so it can never
 * describe a revision the publication does not contain.
 */
export function summarisePublication(
  published: PublishedDocument,
  document: ModelDocument,
  validation: ValidationReport | null,
): PublicationSummary {
  const grouped = new Map<string, PublicationBomLine>()
  const unresolved = new Set<string>()
  for (const part of published.parts) {
    const definition = catalog.get(part.definitionId)
    if (!definition) unresolved.add(part.definitionId)
    const key = `${part.definitionId}:${part.color}`
    const existing = grouped.get(key)
    if (existing) {
      existing.quantity += 1
      continue
    }
    const colour = getColor(part.color)
    grouped.set(key, {
      definitionId: part.definitionId,
      ldrawId: definition?.ldrawId ?? part.definitionId,
      // A catalog name is compiled data, not user input, but it reaches the
      // page through the same sink as everything else and is treated the same.
      name: sanitizeLabel(definition?.name ?? 'Unresolved part'),
      colorCode: part.color,
      colorName: sanitizeLabel(colour.name),
      colorHex: normaliseHex(colour.hex),
      quantity: 1,
    })
  }

  const bom = [...grouped.values()].sort(
    (a, b) =>
      a.definitionId.localeCompare(b.definitionId, undefined, { numeric: true }) || a.colorCode - b.colorCode,
  )

  const bounds = getDocumentBounds(document)

  return {
    partCount: published.parts.length,
    uniquePartCount: new Set(published.parts.map((part) => part.definitionId)).size,
    stepCount: published.steps.length,
    envelopeStuds: [
      round1(bounds.size[0] / STUD_LDU),
      round1(bounds.size[1] / PLATE_LDU),
      round1(bounds.size[2] / STUD_LDU),
    ],
    boundsLdu: {
      min: [round1(bounds.min[0]), round1(bounds.min[1]), round1(bounds.min[2])],
      max: [round1(bounds.max[0]), round1(bounds.max[1]), round1(bounds.max[2])],
      size: [round1(bounds.size[0]), round1(bounds.size[1]), round1(bounds.size[2])],
    },
    bom,
    validation: summariseValidation(published, validation),
    unresolvedDefinitionIds: [...unresolved].sort(bySortKey),
  }
}

const round1 = (value: number) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : 0)

/**
 * The validation badge.
 *
 * When no report was supplied the badge does not guess: `healthy` is false and
 * every count is zero except the part count, and the viewer renders "not
 * validated" rather than a green tick. A badge that lies is worse than no
 * badge.
 */
function summariseValidation(
  published: PublishedDocument,
  report: ValidationReport | null,
): PublicationValidation {
  if (!report) {
    return {
      revision: published.revision,
      healthy: false,
      partCount: published.parts.length,
      connectionCount: published.connections.length,
      collisionCount: 0,
      unverifiedCollisionCount: 0,
      componentCount: 0,
      constraints: [],
    }
  }
  return {
    revision: report.revision,
    healthy: report.healthy,
    partCount: report.partCount,
    connectionCount: report.connectionCount,
    collisionCount: report.collisions.length,
    unverifiedCollisionCount: report.unverifiedCollisions,
    componentCount: report.componentCount,
    // Only the label and the verdict. Constraint *values* come from the design
    // brief and can carry the original prompt text.
    constraints: report.constraints.map((entry) => ({
      label: sanitizeLabel(entry.label),
      status: entry.status,
    })),
  }
}

/** Canonical bytes of a published document — the immutability unit. */
export const publishedDocumentBytes = (published: PublishedDocument) => canonicalBytes(published)

/** SHA-256 over the canonical bytes. Stable across processes and runtimes. */
export const publishedDocumentHash = (published: PublishedDocument) => contentHash(published)

/**
 * Every string a publication carries, flattened.
 *
 * The privacy test walks this instead of grepping the JSON, so a leak inside a
 * nested field is caught by the same assertion as a leak at the top level.
 */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value)
    return into
  }
  if (value === null || typeof value !== 'object') return into
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into)
    return into
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    into.push(key)
    collectStrings(entry, into)
  }
  return into
}
