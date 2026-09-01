import { catalog, STUD_LDU, describeSize, originForSurface, surfaceAbove } from '../cad/catalog'
import { externalCatalogueAvailable, loadExternalCatalogue } from '../cad/catalog-loader'
import {
  SHARED_CAPABILITIES,
  SharedCapabilityError,
  planSharedMutation,
  sharedCapability,
  type SharedMutationId,
} from '../cad/capabilities'
import { cadEngine } from '../cad/engine'
import { getPartBounds, nearbyParts } from '../cad/geometry'
import { createId } from '../cad/ids'
import { basisFromEulerDegrees, IDENTITY_BASIS } from '../cad/math'
import { documentModules, findModule } from '../cad/modules'
import { poseMatchesApproach, searchMateOnTarget } from '../cad/placement'
import { frameScene, renderScene, rgbFromHex, type RasterImage, type RasterPart } from '../cad/raster'
import { connectorAvailability, connectorAvailabilityByPart, openApproachNames, approachOccupancy, placeableAnchors } from '../cad/snapping'
import { findWeakAttachments, floatingPartIds, validateDocument } from '../cad/validation'
import { analyseStatics } from '../cad/statics'
import type { ModelDocument, PartInstance, Vec3, ConnectionFamily } from '../cad/types'
import { capabilityJsonSchema, parseCapabilityArgs } from './schemas'
import { describeScope, parseReferenceTokens, resolveReference, type ViewportPin } from './references'
import type { WaveLedger } from './modes'
import type { TraceLedger } from './trace'
import { ASSISTANT_TOOLS, type AssistantToolDeclaration } from './toolschemas'
import { classifyRequest, nextAgentAction, situationFromLive, type AgentSituation } from './guidance'
import type { ToolCall, ToolResult } from './protocol'

/**
 * Tool execution, in the browser, against the live kernel.
 *
 * The model loop runs in the API process because that is where the key lives;
 * the tools run here because this is where the document lives. Nothing else
 * would work: a server-side executor would have to be handed a serialized copy
 * of the model on every call, and the copy would be stale the moment a person
 * dragged a brick.
 *
 * The important property of this file is the order of operations. Arguments are
 * parsed against the same Zod schema the model was shown, then every identity
 * in them is checked against the live document, and only then does anything
 * reach `planSharedMutation` or `commandBus`. A part id the model invented is
 * refused here, by name, with the revision it was checked at — the kernel never
 * sees it.
 */

export interface ToolMesh {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly slices: ReadonlyArray<{ colour: number; start: number; count: number }>
}

export interface ToolHostOptions {
  waves: WaveLedger
  trace?: TraceLedger
  pins?: readonly ViewportPin[]
  view?: string
  /** Compiled geometry, when the renderer has it resident. */
  geometry?: (definitionId: string) => ToolMesh | null
  /** Turns a rendered buffer into a data URL. */
  encode?: (image: RasterImage) => string
  /** The live viewport canvas, when the renderer has published one. */
  canvas?: () => HTMLCanvasElement | undefined
  /**
   * The builder's most recent message.
   *
   * Read only to answer one question: did they ask for a *thing* or for an
   * *edit*? On an empty document those two want completely different tools, and
   * the kernel cannot tell them apart from the document alone — an empty plate
   * looks the same whether the next sentence was "build me a harbour tower" or
   * "give me a baseplate".
   */
  requestText?: () => string | null | undefined
}

export interface ToolFailure {
  code: string
  message: string
  repair: string
  details?: unknown
}

const fail = (code: string, message: string, repair: string, details?: unknown): { error: ToolFailure } => ({
  error: { code, message, repair, ...(details === undefined ? {} : { details }) },
})

/**
 * The generation pipeline, loaded on first use.
 *
 * Imported dynamically for the same reason the WebMCP gateway does it: the
 * pipeline, its scorer and its silhouette rasteriser are a large chunk that a
 * conversation which only reads the scene should never pay for. It is also why
 * this file does not reach into `src/webmcp/**` — the two agent surfaces share
 * `src/generation/host.ts`, not each other.
 */
const generationModule = () => import('../generation/host')

const CAMERA_VIEWS = ['isometric', 'front', 'rear', 'left', 'right', 'top'] as const

// ---------------------------------------------------------------------------
// Identity verification
// ---------------------------------------------------------------------------

/** Argument keys that name something that must already exist. */
const ID_FIELDS = {
  parts: ['movingPartId', 'targetPartId', 'anchorPartId'] as const,
  partArrays: ['partIds'] as const,
  subassemblies: ['subassemblyId'] as const,
  notes: ['noteId'] as const,
  constraints: ['constraintId'] as const,
  modules: ['module'] as const,
  edges: ['edgeId'] as const,
}

/**
 * Refuses an invented identity before the kernel is touched.
 *
 * The kernel would refuse most of these too, but not all of them and not always
 * with a message that names the field. More importantly, being refused here
 * means the failure is attributable: the tool trace records that the model
 * named something that does not exist, at a revision, rather than recording a
 * generic planning error.
 */
