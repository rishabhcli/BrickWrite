import { getPartBounds } from '../cad/geometry'
import { connectedComponent } from '../cad/validation'
import { STUD_LDU } from '../cad/catalog'
import type { ModelDocument, Vec3 } from '../cad/types'

/**
 * Spatial reference resolution.
 *
 * "Make that bit taller" is the normal way a person talks about a model, and it
 * is unanswerable without a shared idea of what "that" is. A reference token is
 * that shared idea made explicit: the operator writes or clicks one, it resolves
 * to concrete entity ids at a known revision, and both the transcript and the
 * model see the same resolution.
 *
 * Resolution is against the live document and it can fail. A token naming a
 * part that has since been deleted comes back unresolved with a reason, which
 * is what stops a stale chip from silently addressing the wrong bricks — or
 * from letting an invented id through to the kernel.
 */

export type ReferenceKind = 'selection' | 'part' | 'subassembly' | 'note' | 'view' | 'pin' | 'attachment'

export interface ViewportPin {
  id: string
  label: string
  /** Part ids the operator pinned. Verified against the document on resolve. */
  partIds: string[]
}

export interface ReferenceContext {
  document: ModelDocument
  selection: readonly string[]
  pins?: readonly ViewportPin[]
  /** Named camera view the operator is looking at, when one is active. */
  view?: string
}

export interface SpatialReference {
  /** The literal token, e.g. "@part:part_0007". Stable across resolutions. */
  token: string
  kind: ReferenceKind
  /** The id inside the token, when the kind carries one. */
  targetId: string | null
  /** What a person should see on the chip. */
  label: string
  /** Concrete part ids that exist at `revision`. Empty when unresolved. */
  partIds: string[]
  resolved: boolean
  /** Why it did not resolve. Present only when `resolved` is false. */
  problem?: string
  /** Document revision the resolution was taken at. */
  revision: number
}

const TOKEN_PATTERN = /@(selection|view|part|subassembly|note|pin)(?::([A-Za-z0-9_\-.]+))?/g

export interface ParsedToken {
  token: string
  kind: ReferenceKind
  targetId: string | null
  start: number
  end: number
}

/** Extracts reference tokens from free text, left to right, without resolving. */
export function parseReferenceTokens(text: string): ParsedToken[] {
  const found: ParsedToken[] = []
  TOKEN_PATTERN.lastIndex = 0
  for (let match = TOKEN_PATTERN.exec(text); match; match = TOKEN_PATTERN.exec(text)) {
    const [token, kind, targetId] = match
    // A bare "@part" with no id is a typo, not a reference to every part.
    if ((kind === 'part' || kind === 'subassembly' || kind === 'note' || kind === 'pin') && !targetId) continue
    found.push({
      token,
      kind: kind as ReferenceKind,
      targetId: targetId ?? null,
      start: match.index,
      end: match.index + token.length,
    })
  }
  return found
}

const unresolved = (
  token: ParsedToken,
  revision: number,
  problem: string,
  label = token.token,
): SpatialReference => ({
  token: token.token,
  kind: token.kind,
  targetId: token.targetId,
  label,
  partIds: [],
  resolved: false,
  problem,
  revision,
})

/** Resolves one parsed token against the live document. */
export function resolveReference(token: ParsedToken, context: ReferenceContext): SpatialReference {
  const { document } = context
  const revision = document.revision

  switch (token.kind) {
    case 'selection': {
      const partIds = context.selection.filter((id) => Boolean(document.parts[id]))
      if (!partIds.length) {
        return unresolved(token, revision, 'Nothing is selected in the editor.', 'Selection')
      }
      return {
        token: token.token,
        kind: 'selection',
        targetId: null,
        label: `Selection · ${partIds.length} part${partIds.length === 1 ? '' : 's'}`,
        partIds,
        resolved: true,
        revision,
      }
    }

    case 'part': {
      const part = token.targetId ? document.parts[token.targetId] : undefined
      if (!part) {
        return unresolved(
          token,
          revision,
          `No part ${token.targetId} exists at revision ${revision}.`,
          token.targetId ?? 'part',
        )
      }
      return {
        token: token.token,
        kind: 'part',
        targetId: part.id,
        label: `${part.definitionId} · ${part.id}`,
        partIds: [part.id],
        resolved: true,
        revision,
      }
    }

    case 'subassembly': {
      const subassembly = token.targetId ? document.subassemblies[token.targetId] : undefined
      if (!subassembly) {
        return unresolved(
          token,
          revision,
          `No assembly ${token.targetId} exists at revision ${revision}.`,
          token.targetId ?? 'assembly',
        )
      }
      const partIds = subassembly.partIds.filter((id) => Boolean(document.parts[id]))
      return {
        token: token.token,
        kind: 'subassembly',
        targetId: subassembly.id,
        label: `${subassembly.name}${subassembly.locked ? ' · locked' : ''} · ${partIds.length} part${partIds.length === 1 ? '' : 's'}`,
        partIds,
        resolved: true,
        revision,
      }
    }

    case 'note': {
      const note = document.notes.find((candidate) => candidate.id === token.targetId)
      if (!note) {
        return unresolved(token, revision, `No builder note ${token.targetId} exists.`, token.targetId ?? 'note')
      }
      const partIds = note.anchorPartIds.filter((id) => Boolean(document.parts[id]))
      return {
        token: token.token,
        kind: 'note',
        targetId: note.id,
        label: `Note · ${note.text.slice(0, 48)}${note.text.length > 48 ? '…' : ''}`,
        partIds,
        resolved: true,
        revision,
      }
    }

    case 'pin': {
      const pin = context.pins?.find((candidate) => candidate.id === token.targetId)
      if (!pin) {
        return unresolved(token, revision, `No viewport pin ${token.targetId} is set.`, token.targetId ?? 'pin')
      }
      const partIds = pin.partIds.filter((id) => Boolean(document.parts[id]))
      if (!partIds.length) {
        return unresolved(
          token,
          revision,
          `Pin "${pin.label}" points at parts that no longer exist at revision ${revision}.`,
          pin.label,
        )
      }
      return {
        token: token.token,
        kind: 'pin',
        targetId: pin.id,
        label: `Pin · ${pin.label} · ${partIds.length} part${partIds.length === 1 ? '' : 's'}`,
        partIds,
        resolved: true,
        revision,
      }
    }

    case 'view': {
      const partIds = Object.keys(document.parts)
      return {
        token: token.token,
        kind: 'view',
        targetId: context.view ?? null,
        label: `View · ${context.view ?? 'current camera'} · ${partIds.length} part${partIds.length === 1 ? '' : 's'}`,
        partIds,
        // A view of an empty document is still a legitimate answer to "what am
        // I looking at": nothing. That is resolved, not broken.
        resolved: true,
        revision,
      }
    }

    default:
      return unresolved(token, revision, `Unknown reference kind "${token.kind}".`)
  }
}

