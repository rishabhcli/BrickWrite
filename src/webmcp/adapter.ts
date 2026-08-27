import { catalog } from '../cad/catalog'
import { basisFromEulerDegrees, IDENTITY_BASIS, isOrthonormal, orthonormalize, type Mat3 } from '../cad/math'
import { buildBom } from '../cad/bom'
import { cadEngine } from '../cad/engine'
import { exportLDraw, exportMpd } from '../cad/ldraw'
import { findWeakAttachments } from '../cad/validation'
import type { Actor, CadOperation, ModelDocument, PartInstance, Transform, Vec3 } from '../cad/types'

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

function normalizeVec3(value: unknown, fallback: Vec3 = [0, 0, 0]): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !Number.isFinite(item))) return fallback
  return [value[0], value[1], value[2]]
}

/**
 * Resolves the orientation an agent supplied.
 *
 * `basis` is the exact form the kernel stores: a row-major orthonormal 3×3, the
 * same nine numbers an LDraw type-1 line carries. `rotation` remains accepted
 * as Euler degrees because it is far easier to write by hand, but it is
 * converted immediately — the document never stores angles. A basis that is not
 * orthonormal is rejected rather than silently shearing the part.
 */
function normalizeBasis(item: Record<string, unknown>, fallback: Mat3): Mat3 {
  const raw = item.basis
  if (Array.isArray(raw) && raw.length === 9 && raw.every((value) => Number.isFinite(value))) {
    const candidate = raw as unknown as Mat3
    if (!isOrthonormal(candidate, 1e-4)) {
      throw new Error('basis must be an orthonormal row-major 3x3 matrix')
    }
    return orthonormalize(candidate)
  }
  if (Array.isArray(item.rotation)) return basisFromEulerDegrees(normalizeVec3(item.rotation))
  return fallback
}

function normalizeOperations(raw: unknown, document: ModelDocument): CadOperation[] {
  if (!Array.isArray(raw)) throw new Error('operations must be an array')
  return raw.map((candidate, index) => {
    const item = candidate as Record<string, unknown>
    const op = String(item.op ?? item.type ?? '')
    if (op === 'add') {
      const definitionId = String(item.definitionId)
      // An unknown or unplaceable definition is *not* rejected here. The
      // operation is built and handed to the kernel so the agent receives the
      // kernel's specific, actionable error (PART_DEFINITION_NOT_FOUND or
      // GEOMETRY_UNAVAILABLE) rather than a generic adapter failure.
      const definition = catalog.get(definitionId)
      const id = String(item.partId ?? `agent_${Date.now().toString(36)}_${index}`)
      const subassemblyId = String(item.subassemblyId ?? Object.keys(document.subassemblies)[0] ?? 'main')
      const stepId = String(item.stepId ?? document.steps.at(-1)?.id ?? 'step_1')
      const part: PartInstance = {
        id,
        definitionId,
        color: Number(item.color ?? definition?.availableColors[0] ?? 71),
        transform: { position: normalizeVec3(item.position), basis: normalizeBasis(item, IDENTITY_BASIS) },
        subassemblyId,
        stepId,
        provenance: 'agent',
        protected: false,
      }
      return { type: 'part.add', part }
    }
    if (op === 'move' || op === 'transform') {
      const partId = String(item.partId)
      const current = document.parts[partId]
      return {
        type: 'part.transform',
        partId,
        transform: {
          position: normalizeVec3(item.position, current?.transform.position),
          basis: normalizeBasis(item, current?.transform.basis ?? IDENTITY_BASIS),
        },
      }
    }
    if (op === 'remove') return { type: 'part.remove', partId: String(item.partId) }
    if (op === 'recolor') return { type: 'part.recolor', partId: String(item.partId), color: Number(item.color) }
    if (op === 'protect') return { type: 'part.protect', partId: String(item.partId), protected: Boolean(item.protected) }
    throw new Error(`Unsupported operation ${op || index}`)
  })
}

