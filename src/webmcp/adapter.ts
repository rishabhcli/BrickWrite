import { z } from 'zod'
import { findArticulatedJoints } from '../cad/articulation'
import {
  planSharedMutation,
  sharedCapability,
  SHARED_CAPABILITIES,
  SharedCapabilityError,
} from '../cad/capabilities'
import { computeBuildOrder, verifyBuildOrder } from '../cad/instructions'
import { catalog } from '../cad/catalog'
import { buildBom } from '../cad/bom'
import { cadEngine } from '../cad/engine'
import { createId } from '../cad/ids'
import { exportLDraw, exportMpd } from '../cad/ldraw'
import { connectedComponent, findWeakAttachments } from '../cad/validation'
import {
  assertExpectations,
  CatalogSearchSchema,
  jsonSchemaOf,
  MAX_OPERATIONS_PER_BATCH,
  OperationSchema,
  PreflightSchema,
  ContractError,
  toErrorEnvelope,
  toKernelOperations,
  TOOL_PROFILE,
  toolProfileHash,
} from './contract'

const ApplySchema = z.object({
  proposalId: z.string().min(1).max(120),
  expectedToolProfileHash: z.string().optional(),
  expectedCatalogVersion: z.string().optional(),
})
import type { Actor, CadOperation, ModelDocument, PartInstance } from '../cad/types'

type ToolDefinition = ModelContextToolDefinition
type ToolResult = ModelContextToolResult

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
})

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const revisionProperty = { type: 'integer', description: 'Revision returned by the most recent read. Mutations reject stale revisions.' }

/**
 * Validates and translates an operation batch.
 *
 * Validation happens once, at the gateway, against the same schema the tool
 * advertises. Nothing downstream re-checks shapes, and nothing malformed reaches
 * the kernel.
 */
function parseOperations(raw: unknown, document: ModelDocument): CadOperation[] {
  const inputs = z.array(OperationSchema).min(1).max(MAX_OPERATIONS_PER_BATCH).parse(raw)
  return toKernelOperations(inputs, {
    parts: document.parts,
    defaultSubassemblyId:
      Object.values(document.subassemblies).find((item) => !item.locked)?.id ??
      Object.keys(document.subassemblies)[0] ??
      'main',
    defaultStepId: document.steps.at(-1)?.id ?? 'step_1',
    idPrefix: createId('agent'),
    revision: document.revision,
  })
}

/**
 * The contract fingerprint a caller can pin.
 *
 * Recomputed per call so an autonomy change or catalog upgrade is reflected
 * immediately; the hash is what lets a mutation be refused when it was planned
 * against a surface that no longer exists.
 */
function profileContext() {
  const state = cadEngine.getSnapshot()
  return {
    toolProfile: TOOL_PROFILE,
    profileHash: toolProfileHash([...(window.brickwright?.tools.keys() ?? [])], catalog.version),
    catalogVersion: catalog.version,
    documentRevision: state.document.revision,
  }
}

function resultOf<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): ToolResult {
  return result.ok ? json(result.value) : json({ error: result.error })
}