export function verifyIdentities(args: Record<string, unknown>, document: ModelDocument): ToolFailure | null {
  const revision = document.revision

  for (const field of ID_FIELDS.partArrays) {
    const value = args[field]
    if (!Array.isArray(value)) continue
    const missing = value.map(String).filter((id) => !document.parts[id])
    if (missing.length) {
      return {
        code: 'PART_NOT_FOUND',
        message: `${field} names ${missing.length} part${missing.length === 1 ? '' : 's'} that do not exist at revision ${revision}: ${missing.slice(0, 5).join(', ')}.`,
        repair: 'Call scene_query and use ids from its results. Do not construct part ids.',
        details: { missing, revision },
      }
    }
  }

  for (const field of ID_FIELDS.parts) {
    const value = args[field]
    if (typeof value !== 'string' || !value) continue
    if (!document.parts[value]) {
      return {
        code: 'PART_NOT_FOUND',
        message: `${field} "${value}" does not exist at revision ${revision}.`,
        repair: 'Call scene_query and use an id from its results. Do not construct part ids.',
        details: { field, value, revision },
      }
    }
  }

  for (const field of ID_FIELDS.subassemblies) {
    const value = args[field]
    if (typeof value !== 'string' || !value) continue
    if (!document.subassemblies[value]) {
      return {
        code: 'INVALID_OPERATION',
        message: `${field} "${value}" is not an assembly in this document at revision ${revision}.`,
        repair: `Known assemblies: ${Object.keys(document.subassemblies).join(', ') || 'none'}.`,
        details: { field, value, revision },
      }
    }
  }

  for (const field of ID_FIELDS.notes) {
    const value = args[field]
    if (typeof value !== 'string' || !value) continue
    if (!document.notes.some((note) => note.id === value)) {
      return {
        code: 'INVALID_OPERATION',
        message: `${field} "${value}" is not a builder note in this document.`,
        repair: 'Call notes_read and use an id from its results.',
        details: { field, value, revision },
      }
    }
  }

  for (const field of ID_FIELDS.constraints) {
    const value = args[field]
    if (typeof value !== 'string' || !value) continue
    if (!document.constraints.some((constraint) => constraint.id === value)) {
      return {
        code: 'INVALID_OPERATION',
        message: `${field} "${value}" is not a design constraint in this document.`,
        repair: `Known constraints: ${document.constraints.map((constraint) => constraint.id).join(', ') || 'none'}.`,
        details: { field, value, revision },
      }
    }
  }

  for (const field of ID_FIELDS.modules) {
    const value = args[field]
    if (typeof value !== 'string' || !value) continue
    if (!findModule(document, value)) {
      const available = documentModules(document).map((entry) => entry.name)
      return {
        code: 'INVALID_OPERATION',
        message: `No module "${value}" is captured in this document.`,
        repair: available.length ? `Captured modules: ${available.join(', ')}.` : 'Capture one first with capture_module.',
        details: { field, value, available },
      }
    }
  }

  for (const field of ID_FIELDS.edges) {
    const value = args[field]
    if (typeof value !== 'string' || !value) continue
    if (!(document.connections ?? {})[value]) {
      return {
        code: 'INVALID_OPERATION',
        message: `${field} "${value}" is not a connection in this document at revision ${revision}.`,
        repair: 'Call capability_search for list_joints and use an edge id it returns.',
        details: { field, value, revision },
      }
    }
  }

  return null
}

/** Refuses a catalog identity this build cannot place. */
export function verifyDefinition(definitionId: string): ToolFailure | null {
  const definition = catalog.get(definitionId)
  if (definition) {
    if (definition.geometryStatus === 'missing' || definition.geometryStatus === 'uncompiled') {
      return {
        code: 'GEOMETRY_UNAVAILABLE',
        message: `Part ${definitionId} is a real identity but this build carries no compiled geometry for it, so it cannot be placed.`,
        repair: 'Search catalog_search with requireGeometry:true and choose a placeable alternative.',
      }
    }
    return null
  }
  const identity = catalog.describe(definitionId)
  return identity
    ? {
        code: 'GEOMETRY_UNAVAILABLE',
        message: `Part ${definitionId} ("${identity.name}") is catalogued at tier "${identity.tier}" and has no geometry in this build.`,
        repair: 'Choose a placeable identity from catalog_search.',
      }
    : {
        code: 'PART_DEFINITION_NOT_FOUND',
        message: `There is no catalog identity "${definitionId}". Part identities come from catalog_search, never from memory.`,
        repair: 'Call catalog_search and use an id it returned.',
      }
}

// ---------------------------------------------------------------------------
// Tool host
// ---------------------------------------------------------------------------

export interface ToolHost {
  readonly declarations: readonly AssistantToolDeclaration[]
  execute(call: ToolCall): Promise<ToolResult>
}