/** Reflects a transform through the plane x = `axis`. */
function mirrorTransformAcrossX(transform: Transform, axis: number): Transform {
  const b = transform.basis
  return {
    position: [axis - (transform.position[0] - axis), transform.position[1], transform.position[2]],
    basis: [-b[0], b[1], b[2], -b[3], b[4], b[5], -b[6], b[7], b[8]],
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
    inputSchema: schema({
      text: { type: 'string' },
      category: { type: 'string' },
      maxStuds: { type: 'object', description: 'Maximum envelope: { width, height, depth }. Width/depth in studs, height in plates.' },
      minStuds: { type: 'object', description: 'Minimum envelope: { width, height, depth }.' },
      connectorTypes: { type: 'array', items: { type: 'string' } },
      colors: { type: 'array', items: { type: 'integer' }, description: 'Only parts with observed official-set appearances in every listed LDraw colour.' },
      requireGeometry: { type: 'boolean', description: 'Restrict to parts that can actually be placed in this build.' },
      includeHelpers: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const results = cadEngine.getCatalog(input as Parameters<typeof cadEngine.getCatalog>[0])
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
      const requestId = `capture_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
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
      const capabilities = [
        { id: 'export_ldraw', kind: 'read', summary: 'Export the exact current document as LDraw text.' },
        { id: 'export_bom', kind: 'read', summary: 'Return an aggregated bill of materials with LDraw and BrickLink identities.' },
        { id: 'selection_connected', kind: 'read', summary: 'Inspect the currently connected component.' },
        { id: 'duplicate_selection', kind: 'mutate', summary: 'Duplicate selected parts by an exact LDU offset.' },
        { id: 'mirror_selection', kind: 'mutate', summary: 'Mirror selected transforms across the X axis.' },
        { id: 'respond_to_note', kind: 'mutate', summary: 'Attach an agent response to a spatial builder note.' },
        { id: 'export_mpd', kind: 'read', summary: 'Export the document as a multi-part MPD with one submodel per subassembly.' },
        { id: 'catalog_coverage', kind: 'read', summary: 'Report exactly what the compiled catalog knows: identity, geometry, connection and colour coverage.' },
        { id: 'weak_attachments', kind: 'read', summary: 'List parts held by a single connector, the classic will-fall-off warning.' },
      ]
      return json(capabilities.filter((capability) => `${capability.id} ${capability.summary}`.toLowerCase().includes(query)))
    },
  },
  {
    name: 'capabilities_help',
    description: 'Get the input contract for one long-tail CAD capability.',
    inputSchema: schema({ capability: { type: 'string' } }, ['capability']),
    annotations: { readOnlyHint: true },
    execute: (input) => {
      const capability = String((input as { capability: string }).capability)
      const help: Record<string, unknown> = {
        export_ldraw: { call: 'action_read', input: { action: 'export_ldraw' } },
        export_bom: { call: 'action_read', input: { action: 'export_bom' } },
        duplicate_selection: { call: 'action_mutate', input: { action: 'duplicate_selection', expectedRevision: 'integer', offsetLdu: '[x,y,z]' } },
        mirror_selection: { call: 'action_mutate', input: { action: 'mirror_selection', expectedRevision: 'integer', axisLdu: 'number, default 0' } },
        respond_to_note: { call: 'action_mutate', input: { action: 'respond_to_note', expectedRevision: 'integer', noteId: 'string', response: 'string' } },
        export_mpd: { call: 'action_read', input: { action: 'export_mpd' } },
        catalog_coverage: { call: 'action_read', input: { action: 'catalog_coverage' } },
        weak_attachments: { call: 'action_read', input: { action: 'weak_attachments' } },
      }
      return json(help[capability] ?? { error: 'UNKNOWN_CAPABILITY', repair: 'Call capabilities_search with a task-oriented query.' })
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
      return json({ error: 'UNKNOWN_ACTION', repair: 'Call capabilities_search and capabilities_help.' })
    },
  },
]

const proposalTools: ToolDefinition[] = [
  {
    name: 'build_preflight',
    description: 'Dry-run an atomic batch of real CAD operations. Checks revision, protected regions, catalog identity, colors, collision, connectivity, constraints, and produces a visible ghost proposal without mutating the document.',
    inputSchema: schema({
      expectedRevision: revisionProperty,
      label: { type: 'string' },
      operations: { type: 'array', items: { type: 'object' }, maxItems: 500 },
    }, ['expectedRevision', 'label', 'operations']),
    execute: (input) => {
      const request = input as { expectedRevision: number; label: string; operations: unknown[] }
      try {
        return resultOf(cadEngine.preflight(request.label, normalizeOperations(request.operations, cadEngine.getDocument()), 'agent', request.expectedRevision))
      } catch (cause) {
        return json({ error: { code: 'INVALID_OPERATION', message: String(cause), repair: 'Call catalog_search and capabilities_help, then correct the operation payload.' } })
      }
    },
  },
  {
    name: 'proposal_create',
    description: 'Alias for build_preflight used when the intent is explicitly to leave a translucent, human-reviewable ghost edit.',
    inputSchema: schema({ expectedRevision: revisionProperty, label: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } } }, ['expectedRevision', 'label', 'operations']),
    execute: (input) => proposalTools[0].execute(input),
  },
]

const buildTools: ToolDefinition[] = [
  {
    name: 'build_apply',
    description: 'Atomically commit a current, collision-free preflight proposal through the same command bus used by the human editor.',
    inputSchema: schema({ proposalId: { type: 'string' } }, ['proposalId']),
    execute: (input) => resultOf(cadEngine.applyProposal(String((input as { proposalId: string }).proposalId), 'agent')),
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
      if (request.action === 'duplicate_selection') {
        const offset = normalizeVec3(request.args?.offsetLdu, [20, 0, 0])
        const operations: CadOperation[] = state.selection.map((id, index) => {
          const source = state.document.parts[id]
          return {
            type: 'part.add',
            part: {
              ...structuredClone(source),
              id: `agent_copy_${Date.now().toString(36)}_${index}`,
              transform: { ...source.transform, position: source.transform.position.map((value, axis) => value + offset[axis]) as unknown as Vec3 },
              provenance: 'agent',
              protected: false,
            },
          }
        })
        return resultOf(cadEngine.execute('Duplicate selection', operations, 'agent', request.expectedRevision, 'action_mutate'))
      }
      if (request.action === 'mirror_selection') {
        const axis = Number(request.args?.axisLdu ?? 0)
        const operations: CadOperation[] = state.selection.map((id) => {
          const source = state.document.parts[id]
          return {
            type: 'part.transform',
            partId: id,
            // Mirroring across a plane negates one basis column, which flips
            // the basis handedness exactly as LDraw expects for a mirrored
            // reference.
            transform: mirrorTransformAcrossX(source.transform, axis),
          }
        })
        return resultOf(cadEngine.execute('Mirror selection', operations, 'agent', request.expectedRevision, 'action_mutate'))
      }
      return json({ error: { code: 'INVALID_OPERATION', message: `Unknown action ${request.action}`, repair: 'Call capabilities_search and capabilities_help.' } })
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
