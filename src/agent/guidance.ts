import { nearestPlaceableNeighbour } from '../cad/snapping'
import { floatingPartIds } from '../cad/validation'
import type { ModelDocument } from '../cad/types'
import { classifySubject, type SubjectArchetype } from '../generation/brief'

/**
 * The next legal move, as a measured sentence.
 *
 * Tool results and the per-leg grounding block both carry this so a model that
 * just got a refusal — or that opened an empty document — does not have to
 * invent a plan. The kernel already knows whether the plate is empty, whether
 * something is colliding, and whether a part is hovering; this is that knowledge
 * turned into one instruction.
 */

export interface AgentSituation {
  readonly partCount: number
  readonly selectionCount: number
  readonly collisions: number
  readonly disconnectedParts: number
  readonly floatingParts: number
  readonly tipping: boolean | null
  readonly failureCode?: string | null
  readonly triedDefinitionId?: string
  readonly placeableAnchorId?: string
  /** True when this situation is already the result of repair_suggest. */
  readonly seenRepair?: boolean
  /** Hovering part the kernel measured. Copy this id; do not invent one. */
  readonly floatingPartId?: string
  /** Nearest part that can still receive a brick on top, from the hovering part. */
  readonly nearbyAnchorId?: string
  /** What the builder's last message asked for, per the brief compiler's own keywords. */
  readonly subject?: SubjectArchetype
  /** True when that message reads as "build me a whole X" rather than an edit. */
  readonly designRequest?: boolean
  /** True when a generated candidate is already staged and awaiting a human. */
  readonly generationPending?: boolean
}

/**
 * Whether the builder asked for a *thing* or for an *edit*.
 *
 * The keywords come from the brief compiler rather than from a second list
 * kept here, because a subject the compiler cannot classify is a subject
 * generation cannot mass, and the two answers drifting apart is how an agent
 * ends up compiling a brief for something it will then fail to build.
 *
 * "A blank plate" is the deliberate exception: it names no subject and it is
 * exactly what `build_field` is for.
 */
const WANTS_BLANK = /\b(baseplate|base plate|blank plate|empty plate|flat base|just a base|foundation only)\b/i

export function classifyRequest(text: string | null | undefined): {
  subject: SubjectArchetype
  designRequest: boolean
} {
  const source = (text ?? '').trim()
  if (!source) return { subject: 'unknown', designRequest: false }
  const { archetype } = classifySubject(source)
  return { subject: archetype, designRequest: archetype !== 'unknown' && !WANTS_BLANK.test(source) }
}

export interface AgentNextStep {
  readonly action: string
  readonly tool: string
  readonly why: string
  /** Arguments to pass to `tool` unchanged. The model must not invent extras. */
  readonly args?: Record<string, unknown>
}

/** Fill floating / nearby ids from the live document so nextArgs are copy-pasteable. */
export function situationFromLive(document: ModelDocument, extra: Partial<AgentSituation> & Pick<AgentSituation, 'selectionCount'>): AgentSituation {
  const floating = floatingPartIds(document)
  const floatingPartId = extra.floatingPartId ?? floating[0]
  return {
    partCount: extra.partCount ?? Object.keys(document.parts).length,
    selectionCount: extra.selectionCount,
    collisions: extra.collisions ?? 0,
    disconnectedParts: extra.disconnectedParts ?? 0,
    floatingParts: extra.floatingParts ?? floating.length,
    tipping: extra.tipping ?? null,
    failureCode: extra.failureCode,
    triedDefinitionId: extra.triedDefinitionId,
    placeableAnchorId: extra.placeableAnchorId,
    seenRepair: extra.seenRepair,
    floatingPartId,
    nearbyAnchorId:
      extra.nearbyAnchorId ?? (floatingPartId ? nearestPlaceableNeighbour(document, floatingPartId)?.id : undefined),
    subject: extra.subject,
    designRequest: extra.designRequest,
    generationPending: extra.generationPending,
  }
}