export function createToolHost(options: ToolHostOptions): ToolHost {
  const declarations = ASSISTANT_TOOLS
  let lastFailedPreflight: string | null = null

  const liveNext = (extra: Partial<AgentSituation> = {}) => {
    const state = cadEngine.getSnapshot()
    const request = classifyRequest(options.requestText?.())
    return nextAgentAction(
      situationFromLive(state.document, {
        partCount: state.validation.partCount,
        selectionCount: state.selection.length,
        collisions: state.validation.collisions.length,
        disconnectedParts: state.validation.disconnectedPartIds.length,
        subject: request.subject,
        designRequest: request.designRequest,
        generationPending: options.waves
          .pending()
          .some((wave) => wave.capability === 'generate_from_brief' || wave.capability === 'generate_region'),
        ...extra,
      }),
    )
  }

  const runners: Record<string, (input: Record<string, unknown>) => unknown | Promise<unknown>> = {
    scene_overview: () => {
      const state = cadEngine.getSnapshot()
      const validation = state.validation
      const statics = analyseStatics(state.document)
      const floating = floatingPartIds(state.document)
      const next = liveNext({ tipping: statics.support ? statics.support.marginLdu < 0 : null })
      return {
        documentRevision: state.document.revision,
        documentName: state.document.name,
        catalogVersion: catalog.version,
        autonomy: state.autonomy,
        partCount: validation.partCount,
        selection: state.selection,
        boundsLdu: validation.bounds,
        boundsStuds: validation.bounds.size.map((value) => Math.round((value / STUD_LDU) * 100) / 100),
        subassemblies: Object.values(state.document.subassemblies).map((item) => ({
          id: item.id,
          name: item.name,
          partCount: item.partIds.length,
          locked: item.locked,
        })),
        constraints: validation.constraints,
        modules: documentModules(state.document).map((module) => ({
          id: module.id,
          name: module.name,
          parts: module.parts.length,
          sizeLdu: module.sizeLdu,
        })),
        steps: state.document.steps.map((step) => ({ id: step.id, index: step.index, name: step.name, parts: step.partIds.length })),
        validation: {
          healthy: validation.healthy,
          collisions: validation.collisions.length,
          unverifiedCollisions: validation.unverifiedCollisions,
          components: validation.componentCount,
          disconnectedParts: validation.disconnectedPartIds.length,
          floatingParts: floating.length,
          virtualColors: validation.virtualColors.length,
        },
        statics: {
          massGrams: Math.round(statics.mass.grams * 10) / 10,
          supportMarginLdu: statics.support ? Math.round(statics.support.marginLdu * 10) / 10 : null,
          stable: statics.support?.stable ?? null,
          overloadedJoints: statics.overloaded.length,
          unsupportedParts: statics.unsupportedPartIds.length,
        },
        nextAction: next.action,
        nextTool: next.tool,
        nextArgs: next.args ?? {},
        placeableAnchors: placeableAnchors(state.document),
        catalogTiers: {
          placeable: catalog.placeableCount,
          modelled: catalog.identityCount,
          totalIdentities: catalog.totalIdentityCount,
        },
      }
    },

    scene_query: (input) => {
      const state = cadEngine.getSnapshot()
      const document = state.document
      let parts = Object.values(document.parts)
      if (typeof input.subassemblyId === 'string') parts = parts.filter((part) => part.subassemblyId === input.subassemblyId)
      if (typeof input.definitionId === 'string') parts = parts.filter((part) => part.definitionId === input.definitionId)
      if (Array.isArray(input.partIds)) {
        const ids = new Set(input.partIds.map(String))
        parts = parts.filter((part) => ids.has(part.id))
      }
      if (input.selectionOnly === true) {
        const ids = new Set(state.selection)
        parts = parts.filter((part) => ids.has(part.id))
      }
      const limit = typeof input.limit === 'number' ? input.limit : 60
      const total = parts.length
      const page = parts.slice(0, limit)

      const neighbours = new Map<string, string[]>()
      if (input.includeNeighbours === true) {
        for (const edge of Object.values(document.connections ?? {})) {
          neighbours.set(edge.a.partId, [...(neighbours.get(edge.a.partId) ?? []), edge.b.partId])
          neighbours.set(edge.b.partId, [...(neighbours.get(edge.b.partId) ?? []), edge.a.partId])
        }
      }

      const availabilityIds = new Set(page.map((part) => part.id))
      const nearbyByPart = new Map<string, ReturnType<typeof nearbyParts>>()
      if (input.includeNeighbours === true) {
        for (const part of page) {
          const near = nearbyParts(document, part.id, 4)
          nearbyByPart.set(part.id, near)
          for (const neighbour of near) availabilityIds.add(neighbour.id)
        }
      }

      const availability = connectorAvailabilityByPart(document, [...availabilityIds])

      return {
        documentRevision: document.revision,
        matched: total,
        returned: page.length,
        truncated: total > page.length,
        parts: page.map((part) => {
          const definition = catalog.get(part.definitionId)
          const connectors = availability[part.id]
          const near = nearbyByPart.get(part.id) ?? []
          return {
            id: part.id,
            definitionId: part.definitionId,
            name: definition?.name ?? null,
            size: describeSize(definition),
            color: part.color,
            colorName: catalog.hasColor(part.color) ? catalog.color(part.color).name : null,
            subassemblyId: part.subassemblyId,
            stepId: part.stepId,
            provenance: part.provenance,
            protected: part.protected || Boolean(document.subassemblies[part.subassemblyId]?.locked),
            positionLdu: part.transform.position,
            approaches: connectors?.approaches ?? { 'on-top': false, underneath: false, beside: false },
            occupiedExclusive: connectors?.occupiedExclusive ?? 0,
            ...(input.includeNeighbours === true
              ? {
                  connectedTo: [...new Set(neighbours.get(part.id) ?? [])],
                  nearby: near.map((entry) => ({
                    id: entry.id,
                    distanceLdu: Math.round(entry.distanceLdu * 10) / 10,
                    approaches: availability[entry.id]?.approaches ?? { 'on-top': false, underneath: false, beside: false },
                  })),
                }
              : {}),
          }
        }),
      }
    },

    selection_geometry: (input) => {
      const state = cadEngine.getSnapshot()
      const document = state.document
      const token = typeof input.reference === 'string' ? input.reference : '@selection'
      const parsed = parseReferenceTokens(token)[0]

      let partIds: string[]
      let label: string
      if (parsed) {
        const reference = resolveReference(parsed, {
          document,
          selection: state.selection,
          pins: options.pins,
          view: options.view,
        })
        if (!reference.resolved) {
          return fail('PART_NOT_FOUND', reference.problem ?? `Reference ${token} did not resolve.`, 'Use @selection, or an id from scene_query.')
        }
        partIds = reference.partIds
        label = reference.label
      } else if (document.parts[token]) {
        partIds = [token]
        label = `${document.parts[token].definitionId} · ${token}`
      } else {
        return fail(
          'PART_NOT_FOUND',
          `"${token}" is neither a reference token nor a part id at revision ${document.revision}.`,
          'Pass "@selection", "@part:<id>", "@subassembly:<id>" or a part id from scene_query.',
        )
      }

      const scope = describeScope(document, partIds)
      const topPlane = scope.boundsLdu ? scope.boundsLdu.min[1] : null
      const atTopPlane = scope.boundsLdu
        ? scope.partIds.filter((id) => Math.abs(getPartBounds(document.parts[id]).min[1] - scope.boundsLdu!.min[1]) < 1e-6)
        : []

      const focusId = scope.partIds[0]
      const near = focusId ? nearbyParts(document, focusId, 6) : []
      const availabilityIds = [...new Set([...scope.partIds, ...near.map((entry) => entry.id)])]
      const nearbyAvailability = connectorAvailabilityByPart(document, availabilityIds)

      return {
        documentRevision: document.revision,
        reference: token,
        label,
        partCount: scope.partIds.length,
        partIds: scope.partIds.slice(0, 100),
        boundsLdu: scope.boundsLdu,
        sizeStuds: scope.sizeStuds,
        // LDraw is Y-down, so the smallest y is the highest surface: this is
        // where another course would seat.
        topMatingPlaneLdu: topPlane,
        partsAtTopPlane: atTopPlane.slice(0, 40),
        neighbourPartIds: scope.neighbourPartIds.slice(0, 60),
        nearby: near.map((entry) => ({
          id: entry.id,
          distanceLdu: Math.round(entry.distanceLdu * 10) / 10,
          approaches: nearbyAvailability[entry.id]?.approaches ?? { 'on-top': false, underneath: false, beside: false },
        })),
        protectedPartIds: scope.protectedPartIds,
        lockedSubassemblyIds: scope.lockedSubassemblyIds,
        connectors: connectorAvailability(document, scope.partIds),
        note:
          scope.protectedPartIds.length || scope.lockedSubassemblyIds.length
            ? 'Some parts in this scope are protected; the kernel will refuse edits that touch them.'
            : 'Use connectors.approaches to pick a face. on-top is false when there are no free studs. nearby ids have no graph edge — copy one whose approaches.on-top is true into connect_parts.',
      }
    },

    catalog_search: async (input) => {
      const tier = (input.tier as string | undefined) ?? 'all'
      if ((tier === 'catalogued' || tier === 'all') && externalCatalogueAvailable()) {
        await loadExternalCatalogue().catch(() => undefined)
      }
      const page = catalog.searchPage({
        text: input.text as string | undefined,
        category: input.category as string | undefined,
        connectorTypes: input.connectorTypes as never,
        requireGeometry: input.requireGeometry as boolean | undefined,
        tier: tier as never,
        limit: (input.limit as number | undefined) ?? 12,
      })
      return {
        catalogVersion: catalog.version,
        matched: page.total,
        byTier: page.tiers,
        cataloguedTierSearched: !page.cataloguePending,
        results: page.records.map((record) => ({
          id: record.id,
          name: record.name,
          category: record.category,
          tier: record.tier,
          studs: record.dimensions,
          placeable: record.geometryAvailable,
          connectorFamilies: record.connectorFamilies,
          setAppearances: record.frequency,
        })),
        note: 'Only results with placeable:true can be built with. Say so plainly when the requested part is not one.',
      }
    },

    capability_search: (input) => {
      const exact = typeof input.capability === 'string' ? input.capability : null
      if (exact) {
        const definition = sharedCapability(exact)
        if (!definition) {
          return fail(
            'INVALID_OPERATION',
            `There is no capability "${exact}".`,
            'Call capability_search with a task-oriented query instead.',
          )
        }
        return {
          id: definition.id,
          kind: definition.kind,
          group: definition.group,
          title: definition.title,
          summary: definition.summary,
          call: definition.kind === 'mutate' ? 'preflight_capability' : 'not directly callable — reads are exposed as dedicated tools',
          // The schema the gateway enforces, not a prose restatement of it.
          argumentSchema: capabilityJsonSchema(definition.id),
        }
      }
      const query = String(input.query ?? '').toLowerCase()
      const matches = SHARED_CAPABILITIES.filter((capability) =>
        `${capability.id} ${capability.title} ${capability.summary} ${capability.group}`.toLowerCase().includes(query),
      )
      return {
        query,
        matched: matches.length,
        capabilities: matches.slice(0, 25).map((capability) => ({
          id: capability.id,
          kind: capability.kind,
          group: capability.group,
          title: capability.title,
          summary: capability.summary,
        })),
        note: 'Call this again with `capability` set to get the exact argument schema before preflighting.',
      }
    },

    notes_read: (input) => {
      const document = cadEngine.getSnapshot().document
      const status = (input.status as string | undefined) ?? 'open'
      return {
        documentRevision: document.revision,
        notes: document.notes
          .filter((note) => status === 'all' || note.status === status)
          .map((note) => ({
            id: note.id,
            text: note.text,
            author: note.author,
            status: note.status,
            revisionCreated: note.revisionCreated,
            anchorPartIds: note.anchorPartIds,
            response: note.response ?? null,
          })),
      }
    },

    render_capture: (input) => {
      const state = cadEngine.getSnapshot()
      const view = (input.view as string | undefined) ?? 'isometric'
      if (!CAMERA_VIEWS.includes(view as (typeof CAMERA_VIEWS)[number])) {
        return fail('INVALID_INPUT', `Unknown view "${view}".`, `Use one of: ${CAMERA_VIEWS.join(', ')}.`)
      }
      const width = (input.width as number | undefined) ?? 512
      const height = (input.height as number | undefined) ?? 384
      const bounds = state.validation.bounds
      const framing = frameScene(bounds, width, height, { supersample: 1 })

      const metadata = {
        documentRevision: state.document.revision,
        view,
        width,
        height,
        visibleParts: state.validation.partCount,
        boundsLdu: bounds,
        boundsStuds: bounds.size.map((value) => Math.round((value / STUD_LDU) * 100) / 100),
        projectedScale: Math.round(framing.scale * 1000) / 1000,
        selection: state.selection,
      }

      // A real render when the compiled meshes are resident, so coverage is a
      // measurement rather than a claim that something was drawn.
      if (options.geometry) {
        const parts: RasterPart[] = []
        for (const part of Object.values(state.document.parts)) {
          const mesh = options.geometry(part.definitionId)
          if (!mesh) continue
          parts.push({
            positions: mesh.positions,
            indices: mesh.indices,
            slices: mesh.slices,
            transform: part.transform,
            rgb: rgbFromHex(catalog.color(part.color).hex),
            isNew: false,
          })
        }
        if (parts.length) {
          const image = renderScene(parts, framing)
          return {
            ...metadata,
            renderedParts: parts.length,
            coverage: Math.round(image.coverage * 1000) / 1000,
            ...(options.encode ? { imageDataUrl: options.encode(image) } : {}),
            pixelsAvailable: Boolean(options.encode),
            ...(options.encode ? {} : { pixelsUnavailableReason: 'No image encoder is wired into this workbench.' }),
          }
        }
      }

      const canvas = options.canvas?.()
      if (canvas) {
        try {
          const dataUrl = canvas.toDataURL('image/png')
          return { ...metadata, pixelsAvailable: true, imageDataUrl: dataUrl, source: 'live viewport' }
        } catch (cause) {
          return {
            ...metadata,
            pixelsAvailable: false,
            pixelsUnavailableReason: `The viewport canvas refused to encode: ${String((cause as Error).message ?? cause)}`,
          }
        }
      }

      return {
        ...metadata,
        pixelsAvailable: false,
        pixelsUnavailableReason:
          'No compiled geometry and no live viewport are available in this session, so no image exists. The measurements above are still exact.',
      }
    },

    validate_model: () => {
      const state = cadEngine.getSnapshot()
      const validation = state.validation
      const statics = analyseStatics(state.document)
      const floating = floatingPartIds(state.document)
      const next = liveNext({ tipping: statics.support ? statics.support.marginLdu < 0 : null })
      return {
        documentRevision: state.document.revision,
        healthy: validation.healthy,
        partCount: validation.partCount,
        connectionCount: validation.connectionCount,
        componentCount: validation.componentCount,
        disconnectedPartIds: validation.disconnectedPartIds.slice(0, 40),
        floatingPartIds: floating.slice(0, 40),
        collisions: validation.collisions.slice(0, 20).map((collision) => ({
          partA: collision.partA,
          partB: collision.partB,
          overlapLdu: collision.overlapLdu,
          certainty: collision.certainty,
          message: collision.message,
        })),
        unverifiedCollisions: validation.unverifiedCollisions,
        virtualColors: validation.virtualColors.slice(0, 20),
        constraints: validation.constraints,
        boundsLdu: validation.bounds,
        statics: {
          massGrams: Math.round(statics.mass.grams * 10) / 10,
          supportMarginLdu: statics.support ? Math.round(statics.support.marginLdu * 10) / 10 : null,
          stable: statics.support?.stable ?? null,
          overloadedJoints: statics.overloaded.length,
        },
        nextAction: next.action,
        nextTool: next.tool,
        nextArgs: next.args ?? {},
      }
    },

    generation_compile: async (input) => {
      const generation = await generationModule()
      try {
        const host = generation.getGenerationHost()
        const prompt = input.prompt as string | undefined
        return input.useModel === false ? host.compileLocal(prompt) : await host.compileFromServer(prompt)
      } catch (cause) {
        const refusal = generation.refusalOf(cause)
        if (!refusal) throw cause
        return fail(refusal.code, refusal.message, refusal.repair, refusal.details)
      }
    },


    generation_set: async (input) => {
      const generation = await generationModule()
      try {
        return generation.getGenerationHost().set(input as Parameters<ReturnType<typeof generation.getGenerationHost>['set']>[0])
      } catch (cause) {
        const refusal = generation.refusalOf(cause)
        if (!refusal) throw cause
        return fail(refusal.code, refusal.message, refusal.repair, refusal.details)
      }
    },

    generation_run: async (input) => {
      const generation = await generationModule()
      try {
        const state = await generation.getGenerationHost().run({ useModel: input.useModel as boolean | undefined })
        const best = state.candidates[0]
        const continuation = best && 'continuation' in best ? best.continuation : undefined
        return {
          ...state,
          nextAction: best
            ? `Preview candidate ${best.id} (${best.partCount} parts) as one wave. Do not place its parts individually.${
                continuation
                  ? ` It hit the part ceiling with ${continuation.remainingRoles.join(', ')} still unbuilt — after the builder accepts it, call preflight_capability generate_region for the rest.`
                  : ''
              }`
            : 'No candidate survived the gates. Read notes and rejected, then adjust the brief with generation_set and run again.',
          nextTool: best ? 'generation_preview' : 'generation_set',
          nextArgs: best ? { candidateId: best.id } : {},
        }
      } catch (cause) {
        const refusal = generation.refusalOf(cause)
        if (!refusal) throw cause
        return fail(refusal.code, refusal.message, refusal.repair, refusal.details)
      }
    },

    generation_state: async () => (await generationModule()).getGenerationHost().state(),

    generation_cancel: async () => (await generationModule()).getGenerationHost().cancel(),

    generation_preview: async (input) => {
      const generation = await generationModule()
      const document = cadEngine.getSnapshot().document

      let plan
      try {
        plan = generation.getGenerationHost().planWave(String(input.candidateId ?? ''))
      } catch (cause) {
        const refusal = generation.refusalOf(cause)
        if (!refusal) throw cause
        return fail(refusal.code, refusal.message, refusal.repair, refusal.details)
      }

      // The same ledger `preflight_capability` uses. A generated model and a
      // hand-planned wall arrive in the review queue as the same kind of thing,
      // so one accept — and one undo — covers the whole candidate.
      const result = options.waves.propose({
        label: typeof input.label === 'string' ? input.label : plan.label,
        operations: plan.operations,
        capability: 'generate_from_brief',
        summary: plan.summary,
        expectedRevision: document.revision,
      })
      if (!result.ok) return { error: result.error }

      return {
        documentRevision: document.revision,
        waveId: result.wave.id,
        label: result.wave.label,
        candidateId: plan.candidateId,
        strategy: plan.strategy,
        capability: 'generate_from_brief',
        summary: plan.summary,
        operations: plan.operations.length,
        partCount: plan.partCount,
        changedPartIds: result.wave.changedPartIds.slice(0, 60),
        previewValidation: result.wave.validation,
        ...(plan.notes.length ? { notes: plan.notes } : {}),
        status: 'awaiting review — the document is unchanged at revision ' + document.revision,
      }
    },

    preflight_capability: async (input) => {
      const capabilityId = String(input.capability ?? '')
      // `generate_from_brief` and `generate_region` plan by running the
      // pipeline, which lives in the lazily-loaded generation chunk and
      // registers its planner when it arrives. Loading it here is what lets a
      // model discover generation through capability_search and then use it,
      // without the pipeline riding along in every conversation.
      if (capabilityId.startsWith('generate_')) await generationModule()

      const state = cadEngine.getSnapshot()
      const document = state.document
      const definition = sharedCapability(capabilityId)
      if (!definition || definition.kind !== 'mutate') {
        return fail(
          'INVALID_OPERATION',
          `"${capabilityId}" is not a mutating capability.`,
          'Call capability_search and use a capability whose kind is "mutate".',
        )
      }

      const parsed = parseCapabilityArgs(capabilityId, input.args ?? {})
      if (!parsed.ok) return fail(parsed.error.code, parsed.error.message, parsed.error.repair, { issues: parsed.error.issues })

      const identity = verifyIdentities(parsed.args, document)
      if (identity) return { error: identity }

      let plan
      try {
        plan = planSharedMutation(capabilityId as SharedMutationId, parsed.args, {
          document,
          selection: state.selection,
          actor: 'agent',
        })
      } catch (cause) {
        if (cause instanceof SharedCapabilityError) {
          const details = { ...(cause.details ?? {}) }
          const nearbyPartId = typeof details.nearbyPartId === 'string' ? details.nearbyPartId : undefined
          const movingPartId = typeof details.movingPartId === 'string' ? details.movingPartId : undefined
          const next =
            capabilityId === 'connect_parts' && nearbyPartId && movingPartId
              ? {
                  action: `Mate ${movingPartId} onto ${nearbyPartId} with connect_parts. Copy those ids; do not invent XYZ.`,
                  tool: 'preflight_capability',
                  why: 'connect-elsewhere',
                  args: { capability: 'connect_parts', args: { movingPartId, targetPartId: nearbyPartId } },
                }
              : liveNext({
                  failureCode: cause.code,
                  nearbyAnchorId: nearbyPartId,
                  floatingPartId: movingPartId,
                })
          return fail(cause.code, cause.message, cause.repair, { ...details, next })
        }
        throw cause
      }

      const result = options.waves.propose({
        label: typeof input.label === 'string' ? input.label : plan.label,
        operations: plan.operations,
        capability: plan.capability,
        summary: plan.summary,
        expectedRevision: document.revision,
      })
      if (!result.ok) return { error: result.error }

      return {
        documentRevision: document.revision,
        waveId: result.wave.id,
        label: result.wave.label,
        capability: plan.capability,
        summary: plan.summary,
        operations: plan.operations.length,
        changedPartIds: result.wave.changedPartIds.slice(0, 60),
        previewValidation: result.wave.validation,
        ...(plan.report ? { report: plan.report } : {}),
        status: 'awaiting review — the document is unchanged at revision ' + document.revision,
      }
    },

    preflight_placement: (input) => {
      const state = cadEngine.getSnapshot()
      const document = state.document
      const definitionId = String(input.definitionId ?? '')
      const anchorPartId = String(input.anchorPartId ?? '')

      const identity = verifyIdentities({ anchorPartId }, document)
      if (identity) return { error: identity }
      const definitionProblem = verifyDefinition(definitionId)
      if (definitionProblem) return { error: definitionProblem }

      const definition = catalog.get(definitionId)!
      const anchor = document.parts[anchorPartId]
      const anchorDefinition = catalog.get(anchor.definitionId)
      const anchorBounds = getPartBounds(anchor)
      const approach = String(input.approach ?? 'on-top')
      const offset = Number(input.offsetStuds ?? 0) * STUD_LDU
      const quarterTurns = Number(input.quarterTurns ?? 0)
      const basis = quarterTurns ? basisFromEulerDegrees([0, quarterTurns * 90, 0]) : IDENTITY_BASIS

      // The coarse pose only has to land inside the solver's search radius; the
      // exact mate comes from the connector frames, which is what makes this a
      // relationship rather than a coordinate guess.
      let coarse: Vec3
      switch (approach) {
        case 'on-top': {
          const surfaceY = surfaceAbove(anchorDefinition, anchor.transform.position[1]) ?? anchorBounds.min[1]
          coarse = [anchor.transform.position[0] + offset, originForSurface(definition, surfaceY), anchor.transform.position[2]]
          break
        }
        case 'underneath':
          coarse = [anchor.transform.position[0] + offset, anchorBounds.max[1], anchor.transform.position[2]]
          break
        case 'beside-x':
          coarse = [anchorBounds.max[0] + STUD_LDU, anchor.transform.position[1], anchor.transform.position[2] + offset]
          break
        case 'beside-minus-x':
          coarse = [anchorBounds.min[0] - STUD_LDU, anchor.transform.position[1], anchor.transform.position[2] + offset]
          break
        case 'beside-z':
          coarse = [anchor.transform.position[0] + offset, anchor.transform.position[1], anchorBounds.max[2] + STUD_LDU]
          break
        case 'beside-minus-z':
          coarse = [anchor.transform.position[0] + offset, anchor.transform.position[1], anchorBounds.min[2] - STUD_LDU]
          break
        default:
          return fail('INVALID_INPUT', `Unknown approach "${approach}".`, 'Use on-top, underneath, beside-x, beside-minus-x, beside-z or beside-minus-z.')
      }

      const color = Number(
        input.color ?? definition.availableColors[0] ?? anchor.color,
      )
      const candidate: PartInstance = {
        id: createId('agent_place'),
        definitionId,
        color,
        transform: { position: coarse, basis },
        subassemblyId: anchor.subassemblyId,
        stepId: document.steps.at(-1)?.id ?? anchor.stepId,
        provenance: 'agent',
        protected: false,
      }

      const mate = searchMateOnTarget(candidate, document, anchor, candidate.transform, approach, STUD_LDU)
      const seated = mate.transform ? { ...candidate, transform: mate.transform } : null
      const solved = seated && poseMatchesApproach(seated, anchor, approach) ? mate.transform : null
      if (!solved) {
        if (mate.blockedByCollision) {
          const next = liveNext({
            collisions: 1,
            disconnectedParts: 0,
            floatingParts: 0,
            failureCode: 'COLLISION',
            triedDefinitionId: definitionId,
            placeableAnchorId: placeableAnchors(document).filter((entry) => entry.id !== anchor.id)[0]?.id,
          })
          return fail(
            'COLLISION',
            `Every legal mate of ${definitionId} on the ${approach} face of ${anchor.id} would collide with another part.`,
            next.action,
            { approach, next, placeableAnchors: placeableAnchors(document).filter((entry) => entry.id !== anchor.id) },
          )
        }
        const occupancy = approachOccupancy(document, anchor.id, approach)
        const availability = connectorAvailability(document, [anchor.id])
        const code = occupancy === 'occupied' ? 'CONNECTOR_OCCUPIED' : 'NO_COMPATIBLE_CONNECTOR'
        const wantedFamily: ConnectionFamily = approach === 'underneath' ? 'stud' : 'anti-stud'
        const alternatives = catalog
          .searchPage({
            requireGeometry: true,
            tier: 'placeable',
            connectorTypes: [wantedFamily],
            limit: 8,
          })
          .records.filter((record) => record.id !== definitionId)
          .slice(0, 5)
          .map((record) => ({ id: record.id, name: record.name }))
        const anchors = placeableAnchors(document).filter((entry) => entry.id !== anchor.id)
        const next = liveNext({
          collisions: 0,
          disconnectedParts: 0,
          floatingParts: 0,
          failureCode: code,
          triedDefinitionId: definitionId,
          placeableAnchorId: anchors[0]?.id,
        })
        const message =
          code === 'CONNECTOR_OCCUPIED'
            ? `Every exclusive connector on the ${approach} face of ${anchor.id} is occupied.`
            : `No legal connector mate was found between ${definitionId} and ${anchor.id} on the ${approach} face.`
        return fail(code, message, next.action, {
          anchorDefinitionId: anchor.definitionId,
          approach,
          occupancy,
          openApproaches: openApproachNames(availability),
          occupiedExclusive: availability.occupiedExclusive,
          alternativeIdentities: alternatives,
          placeableAnchors: anchors,
          next,
        })
      }

      const result = options.waves.propose({
        label: typeof input.label === 'string' ? input.label : `Place ${definitionId} ${approach} ${anchor.id}`,
        operations: [{ type: 'part.add', part: { ...candidate, transform: solved } }],
        capability: null,
        summary: `${definition.name} mated to ${anchor.id} (${approach}), pose solved by the connector solver.`,
        expectedRevision: document.revision,
      })
      if (!result.ok) return { error: result.error }
      if (result.wave.validation?.collisions.length) {
        options.waves.reject(result.wave.id, 'Preview collides with another part.')
        const next = liveNext({
          collisions: result.wave.validation.collisions.length,
          failureCode: 'COLLISION',
          triedDefinitionId: definitionId,
          placeableAnchorId: placeableAnchors(document).filter((entry) => entry.id !== anchor.id)[0]?.id,
        })
        return fail(
          'COLLISION',
          `The solved pose of ${definitionId} on ${anchor.id} collides with another part.`,
          next.action,
          { approach, next, collisions: result.wave.validation.collisions.slice(0, 8) },
        )
      }

      return {
        documentRevision: document.revision,
        waveId: result.wave.id,
        label: result.wave.label,
        placedPartId: candidate.id,
        definitionId,
        anchorPartId: anchor.id,
        approach,
        solvedPositionLdu: solved.position,
        previewValidation: result.wave.validation,
        status: 'awaiting review — the document is unchanged at revision ' + document.revision,
      }
    },

    repair_suggest: (input) => {
      const state = cadEngine.getSnapshot()
      const document = state.document
      const validation = state.validation
      const waveId = typeof input.proposalId === 'string' ? input.proposalId : null
      const wave = waveId ? options.waves.get(waveId) : undefined

      const scoped = Array.isArray(input.partIds) ? input.partIds.map(String) : []
      // A refused wave's collisions are in its *preview*, not in the live
      // document — the whole point of a preflight is that the live document
      // never had them. Asking about a wave therefore has to look at the wave.
      const source = wave?.validation?.collisions.length ? wave.validation.collisions : validation.collisions
      const collisions = source
        .filter((collision) => !scoped.length || scoped.includes(collision.partA) || scoped.includes(collision.partB))
        .slice(0, 10)
        .map((collision) => {
          // The smallest axis of overlap is the cheapest way out of it.
          const magnitudes = collision.overlapLdu.map((value) => Math.abs(value))
          const axis = magnitudes.indexOf(Math.min(...magnitudes))
          const clearance: [number, number, number] = [0, 0, 0]
          clearance[axis] = Math.ceil(magnitudes[axis] / 4) * 4
          return {
            partA: collision.partA,
            partB: collision.partB,
            overlapLdu: collision.overlapLdu,
            certainty: collision.certainty,
            suggestedClearanceLdu: clearance,
            suggestion:
              'Do not invent XYZ or type a transform. Call next.tool with next.args. Place against a different face with preflight_placement, or mate with connect_parts.',
          }
        })

      const protectedRegions = Object.values(document.subassemblies)
        .filter((item) => item.locked)
        .map((item) => ({ subassemblyId: item.id, name: item.name, partCount: item.partIds.length }))

      const staleWaves = options.waves
        .list()
        .filter((entry) => entry.status === 'stale')
        .map((entry) => ({ waveId: entry.id, label: entry.label, problem: entry.problem ?? 'The document moved on.' }))

      const statics = analyseStatics(document)
      const floating = floatingPartIds(document)
      const failureCode =
        (input.failureCode as string | undefined)
        ?? (collisions.length ? 'COLLISION' : floating.length ? 'DISCONNECTED' : null)
      const next = liveNext({
        collisions: collisions.length,
        disconnectedParts: validation.disconnectedPartIds.length,
        floatingParts: floating.length,
        floatingPartId: floating[0],
        tipping: statics.support ? statics.support.marginLdu < 0 : null,
        failureCode,
        seenRepair: true,
        placeableAnchorId: placeableAnchors(document)[0]?.id,
      })

      return {
        documentRevision: document.revision,
        failureCode: (input.failureCode as string | undefined) ?? null,
        wave: wave
          ? { id: wave.id, label: wave.label, status: wave.status, baseRevision: wave.baseRevision, problem: wave.problem ?? null }
          : null,
        revisionAdvice:
          wave && wave.baseRevision !== document.revision
            ? `That wave was planned at revision ${wave.baseRevision} and the document is at ${document.revision}. Reread the changed region and preflight again.`
            : null,
        collisions,
        floatingPartIds: floating.slice(0, 20),
        protectedRegions,
        protectedPartIds: Object.values(document.parts)
          .filter((part) => part.protected)
          .map((part) => part.id)
          .slice(0, 40),
        weakAttachments: findWeakAttachments(document).slice(0, 10),
        failingConstraints: validation.constraints.filter((constraint) => constraint.status === 'fail'),
        staleWaves,
        next,
        nextAction: next.action,
        nextTool: next.tool,
        nextArgs: next.args ?? {},
      }
    },
  }

  return {
    declarations,
    async execute(call: ToolCall): Promise<ToolResult> {
      const declaration = declarations.find((tool) => tool.name === call.name)
      const revision = cadEngine.getSnapshot().document.revision
      const traceId = options.trace?.begin('tool', call.name, revision, { input: call.input })

      const respond = (ok: boolean, value: unknown): ToolResult => {
        const content = JSON.stringify(value)
        if (traceId) {
          if (ok) options.trace?.succeed(traceId, { bytes: content.length })
          else {
            const problem =
              typeof value === 'object' && value !== null && 'error' in value
                ? `${(value as { error: ToolFailure }).error.code}: ${(value as { error: ToolFailure }).error.message}`
                : 'The tool failed.'
            options.trace?.fail(traceId, problem)
          }
        }
        // 60 000 characters is the wire ceiling; a truncated result says it is
        // truncated rather than looking like a complete but short answer.
        const capped =
          content.length > 59_000
            ? JSON.stringify({ truncated: true, bytes: content.length, note: 'Result too large; narrow the query.', head: content.slice(0, 50_000) })
            : content
        return { id: call.id, name: call.name, ok, content: capped }
      }

      if (!declaration) {
        return respond(false, fail('TOOL_NOT_AVAILABLE', `There is no tool named "${call.name}".`, `Available tools: ${declarations.map((tool) => tool.name).join(', ')}.`))
      }

      const parsed = declaration.schema.safeParse(call.input ?? {})
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.') || '(root)',
          problem: issue.message,
        }))
        return respond(
          false,
          fail(
            'INVALID_INPUT',
            `Input to ${call.name} did not match its schema: ${issues.map((issue) => `${issue.path} — ${issue.problem}`).join('; ')}`,
            'Resend arguments matching the tool schema exactly.',
            { issues },
          ),
        )
      }

      if (declaration.kind === 'preflight' && cadEngine.getSnapshot().autonomy === 'inspect') {
        return respond(
          false,
          fail(
            'READ_ONLY_MODE',
            'The workbench is in Inspect mode, which is read-only. Nothing can be proposed.',
            'Tell the builder to switch to Propose or Build if they want a change planned.',
          ),
        )
      }

      const fingerprint = `${call.name}:${JSON.stringify(parsed.data)}`
      if (declaration.kind === 'preflight' && lastFailedPreflight === fingerprint) {
        const next = liveNext({ failureCode: 'REPEAT_REFUSED' })
        return respond(
          false,
          fail(
            'REPEAT_REFUSED',
            `Those exact arguments to ${call.name} were already refused.`,
            'Call repair_suggest with the earlier failureCode, then change the identity, face, or anchor. Do not retry the same call.',
            { next, nextTool: next.tool, nextArgs: next.args ?? {} },
          ),
        )
      }

      try {
        const value = await runners[call.name](parsed.data as Record<string, unknown>)
        const failed = typeof value === 'object' && value !== null && 'error' in value
        if (declaration.kind === 'preflight') lastFailedPreflight = failed ? fingerprint : null
        return respond(!failed, value)
      } catch (cause) {
        // A thrown error is a defect in this host, not a repairable model
        // mistake. It is reported as such rather than dressed up as guidance.
        return respond(
          false,
          fail(
            'INTERNAL_ERROR',
            `The ${call.name} tool failed: ${String((cause as Error)?.message ?? cause)}`,
            'Report this; it is a defect in the workbench, not something to work around.',
          ),
        )
      }
    },
  }
}

/** Convenience for tests and for the session: the tool names in mode order. */
export const TOOL_NAMES: readonly string[] = ASSISTANT_TOOLS.map((tool) => tool.name)

export function validateDocumentSnapshot(document: ModelDocument) {
  return validateDocument(document)
}