const readTools: ToolDefinition[] = [
  {
    name: 'workspace_get',
    description: 'Read the current Brickwright project, exact document revision, selection, constraints, autonomy state, and validation summary.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    execute: () => {
      const state = cadEngine.getSnapshot()
      return json({
        ...profileContext(),
        project: { id: state.document.id, name: state.document.name, catalogVersion: state.document.catalogVersion },
        catalog: {
          version: catalog.version,
          // Two tiers: everything searchable, and the subset with compiled
          // geometry that can actually be placed in this build.
          identities: catalog.identityCount,
          placeable: catalog.placeableCount,
          colors: catalog.colors().length,
          note: 'Parts outside the placeable set are real catalog identities without compiled geometry. add_part on one returns GEOMETRY_UNAVAILABLE.',
        },
        documentRevision: state.document.revision,
        selection: state.selection,
        autonomy: state.autonomy,
        partCount: state.validation.partCount,
        subassemblies: Object.values(state.document.subassemblies).map(({ id, name, partIds, locked }) => ({ id, name, partCount: partIds.length, locked })),
        constraints: state.document.constraints,
        validation: {
          healthy: state.validation.healthy,
          collisions: state.validation.collisions.length,
          components: state.validation.componentCount,
          virtualColors: state.validation.virtualColors.length,
          boundsLdu: state.validation.bounds,
        },
      })
    },
  },
  {
    name: 'catalog_search',
    description: 'Search the real-part catalog by text, category, dimensions, connector families, year, and observed LDraw colors. Returns compact handles.',
    inputSchema: jsonSchemaOf(CatalogSearchSchema),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const query = CatalogSearchSchema.parse(input ?? {})
      const results = cadEngine.getCatalog(query as Parameters<typeof cadEngine.getCatalog>[0])
      return json({
        catalogVersion: catalog.version,
        identitiesSearched: catalog.identityCount,
        placeableInBuild: catalog.placeableCount,
        results: results.map((part) => ({
          id: part.id,
          name: part.name,
          category: part.category,
          studs: part.dimensions,
          setAppearances: part.frequency,
          connectorFamilies: part.connectorFamilies,
          placeable: part.geometryAvailable,
          connectionsKnown: part.connectionsAvailable,
        })),
      })
    },
  },
  {
    name: 'part_inspect',
    description: 'Expand one catalog definition or placed instance, including identity, dimensions, connectors, color availability, transform, provenance, and protection.',
    inputSchema: schema({ id: { type: 'string', description: 'Part definition id or placed instance id.' } }, ['id']),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const id = String((input as { id: string }).id)
      const state = cadEngine.getSnapshot()
      const instance = state.document.parts[id]
      const definitionId = instance?.definitionId ?? id
      const definition = catalog.get(definitionId)
      return json({
        documentRevision: state.document.revision,
        definition: definition ?? null,
        identity: definition ? null : (catalog.describe(definitionId) ?? null),
        instance: instance ?? null,
      })
    },
  },
  {
    name: 'scene_query',
    description: 'Query semantic CAD entities without dumping the entire scene. Filter by subassembly, selected entities, or part ids.',
    inputSchema: schema({
      subassemblyId: { type: 'string' },
      partIds: { type: 'array', items: { type: 'string' }, maxItems: 200 },
      selectionOnly: { type: 'boolean' },
      detail: { type: 'string', enum: ['summary', 'parts'] },
    }),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const query = input as { subassemblyId?: string; partIds?: string[]; selectionOnly?: boolean; detail?: string }
      const state = cadEngine.getSnapshot()
      let parts = Object.values(state.document.parts)
      if (query.subassemblyId) parts = parts.filter((part) => part.subassemblyId === query.subassemblyId)
      if (query.partIds) {
        const ids = new Set(query.partIds)
        parts = parts.filter((part) => ids.has(part.id))
      }
      if (query.selectionOnly) {
        const ids = new Set(state.selection)
        parts = parts.filter((part) => ids.has(part.id))
      }
      return json({
        documentRevision: state.document.revision,
        count: parts.length,
        parts: query.detail === 'parts' ? parts : parts.map((part) => ({ id: part.id, definitionId: part.definitionId, subassemblyId: part.subassemblyId })),
      })
    },
  },
  {
    name: 'render_capture',
    description: 'Capture the live CAD viewport for the agent perception loop. Supports named engineering views and returns the exact document revision, camera view, bounds, visible part count, and PNG pixels.',
    inputSchema: schema({
      view: { type: 'string', enum: ['isometric', 'front', 'rear', 'left', 'right', 'top'] },
      mode: { type: 'string', enum: ['beauty', 'orthographic', 'silhouette', 'connections', 'violations', 'exploded'] },
    }),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = input as { view?: string; mode?: string }
      const view = request.view ?? 'isometric'
      const mode = request.mode ?? 'beauty'
      const requestId = createId('capture')
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener('brickwright:capture-ready', ready)
          resolve()
        }, 750)
        const ready = (event: Event) => {
          if ((event as CustomEvent<{ requestId: string }>).detail.requestId !== requestId) return
          window.clearTimeout(timeout)
          window.removeEventListener('brickwright:capture-ready', ready)
          resolve()
        }
        window.addEventListener('brickwright:capture-ready', ready)
        window.dispatchEvent(new CustomEvent('brickwright:set-camera-view', { detail: { view, mode, requestId } }))
      })
      const state = cadEngine.getSnapshot()
      const metadata = {
        documentRevision: state.document.revision,
        cameraView: view,
        renderMode: mode,
        boundingDimensionsLdu: state.validation.bounds.size,
        visiblePartCount: state.validation.partCount,
        selectedPartIds: state.selection,
      }
      const dataUrl = window.__brickwrightCanvas?.toDataURL('image/png')
      if (!dataUrl) return json({ ...metadata, warning: 'Viewport pixels are unavailable before the renderer initializes.' })
      if (mode !== 'beauty') window.dispatchEvent(new CustomEvent('brickwright:set-camera-view', { detail: { view, mode: 'beauty' } }))
      return {
        content: [
          { type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(metadata) },
        ],
        structuredContent: metadata,
      }
    },
  },
  {
    name: 'validate_model',
    description: 'Run deterministic collision, connectivity, dimensions, palette, and piece-count validation on the current CAD document.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    execute: () => json(cadEngine.getSnapshot().validation),
  },
  {
    name: 'builder_feedback_get',
    description: 'Read spatial builder notes with their anchor part ids, author, revision, and resolution status.',
    inputSchema: schema({ status: { type: 'string', enum: ['open', 'resolved', 'all'] } }),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const status = (input as { status?: string }).status ?? 'open'
      const state = cadEngine.getSnapshot()
      return json({
        documentRevision: state.document.revision,
        notes: state.document.notes.filter((note) => status === 'all' || note.status === status),
      })
    },
  },
  {
    name: 'capabilities_search',
    description: 'Discover long-tail Brickwright CAD operations exposed through action_read and action_mutate.',
    inputSchema: schema({ query: { type: 'string' } }, ['query']),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const query = String((input as { query: string }).query).toLowerCase()
      return json(
        SHARED_CAPABILITIES
          .filter((capability) => `${capability.id} ${capability.title} ${capability.summary} ${capability.group}`.toLowerCase().includes(query))
          .map((capability) => ({
            id: capability.id,
            kind: capability.kind,
            group: capability.group,
            summary: capability.summary,
            parity: { human: true, agent: true },
          })),
      )
    },
  },
  {
    name: 'capabilities_help',
    description: 'Get the input contract for one long-tail CAD capability.',
    inputSchema: schema({ capability: { type: 'string' } }, ['capability']),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const capability = String((input as { capability: string }).capability)
      const definition = sharedCapability(capability)
      if (!definition) return json({ error: 'UNKNOWN_CAPABILITY', repair: 'Call capabilities_search with a task-oriented query.' })
      return json({
        id: definition.id,
        title: definition.title,
        summary: definition.summary,
        parity: { human: 'Command Deck or primary CAD control', agent: definition.kind === 'read' ? 'action_read' : 'action_mutate' },
        call: definition.kind === 'read' ? 'action_read' : 'action_mutate',
        input: definition.kind === 'read'
          ? { action: definition.id, args: definition.input }
          : { action: definition.id, expectedRevision: 'integer', args: definition.input },
      })
    },
  },
  {
    name: 'action_read',
    description: 'Run a discovered long-tail read operation after consulting capabilities_help.',
    inputSchema: schema({ action: { type: 'string' }, args: { type: 'object' } }, ['action']),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const action = String((input as { action: string }).action)
      if (action === 'export_ldraw') return json({ documentRevision: cadEngine.getSnapshot().document.revision, ldraw: exportLDraw(cadEngine.getDocument()) })
      if (action === 'export_bom') return json({ documentRevision: cadEngine.getSnapshot().document.revision, lines: buildBom(cadEngine.getDocument()) })
      if (action === 'export_mpd') return json({ documentRevision: cadEngine.getSnapshot().document.revision, mpd: exportMpd(cadEngine.getDocument()) })
      if (action === 'catalog_coverage') {
        return json({
          catalogVersion: catalog.version,
          identities: catalog.identityCount,
          placeable: catalog.placeableCount,
          colors: catalog.colors().length,
          // Straight from the compiler, so the agent sees measured coverage
          // rather than an implied claim of completeness.
          coverage: catalog.info?.coverage ?? null,
          sources: catalog.info?.sources ?? null,
        })
      }
      if (action === 'weak_attachments') {
        return json({ documentRevision: cadEngine.getSnapshot().document.revision, weak: findWeakAttachments(cadEngine.getDocument()) })
      }
      if (action === 'selection_connected') {
        const state = cadEngine.getSnapshot()
        const requested = (input as { args?: { partIds?: string[] } }).args?.partIds ?? state.selection
        const partIds = connectedComponent(state.document, requested)
        return json({
          documentRevision: state.document.revision,
          seedPartIds: requested,
          partIds,
          count: partIds.length,
        })
      }
      if (action === 'compute_build_order') {
        const state = cadEngine.getSnapshot()
        const result = computeBuildOrder(state.document, {
          maxPartsPerStep: Number((input as { args?: { maxPartsPerStep?: number } }).args?.maxPartsPerStep) || undefined,
        })
        return json({
          documentRevision: state.document.revision,
          steps: result.steps.map((step) => ({ index: step.index, name: step.name, partIds: step.partIds })),
          warnings: result.warnings,
          guarantee:
            'Every part attaches to structure placed in an earlier step, except those listed as beginning a new island.',
          verified: verifyBuildOrder(state.document, result.steps).valid,
        })
      }
      if (action === 'list_joints') {
        const state = cadEngine.getSnapshot()
        const scope = (input as { args?: { partIds?: string[] } }).args?.partIds ?? state.selection
        return json({
          documentRevision: state.document.revision,
          scope,
          joints: findArticulatedJoints(state.document, scope).map((joint) => ({
            edgeId: joint.edgeId,
            family: joint.family,
            freedom: joint.joint,
            pivotLdu: joint.pivotLdu,
            axis: joint.axis,
            movingPartCount: joint.movingPartIds.length,
            description: joint.label,
          })),
          note: 'Stud connections are rigid once assembled and are deliberately absent.',
        })
      }
      return json({ error: 'UNKNOWN_ACTION', repair: 'Call capabilities_search and capabilities_help.' })
    },
  },
]