export function nextAgentAction(situation: AgentSituation): AgentNextStep {
  const code = situation.failureCode ?? ''

  // A staged candidate is somebody else's turn. Adding parts on top of one is
  // how a review of "here is your tower" turns into a review of "here is your
  // tower and a 2x4 the assistant put on it".
  if (situation.generationPending && !code) {
    return {
      tool: 'generation_state',
      why: 'generated',
      args: {},
      action:
        'A generated candidate is staged and waiting for the builder to accept or reject it. Read generation_state and tell them what is in it. Do not place parts on top of a wave under review.',
    }
  }

  if (situation.partCount === 0) {
    if (situation.designRequest) {
      const subject = situation.subject && situation.subject !== 'unknown' ? ` a ${situation.subject}` : ''
      return {
        tool: 'generation_compile',
        why: 'generate',
        args: {},
        action:
          `The document is empty and the builder asked for${subject || ' a whole model'}. Generate it: call generation_compile, settle any conflict it reports with generation_set, then generation_run and generation_preview. Do not lay it brick by brick — preflight_placement has no anchor here, and a model of this kind is hundreds of parts.`,
      }
    }
    return {
      tool: 'capability_search',
      why: 'empty',
      args: { query: 'build_field' },
      action:
        'The document is empty and no subject was named. Do not call preflight_placement — it needs an existing anchor part. Call capability_search with query "build_field", then preflight_capability with that schema.',
    }
  }

  if (code === 'STALE_DOCUMENT' || code === 'PROPOSAL_STALE') {
    return {
      tool: 'scene_overview',
      why: 'stale',
      args: {},
      action:
        'The plan is stale. Call scene_overview, then re-run the preflight against the revision it returns. Do not reuse the old wave id.',
    }
  }

  if (code === 'COLLISION' || situation.collisions > 0) {
    if (situation.seenRepair) {
      if (situation.placeableAnchorId && situation.triedDefinitionId) {
        return {
          tool: 'preflight_placement',
          why: 'collision',
          args: {
            definitionId: situation.triedDefinitionId,
            anchorPartId: situation.placeableAnchorId,
            approach: 'on-top',
          },
          action: `The previous placement collided. Call preflight_placement with definitionId ${situation.triedDefinitionId}, anchorPartId ${situation.placeableAnchorId}, approach on-top. Do not retry the same arguments.`,
        }
      }
      return {
        tool: 'scene_query',
        why: 'collision',
        args: { includeNeighbours: true },
        action:
          'The previous placement collided. Call scene_query with includeNeighbours, pick an anchor whose approaches.on-top is true, then preflight_placement on a different face or identity. Do not retry the same arguments.',
      }
    }
    return {
      tool: 'repair_suggest',
      why: 'collision',
      args: { failureCode: 'COLLISION' },
      action:
        'Call repair_suggest with failureCode COLLISION. Then preflight_placement against a different face or identity. Do not retry the same arguments.',
    }
  }

  if (code === 'DISCONNECTED' || situation.floatingParts > 0) {
    if (situation.floatingPartId && situation.nearbyAnchorId) {
      return {
        tool: 'preflight_capability',
        why: 'floating',
        args: {
          capability: 'connect_parts',
          args: { movingPartId: situation.floatingPartId, targetPartId: situation.nearbyAnchorId },
        },
        action: `A part is hovering with no clutch. Call preflight_capability with capability connect_parts, movingPartId ${situation.floatingPartId}, targetPartId ${situation.nearbyAnchorId}. That mates the hovering brick — do not add a new one. Never invent XYZ.`,
      }
    }
    return {
      tool: 'scene_query',
      why: 'floating',
      args: situation.floatingPartId
        ? { includeNeighbours: true, partIds: [situation.floatingPartId] }
        : { includeNeighbours: true },
      action: situation.floatingPartId
        ? `A part is hovering with no clutch. Call scene_query with includeNeighbours and partIds [${situation.floatingPartId}]. Read a nearby id whose approaches.on-top is true, then preflight_capability connect_parts with movingPartId ${situation.floatingPartId}. Never invent XYZ.`
        : 'A part is hovering with no clutch. Call scene_query with includeNeighbours, pick a nearby id you actually read, then preflight_capability connect_parts. Never invent XYZ.',
    }
  }

  if (code === 'CONNECTOR_OCCUPIED') {
    if (situation.placeableAnchorId && situation.triedDefinitionId) {
      return {
        tool: 'preflight_placement',
        why: 'occupied',
        args: {
          definitionId: situation.triedDefinitionId,
          anchorPartId: situation.placeableAnchorId,
          approach: 'on-top',
        },
        action: `Every exclusive connector on that face is occupied. Call preflight_placement with definitionId ${situation.triedDefinitionId}, anchorPartId ${situation.placeableAnchorId}, approach on-top. Do not retry the full face.`,
      }
    }
    return {
      tool: 'scene_query',
      why: 'occupied',
      args: { includeNeighbours: true },
      action:
        'Every exclusive connector on that face is occupied. Call scene_query with includeNeighbours and pick an anchor whose approaches.on-top is true. Do not retry the same face.',
    }
  }

  if (code === 'NO_COMPATIBLE_CONNECTOR') {
    if (situation.placeableAnchorId && situation.triedDefinitionId) {
      return {
        tool: 'preflight_placement',
        why: 'no-mate',
        args: {
          definitionId: situation.triedDefinitionId,
          anchorPartId: situation.placeableAnchorId,
          approach: 'on-top',
        },
        action: `That surface cannot clutch this part. Call preflight_placement with definitionId ${situation.triedDefinitionId}, anchorPartId ${situation.placeableAnchorId}, approach on-top. Do not retry the tile.`,
      }
    }
    return {
      tool: 'selection_geometry',
      why: 'no-mate',
      args: { reference: '@selection' },
      action:
        'Call selection_geometry on the anchor and read approaches and freeByFamily. If on-top is false that surface has no free studs — a tile cannot receive a brick. Pick a different anchor or identity, then preflight_placement on a face that is listed as free.',
    }
  }

  if (code === 'REPEAT_REFUSED') {
    return {
      tool: 'repair_suggest',
      why: 'repeat',
      args: { failureCode: 'REPEAT_REFUSED' },
      action:
        'Those exact arguments were already refused. Call repair_suggest with the earlier failureCode, then change the identity, face, or anchor. Do not retry the same call.',
    }
  }

  if (code === 'PROTECTED_REGION') {
    return {
      tool: 'scene_overview',
      why: 'protected',
      args: {},
      action:
        'That region is locked. Call scene_overview, pick an unlocked assembly, and preflight against parts that are not protected.',
    }
  }

  if (situation.tipping === true) {
    return {
      tool: 'capability_search',
      why: 'tipping',
      args: { query: 'support' },
      action:
        'The model tips. Call capability_search with query "support", or preflight_placement to add a brick under the overhang so the centre of mass sits over the footprint.',
    }
  }

  if (situation.disconnectedParts > 0) {
    return {
      tool: 'scene_query',
      why: 'islands',
      args: { includeNeighbours: true },
      action:
        'Call scene_query with includeNeighbours to see the islands. Separate buildings on the ground are legal; hovering parts are not. Mate any floating part with preflight_capability connect_parts.',
    }
  }

  if (situation.selectionCount === 0) {
    return {
      tool: 'scene_query',
      why: 'no-selection',
      args: { includeNeighbours: true },
      action:
        'Call scene_query with includeNeighbours, then preflight_placement or preflight_capability using ids you actually read. Never invent part ids or coordinates.',
    }
  }

  return {
    tool: 'selection_geometry',
    why: 'ready',
    args: { reference: '@selection' },
    action:
      'Call selection_geometry with reference "@selection", then capability_search or preflight_placement using those measured ids and faces. Never invent coordinates or ids.',
  }
}
