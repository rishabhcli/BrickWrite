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
import { getPartBounds } from '../cad/geometry'
import { createId } from '../cad/ids'
import { basisFromEulerDegrees, IDENTITY_BASIS } from '../cad/math'
import { documentModules, findModule } from '../cad/modules'
import { frameScene, renderScene, rgbFromHex, type RasterImage, type RasterPart } from '../cad/raster'
import { bestSnapTransform } from '../cad/snapping'
import { findWeakAttachments, validateDocument } from '../cad/validation'
import type { ModelDocument, PartInstance, Vec3 } from '../cad/types'
import { capabilityJsonSchema, parseCapabilityArgs } from './schemas'
import { describeScope, parseReferenceTokens, resolveReference, type ViewportPin } from './references'
import type { WaveLedger } from './modes'
import type { TraceLedger } from './trace'
import { ASSISTANT_TOOLS, type AssistantToolDeclaration } from './toolschemas'
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

  const runners: Record<string, (input: Record<string, unknown>) => unknown | Promise<unknown>> = {
    scene_overview: () => {
      const state = cadEngine.getSnapshot()
      const validation = state.validation
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
          virtualColors: validation.virtualColors.length,
        },
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

      return {
        documentRevision: document.revision,
        matched: total,
        returned: page.length,
        truncated: total > page.length,
        parts: page.map((part) => {
          const definition = catalog.get(part.definitionId)
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
            ...(input.includeNeighbours === true
              ? { connectedTo: [...new Set(neighbours.get(part.id) ?? [])] }
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
        protectedPartIds: scope.protectedPartIds,
        lockedSubassemblyIds: scope.lockedSubassemblyIds,
        note:
          scope.protectedPartIds.length || scope.lockedSubassemblyIds.length
            ? 'Some parts in this scope are protected; the kernel will refuse edits that touch them.'
            : undefined,
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
      return {
        documentRevision: state.document.revision,
        healthy: validation.healthy,
        partCount: validation.partCount,
        connectionCount: validation.connectionCount,
        componentCount: validation.componentCount,
        disconnectedPartIds: validation.disconnectedPartIds.slice(0, 40),
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
      }
    },

    preflight_capability: (input) => {
      const state = cadEngine.getSnapshot()
      const document = state.document
      const capabilityId = String(input.capability ?? '')
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
          return fail(cause.code, cause.message, cause.repair, cause.details)
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

      const solved = bestSnapTransform(candidate, document, candidate.transform, {
        radiusLdu: STUD_LDU,
        targetPartIds: [anchor.id],
      })
      if (!solved) {
        return fail(
          'NO_COMPATIBLE_CONNECTOR',
          `No legal connector mate was found between ${definitionId} and ${anchor.id} on the ${approach} face.`,
          'Try another face, another identity, or inspect the anchor with selection_geometry to see what it exposes.',
          { anchorDefinitionId: anchor.definitionId, approach },
        )
      }

      const result = options.waves.propose({
        label: typeof input.label === 'string' ? input.label : `Place ${definitionId} ${approach} ${anchor.id}`,
        operations: [{ type: 'part.add', part: { ...candidate, transform: solved } }],
        capability: null,
        summary: `${definition.name} mated to ${anchor.id} (${approach}), pose solved by the connector solver.`,
        expectedRevision: document.revision,
      })
      if (!result.ok) return { error: result.error }

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
            suggestion: `Move ${collision.partB} by ${clearance.join(', ')} LDU, or place it against a different face.`,
          }
        })

      const protectedRegions = Object.values(document.subassemblies)
        .filter((item) => item.locked)
        .map((item) => ({ subassemblyId: item.id, name: item.name, partCount: item.partIds.length }))

      const staleWaves = options.waves
        .list()
        .filter((entry) => entry.status === 'stale')
        .map((entry) => ({ waveId: entry.id, label: entry.label, problem: entry.problem ?? 'The document moved on.' }))

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
        protectedRegions,
        protectedPartIds: Object.values(document.parts)
          .filter((part) => part.protected)
          .map((part) => part.id)
          .slice(0, 40),
        weakAttachments: findWeakAttachments(document).slice(0, 10),
        failingConstraints: validation.constraints.filter((constraint) => constraint.status === 'fail'),
        staleWaves,
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

      try {
        const value = await runners[call.name](parsed.data as Record<string, unknown>)
        const failed = typeof value === 'object' && value !== null && 'error' in value
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