const proposalTools: ToolDefinition[] = [
  {
    name: 'build_preflight',
    description: 'Dry-run an atomic batch of real CAD operations. Checks revision, protected regions, catalog identity, colors, collision, connectivity, constraints, and produces a visible ghost proposal without mutating the document.',
    // Advertised schema and enforced schema are the same declaration, so the
    // operation vocabulary the agent is shown is exactly what the gateway accepts.
    inputSchema: jsonSchemaOf(PreflightSchema),
    execute: (input) => {
      const document = cadEngine.getDocument()
      try {
        const request = PreflightSchema.parse(input)
        assertExpectations(request, profileContext())
        return resultOf(
          cadEngine.preflight(request.label, parseOperations(request.operations, document), 'agent', request.expectedRevision),
        )
      } catch (cause) {
        return json(toErrorEnvelope(cause, { currentRevision: document.revision }))
      }
    },
  },
  {
    name: 'proposal_create',
    description: 'Alias for build_preflight used when the intent is explicitly to leave a translucent, human-reviewable ghost edit.',
    inputSchema: jsonSchemaOf(PreflightSchema),
    execute: (input) => proposalTools[0].execute(input),
  },
]

const buildTools: ToolDefinition[] = [
  {
    name: 'build_apply',
    description: 'Atomically commit a current, collision-free preflight proposal through the same command bus used by the human editor.',
    inputSchema: jsonSchemaOf(ApplySchema),
    execute: (input) => {
      const document = cadEngine.getDocument()
      try {
        const request = ApplySchema.parse(input)
        assertExpectations(request, profileContext())
        return resultOf(cadEngine.applyProposal(request.proposalId, 'agent'))
      } catch (cause) {
        return json(toErrorEnvelope(cause, { currentRevision: document.revision }))
      }
    },
  },
  {
    name: 'builder_feedback_respond',
    description: 'Respond to a spatial builder note at an exact document revision.',
    inputSchema: schema({ expectedRevision: revisionProperty, noteId: { type: 'string' }, response: { type: 'string' }, resolved: { type: 'boolean' } }, ['expectedRevision', 'noteId', 'response']),
    execute: (input) => {
      const request = input as { expectedRevision: number; noteId: string; response: string; resolved?: boolean }
      return resultOf(cadEngine.execute('Respond to builder note', [{ type: 'note.respond', noteId: request.noteId, response: request.response, resolved: request.resolved }], 'agent', request.expectedRevision, 'builder_feedback_respond'))
    },
  },
  {
    name: 'undo_edit',
    description: 'Undo the latest shared CAD transaction. Human and agent edits use the same monotonic history.',
    inputSchema: schema({}),
    execute: () => resultOf(cadEngine.undo('agent')),
  },
  {
    name: 'redo_edit',
    description: 'Redo the latest undone shared CAD transaction.',
    inputSchema: schema({}),
    execute: () => resultOf(cadEngine.redo('agent')),
  },
  {
    name: 'action_mutate',
    description: 'Run a discovered long-tail mutation through Brickwright’s revisioned command bus.',
    inputSchema: schema({ action: { type: 'string' }, expectedRevision: revisionProperty, args: { type: 'object' } }, ['action', 'expectedRevision']),
    execute: (input) => {
      const request = input as { action: string; expectedRevision: number; args?: Record<string, unknown> }
      const state = cadEngine.getSnapshot()
      const definition = sharedCapability(request.action)
      if (!definition || definition.kind !== 'mutate') {
        return json({ error: { code: 'INVALID_OPERATION', message: `Unknown mutation ${request.action}`, repair: 'Call capabilities_search and capabilities_help.' } })
      }
      try {
        const plan = planSharedMutation(definition.id, request.args, {
          document: state.document,
          selection: state.selection,
          actor: 'agent',
        })
        const result = cadEngine.execute(plan.label, [...plan.operations], 'agent', request.expectedRevision, 'action_mutate')
        if (result.ok && plan.nextSelection) cadEngine.setSelection([...plan.nextSelection])
        return result.ok
          ? json({ ...result.value, capability: plan.capability, summary: plan.summary, selection: plan.nextSelection ?? state.selection })
          : resultOf(result)
      } catch (cause) {
        const error = cause instanceof SharedCapabilityError
          ? new ContractError(cause.code, cause.message, cause.repair, cause.details)
          : cause
        return json(toErrorEnvelope(error, { currentRevision: state.document.revision }))
      }
    },
  },
]