export interface ResolvedMessageReferences {
  references: SpatialReference[]
  /** Every existing part id the message addresses, de-duplicated. */
  partIds: string[]
  /** True when at least one token failed to resolve. */
  hasUnresolved: boolean
}

/**
 * Resolves every token in a message plus any chips attached through the UI.
 *
 * Attached references are re-resolved rather than trusted: a chip added three
 * revisions ago may name a part the builder has since deleted, and sending its
 * cached id list to the model would be exactly the fabricated identity the
 * kernel is meant to refuse.
 */
export function resolveMessageReferences(
  text: string,
  context: ReferenceContext,
  attached: readonly SpatialReference[] = [],
): ResolvedMessageReferences {
  const seen = new Set<string>()
  const references: SpatialReference[] = []

  const push = (reference: SpatialReference) => {
    if (seen.has(reference.token)) return
    seen.add(reference.token)
    references.push(reference)
  }

  for (const attachment of attached) {
    const parsed = parseReferenceTokens(attachment.token)[0]
    push(parsed ? resolveReference(parsed, context) : { ...attachment, revision: context.document.revision })
  }
  for (const token of parseReferenceTokens(text)) push(resolveReference(token, context))

  const partIds = [...new Set(references.flatMap((reference) => reference.partIds))]
  return { references, partIds, hasUnresolved: references.some((reference) => !reference.resolved) }
}

export interface ReferenceScope {
  partIds: string[]
  /** Bounds in LDraw units of the measured parts in scope. */
  boundsLdu: { min: Vec3; max: Vec3; size: Vec3 } | null
  sizeStuds: [number, number, number] | null
  /** Parts physically connected to the scope but outside it. */
  neighbourPartIds: string[]
  protectedPartIds: string[]
  lockedSubassemblyIds: string[]
}

/**
 * Everything the planner needs about a scope, measured from the kernel.
 *
 * Neighbours come from the persisted connection graph rather than from a
 * proximity guess, so "what is this attached to" answers with the edges the
 * kernel actually recorded.
 */
export function describeScope(document: ModelDocument, partIds: readonly string[]): ReferenceScope {
  const present = partIds.filter((id) => Boolean(document.parts[id]))
  const measured = present.map((id) => getPartBounds(document.parts[id])).filter((bounds) => bounds.measured)

  const boundsLdu = measured.length
    ? {
        min: [
          Math.min(...measured.map((item) => item.min[0])),
          Math.min(...measured.map((item) => item.min[1])),
          Math.min(...measured.map((item) => item.min[2])),
        ] as Vec3,
        max: [
          Math.max(...measured.map((item) => item.max[0])),
          Math.max(...measured.map((item) => item.max[1])),
          Math.max(...measured.map((item) => item.max[2])),
        ] as Vec3,
        size: [0, 0, 0] as Vec3,
      }
    : null
  if (boundsLdu) {
    boundsLdu.size = [
      boundsLdu.max[0] - boundsLdu.min[0],
      boundsLdu.max[1] - boundsLdu.min[1],
      boundsLdu.max[2] - boundsLdu.min[2],
    ]
  }

  const scope = new Set(present)
  const neighbourPartIds: string[] = []
  for (const edge of Object.values(document.connections ?? {})) {
    if (scope.has(edge.a.partId) && !scope.has(edge.b.partId)) neighbourPartIds.push(edge.b.partId)
    if (scope.has(edge.b.partId) && !scope.has(edge.a.partId)) neighbourPartIds.push(edge.a.partId)
  }

  return {
    partIds: present,
    boundsLdu,
    sizeStuds: boundsLdu
      ? [
          Math.round((boundsLdu.size[0] / STUD_LDU) * 100) / 100,
          Math.round((boundsLdu.size[1] / STUD_LDU) * 100) / 100,
          Math.round((boundsLdu.size[2] / STUD_LDU) * 100) / 100,
        ]
      : null,
    neighbourPartIds: [...new Set(neighbourPartIds)],
    protectedPartIds: present.filter((id) => document.parts[id]?.protected),
    lockedSubassemblyIds: [
      ...new Set(
        present
          .map((id) => document.parts[id].subassemblyId)
          .filter((subassemblyId) => document.subassemblies[subassemblyId]?.locked),
      ),
    ],
  }
}

/** The whole rigid island around a scope, for "and everything attached to it". */
export function expandToConnectedIsland(document: ModelDocument, partIds: readonly string[]): string[] {
  return connectedComponent(document, partIds)
}