export class WebMcpAdapter {
  private baseController?: AbortController
  private modeController?: AbortController
  private fallbackTools = new Map<string, ToolDefinition>()
  private unsubscribe?: () => void
  private lastMode?: string

  private register(tool: ToolDefinition, signal?: AbortSignal) {
    this.fallbackTools.set(tool.name, tool)
    signal?.addEventListener('abort', () => this.fallbackTools.delete(tool.name), { once: true })
    if (document.modelContext) {
      try {
        document.modelContext.registerTool(tool, signal ? { signal } : undefined)
      } catch {
        // The fallback bridge remains available in browsers without the exact draft signature.
      }
    }
  }

  start() {
    this.baseController?.abort()
    this.baseController = new AbortController()
    for (const tool of readTools) this.register(tool, this.baseController.signal)
    this.refreshMode()
    this.unsubscribe = cadEngine.subscribe(() => this.refreshMode())
    window.brickwright = {
      tools: this.fallbackTools,
      invoke: async (name, input = {}) => {
        const tool = this.fallbackTools.get(name)
        if (!tool) throw new Error(`Brickwright tool ${name} is not registered in ${cadEngine.getSnapshot().autonomy} mode.`)
        return tool.execute(input)
      },
      getDocument: () => cadEngine.getDocument(),
    }
  }

  private refreshMode() {
    const mode = cadEngine.getSnapshot().autonomy
    if (mode === this.lastMode) return
    this.lastMode = mode
    this.modeController?.abort()
    this.modeController = new AbortController()
    if (mode === 'propose' || mode === 'build') {
      for (const tool of proposalTools) this.register(tool, this.modeController.signal)
    }
    if (mode === 'build') {
      for (const tool of buildTools) this.register(tool, this.modeController.signal)
    }
  }

  stop() {
    this.baseController?.abort()
    this.modeController?.abort()
    this.unsubscribe?.()
    this.fallbackTools.clear()
    this.lastMode = undefined
    delete window.brickwright
  }

  getStatus() {
    return {
      native: Boolean(document.modelContext),
      toolCount: this.fallbackTools.size,
      mode: cadEngine.getSnapshot().autonomy,
    }
  }
}

export const webMcpAdapter = new WebMcpAdapter()
