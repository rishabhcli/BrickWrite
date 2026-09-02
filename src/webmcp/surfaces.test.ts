import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { IDENTITY_BASIS } from '../cad/math'
import { createBlankDocument, createShowcaseDocument } from '../cad/sample'
import { session } from '../cad/session'
import type { CadOperation, PartInstance } from '../cad/types'
import { getGenerationSession } from '../generation/mcpHost'
import type { GenerationRun } from '../generation/engine'
import type { Candidate } from '../generation/phases'
import type { MetricVector } from '../generation/score'
import type { GenerationRunner } from '../generation/session'
import { getRefinementSession } from '../refinement/mcpHost'
import { OBJECTIVE_IDS, type MetricVector as RefineMetrics, type RefinementProposalV1 } from '../refinement/types'
import type { RefinementRunner } from '../refinement/session'
import type { SearchReport } from '../refinement/search'
import { WebMcpAdapter } from './adapter'
import { peekPreparedPublication } from './surfaces/shareHost'
import {
  resetChrome,
  setChromeRevealHandler,
  setModelHealthHandler,
  setProposalReviewHandler,
  setWorkspaceFocusHandler,
  setConnectSteerHandler,
  mergeConnectSteer,
} from './chrome'

const ARMCHAIR = 'A green armchair 6 x 6 studs, 6 studs tall, at most 90 pieces'

const adapter = new WebMcpAdapter()

beforeEach(() => {
  adapter.stop()
  cadEngine.replaceDocument(createShowcaseDocument())
  cadEngine.setAutonomy('inspect')
})

afterEach(() => {
  adapter.stop()
  resetChrome()
  cadEngine.replaceDocument(createShowcaseDocument())
})

const invoke = async (name: string, input: unknown = {}) => {
  const result = await window.brickwright?.invoke(name, input)
  return result?.structuredContent as Record<string, unknown>
}

const errorOf = (payload: Record<string, unknown>) =>
  (payload.error as { code: string; message: string; repair: string; currentRevision?: number } | undefined) ?? null

const metrics = (partCount: number): MetricVector => ({
  partCount,
  distinctElements: 1,
  commonness: 1,
  rarePartCount: 0,
  paletteConformance: 1,
  virtualColourCount: 0,
  collisionCount: 0,
  unverifiedCollisionCount: 0,
  componentCount: 1,
  largestComponentFraction: 1,
  weakAttachmentCount: 0,
  massGrams: 2.3,
  massCoverage: 1,
  supportMarginLdu: 12,
  overloadedJointCount: 0,
  unsupportedPartCount: 0,
  unclutchedRestCount: 0,
  floatingPartCount: 0,
  stackedSeamCount: 0,
  meanExclusiveMates: 2,
  oneStudStackCount: 0,
  maxOneStudColumnHeight: 1,
  buildOrderValid: true,
  buildOrderViolations: 0,
  buildStepCount: 1,
  buildOrderIslands: 0,
  silhouetteIou: null,
  silhouettePerView: {},
  extentStuds: [4, 3, 2],
  withinEnvelope: true,
  withinBudget: true,
  budgetUsed: 0.1,
})

const brickPart = (): PartInstance => ({
  id: 'gen_brick',
  definitionId: '3001',
  color: 2,
  transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
  subassemblyId: 'main',
  stepId: 'step_1',
  provenance: 'agent',
  protected: false,
})

const brickRun = (): GenerationRun => {
  const part = brickPart()
  const operations: CadOperation[] = [{ type: 'part.add', part }]
  const empty = createBlankDocument('Generated')
  const candidate: Candidate = {
    id: 'cand_brick',
    strategy: 'test-brick',
    seed: 0,
    graph: { version: 1, strategy: 'test-brick', nodes: [], edges: [] },
    structuralHash: 'hash_brick',
    realize: {
      operations,
      document: empty,
      nodes: [],
      edges: [],
      partCount: 1,
      truncated: false,
      notes: [],
      graphViolations: [],
    },
    document: empty,
    metrics: metrics(1),
    phases: [],
    notes: [],
    inference: { requests: 0, inputTokens: 0, outputTokens: 0 },
    boxes: [],
    continuation: null,
  }
  return {
    promptHash: 'test',
    provenance: { provider: 'deterministic', model: null, promptHash: 'test', seed: 0, createdAt: new Date().toISOString() },
    settings: { candidates: 1, repairBudget: 0, strategies: ['test-brick'], constraints: null },
    candidates: [candidate],
    rejected: [],
    failed: [],
    inference: { requests: 0, inputTokens: 0, outputTokens: 0 },
    distinctHashes: 1,
    elapsedMs: 1,
    notes: [],
  }
}

const replayBrick: GenerationRunner = async () => brickRun()

const refineZeros = (): RefineMetrics =>
  Object.fromEntries(OBJECTIVE_IDS.map((id) => [id, 0])) as RefineMetrics

const recolorRunner = (color: number): RefinementRunner => async (request) => {
  const partId = request.scopePartIds[0]
  const proposal: RefinementProposalV1 = {
    version: 1,
    id: 'prop_recolor',
    requestId: request.id,
    baseRevision: request.baseRevision,
    strategy: 'recolor-test',
    label: 'Recolor the selection',
    operations: [{ type: 'part.recolor', partId, color }],
    changedPartIds: [partId],
    metrics: { before: refineZeros(), after: refineZeros(), delta: refineZeros() },
    score: 1,
    regressions: [],
    warnings: [],
    overlay: [],
    provenance: { provider: 'test', model: null, promptHash: 'test', seed: 0, createdAt: new Date().toISOString() },
    status: 'ranked',
    rejection: null,
  }
  const report: SearchReport = {
    evaluated: 1,
    generated: 1,
    elapsedMs: 0,
    aborted: false,
    budgetExhausted: false,
    strategiesRun: ['recolor-test'],
    strategiesSkipped: [],
    baseMetrics: refineZeros(),
    weights: refineZeros(),
    reference: { width: 1, height: 1, mask: [1], frameMin: [0, 0, 0], frameMax: [1, 1, 1] },
  }
  return { proposals: [proposal], report, rankingRationale: 'test runner', ranOn: 'inline' }
}

describe('WebMCP surface inventory', () => {
  const inspectOnly = [
    'part_intent_resolve',
    'project_list',
    'generation_state',
    'refinement_analyse',
    'share_prepare',
    'workspace_reveal',
    'workspace_focus',
    'workspace_connect',
  ]
  const inspectHidden = ['generation_apply', 'project_open', 'refinement_apply', 'share_fork_to_project']
  const proposeOnly = ['generation_preview', 'refinement_select']
  const buildOnly = ['generation_apply', 'project_open', 'refinement_apply', 'share_fork_to_project']

  it('exposes the new Inspect tools and withholds Build mutations', () => {
    adapter.start()
    for (const name of inspectOnly) expect(window.brickwright?.tools.has(name)).toBe(true)
    for (const name of inspectHidden) expect(window.brickwright?.tools.has(name)).toBe(false)
    for (const name of proposeOnly) expect(window.brickwright?.tools.has(name)).toBe(false)
  })

  it('registers preview in Propose and apply/open in Build, then revokes them', () => {
    adapter.start()
    cadEngine.setAutonomy('propose')
    expect(window.brickwright?.tools.has('generation_preview')).toBe(true)
    expect(window.brickwright?.tools.has('refinement_select')).toBe(true)
    expect(window.brickwright?.tools.has('generation_apply')).toBe(false)
    expect(window.brickwright?.tools.has('project_open')).toBe(false)

    cadEngine.setAutonomy('build')
    for (const name of [...proposeOnly, ...buildOnly]) expect(window.brickwright?.tools.has(name)).toBe(true)

    cadEngine.setAutonomy('inspect')
    for (const name of [...proposeOnly, ...buildOnly]) expect(window.brickwright?.tools.has(name)).toBe(false)
    expect(window.brickwright?.tools.has('part_intent_resolve')).toBe(true)
  })

  it('advertises compact surface status on workspace_get', async () => {
    adapter.start()
    const workspace = await invoke('workspace_get')
    expect(workspace.toolProfile).toBe('brickwright.tools/3')
    expect(workspace.surfaces).toMatchObject({
      generation: { briefPhase: 'idle', runPhase: 'idle', candidateCount: 0, selectedCandidateId: null, ghost: false },
      refinement: { status: 'idle', proposalCount: 0, selectedId: null },
      project: { id: cadEngine.getDocument().id },
      share: { slug: null, contentHash: null },
      feedback: { open: 1, resolved: 0, total: 1 },
      model: {
        assemblies: Object.keys(cadEngine.getDocument().subassemblies).length,
        parts: cadEngine.getSnapshot().validation.partCount,
        selected: 0,
      },
      review: { pending: 0, blocked: 0 },
      health: { kernelBlockers: 0, fullScan: 'call validate_model' },
    })
    expect(workspace.chrome).toBeNull()
  })

  it('opens a named dock section through workspace_reveal', async () => {
    adapter.start()
    const seen: string[] = []
    setChromeRevealHandler((surface) => {
      seen.push(surface)
    })
    const revealed = await invoke('workspace_reveal', { surface: 'generation' })
    expect(seen).toEqual(['generation'])
    expect(revealed).toMatchObject({
      surface: 'generation',
      applied: true,
      dock: 'right',
      section: 'generation.panel',
    })
  })

  it('lets an agent reveal Connect and name the mate target', async () => {
    adapter.start()
    const seen: string[] = []
    setChromeRevealHandler((surface) => seen.push(surface))
    const revealed = await invoke('workspace_reveal', { surface: 'connect' })
    expect(seen).toEqual(['connect'])
    expect(revealed).toMatchObject({
      surface: 'connect',
      applied: true,
      dock: 'right',
      section: 'connect',
    })
  })

  it('lets an agent pick a Connect stage and solution, not only reveal the sheet', async () => {
    adapter.start()
    const seen: string[] = []
    setChromeRevealHandler((surface) => seen.push(surface))
    setConnectSteerHandler((request) => mergeConnectSteer(null, request, (id) => id === 'part_a' || id === 'part_b'))
    const steered = await invoke('workspace_connect', {
      sourcePartId: 'part_a',
      targetPartId: 'part_b',
      candidateIndex: 2,
    })
    expect(seen).toEqual(['connect'])
    expect(steered).toMatchObject({
      applied: true,
      connect: { stage: 'review', sourcePartId: 'part_a', targetPartId: 'part_b', candidateIndex: 2 },
    })
  })

  it('lets an agent reveal the same bottom-dock feedback inbox a human uses', async () => {
    adapter.start()
    const seen: string[] = []
    setChromeRevealHandler((surface) => seen.push(surface))

    const revealed = await invoke('workspace_reveal', { surface: 'feedback' })

    expect(seen).toEqual(['feedback'])
    expect(revealed).toMatchObject({
      surface: 'feedback',
      applied: true,
      dock: 'bottom',
      section: null,
    })
  })

  it('lets an agent focus exact model context in the same map a human uses', async () => {
    adapter.start()
    const partIds = Object.keys(cadEngine.getDocument().parts).slice(0, 2)
    const seen: Array<{ partIds?: readonly string[]; mode: string }> = []
    setChromeRevealHandler(() => undefined)
    setWorkspaceFocusHandler((request) => {
      seen.push(request)
      return {
        requestedCount: request.partIds?.length ?? 0,
        matchedCount: request.partIds?.length ?? 0,
        selectedPartIds: request.partIds ?? [],
        missingPartIds: [],
        subassemblyFound: null,
        truncated: false,
      }
    })

    const revision = cadEngine.getDocument().revision
    const focused = await invoke('workspace_focus', { partIds, mode: 'isolate' })

    expect(seen).toEqual([{ partIds, mode: 'isolate' }])
    expect(focused).toMatchObject({
      applied: true,
      mode: 'isolate',
      matchedCount: 2,
      selectedPartIds: partIds,
      revealed: { surface: 'model', dock: 'right', section: 'model.explorer' },
    })
    expect(cadEngine.getDocument().revision).toBe(revision)
  })

  it('lets an agent focus a pending ghost without accepting or rejecting it', async () => {
    adapter.start()
    const seen: Array<string | undefined> = []
    setChromeRevealHandler(() => undefined)
    setProposalReviewHandler((proposalId) => {
      seen.push(proposalId)
      return { activeProposalId: proposalId ?? null, found: true, pending: 2 }
    })
    const revision = cadEngine.getDocument().revision

    const focused = await invoke('workspace_reveal', { surface: 'review', focusId: 'proposal_exact' })

    expect(seen).toEqual(['proposal_exact'])
    expect(focused).toMatchObject({
      applied: true,
      activeProposalId: 'proposal_exact',
      found: true,
      pending: 2,
      revealed: { surface: 'review', dock: 'bottom', section: null },
    })
    expect(cadEngine.getDocument().revision).toBe(revision)
    expect(cadEngine.getSnapshot().transactions).toHaveLength(0)
  })

  it('lets an agent focus the same exact Model Health issue a human navigates', async () => {
    adapter.start()
    const seen: Array<string | undefined> = []
    setChromeRevealHandler(() => undefined)
    setModelHealthHandler((issueId) => {
      seen.push(issueId)
      return {
        activeIssueId: issueId ?? null,
        found: issueId === 'collision:pair_a_b',
        revision: cadEngine.getDocument().revision,
        blockers: 1,
        warnings: 0,
        selectedPartIds: ['part_0001', 'part_0002'],
        truncated: false,
      }
    })
    const revision = cadEngine.getDocument().revision

    const focused = await invoke('workspace_reveal', { surface: 'health', focusId: 'collision:pair_a_b' })

    expect(seen).toEqual(['collision:pair_a_b'])
    expect(focused).toMatchObject({
      applied: true,
      activeIssueId: 'collision:pair_a_b',
      selectedPartIds: ['part_0001', 'part_0002'],
      revealed: { surface: 'health', dock: 'right', section: 'inspector' },
    })
    expect(cadEngine.getDocument().revision).toBe(revision)
    expect(cadEngine.getSnapshot().transactions).toHaveLength(0)
  })
})

describe('part_intent_resolve', () => {
  it('resolves a 2 x 4 brick to placeable 3001 without loading the semantic index', async () => {
    adapter.start()
    const result = await invoke('part_intent_resolve', { query: '2 x 4 brick', semantic: false })
    const matches = result.matches as Array<{ canonicalId: string; placeable: boolean; tier: string; confidence: number }>
    expect(matches.some((match) => match.canonicalId === '3001' && match.placeable)).toBe(true)
    const brick = matches.find((match) => match.canonicalId === '3001')
    expect(brick?.confidence).toBeGreaterThan(0)
    expect(brick).toEqual(
      expect.objectContaining({
        canonicalId: '3001',
        placeable: true,
        tier: expect.any(String),
        explanation: expect.any(String),
      }),
    )
    expect(JSON.stringify(result)).not.toMatch(/operations|document\.parts/)
  })
})

describe('project tools', () => {
  let sequence = 0

  beforeEach(async () => {
    sequence += 1
    cadEngine.replaceDocument({
      ...createShowcaseDocument(),
      id: `doc_webmcp_${sequence}`,
      name: `WebMCP ${sequence}`,
    })
    for (const project of await session.listProjects()) {
      if (project.projectId !== session.currentProjectId) await session.deleteProject(project.projectId)
    }
    adapter.start()
  })

  it('creates a project that project_list then contains', async () => {
    cadEngine.setAutonomy('build')
    const created = await invoke('project_create', { name: `Agent study ${sequence}` })
    expect(created.ok).toBe(true)
    expect(created.projectId).toBe(session.currentProjectId)

    cadEngine.setAutonomy('inspect')
    const listed = await invoke('project_list')
    const ids = (listed.projects as Array<{ projectId: string; name: string }>).map((project) => project.projectId)
    expect(ids).toContain(created.projectId)
    expect(listed.currentProjectId).toBe(created.projectId)
  })

  it('refuses to delete the open project', async () => {
    cadEngine.setAutonomy('build')
    const created = await invoke('project_create', { name: `Keep ${sequence}` })
    const openId = created.projectId as string
    const refused = await invoke('project_delete', { projectId: openId })
    expect(errorOf(refused)?.code).toBe('OPEN_PROJECT')
    expect((await session.listProjects()).map((project) => project.projectId)).toContain(openId)
  })

  it('does not register project_open in Inspect', () => {
    adapter.start()
    expect(window.brickwright?.tools.has('project_open')).toBe(false)
  })
})

describe('generation tools', () => {
  beforeEach(() => {
    cadEngine.replaceDocument(createBlankDocument('Generation WebMCP'))
    adapter.start()
    getGenerationSession({ tickMs: 0, runner: replayBrick })
  })

  it('compiles locally, runs without a model, previews in Propose and applies as an agent in Build', async () => {
    const compiled = await invoke('generation_compile', { prompt: ARMCHAIR, useModel: false })
    expect(compiled.briefPhase).toBe('ready')
    expect(compiled.brief).toMatchObject({ subject: expect.any(String) })
    for (const field of (compiled.unresolvedConflicts as string[] | undefined) ?? []) {
      await invoke('generation_set', { conflict: { field, choice: 'compiler' } })
    }

    await invoke('generation_set', { candidateCount: 1 })
    const ran = await invoke('generation_run', { useModel: false })
    expect(ran.runPhase).toBe('ready')
    expect(ran.usedModel).toBe(false)
    const candidates = ran.candidates as Array<{ id: string; document?: unknown; operations?: unknown }>
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ id: 'cand_brick', strategy: 'test-brick', partCount: 1 })
    expect(candidates[0].document).toBeUndefined()
    expect(candidates[0].operations).toBeUndefined()
    expect(ran.revealed).toMatchObject({ surface: 'generation', dock: 'right', section: 'generation.panel' })

    expect(window.brickwright?.tools.has('generation_apply')).toBe(false)
    await expect(window.brickwright?.invoke('generation_apply', {})).rejects.toThrow(/not registered/)

    cadEngine.setAutonomy('propose')
    const preview = await invoke('generation_preview', { candidateId: 'cand_brick' })
    expect(preview.ghost).toMatchObject({ candidateId: 'cand_brick', collisions: 0 })
    expect(preview.revealed).toMatchObject({ surface: 'generation', section: 'generation.panel' })
    const before = cadEngine.getDocument().revision

    cadEngine.setAutonomy('build')
    const applied = await invoke('generation_apply', { expectedRevision: before })
    expect(applied.outcome).toMatchObject({ kind: 'applied' })
    expect(applied.documentRevision).toBe(before + 1)
    expect(cadEngine.getDocument().revision).toBe(before + 1)
    expect(cadEngine.getSnapshot().transactions.at(-1)).toMatchObject({
      author: 'agent',
      sourceTool: 'generation_apply',
    })
    expect(cadEngine.getDocument().parts.gen_brick).toBeDefined()
  })

  it('redacts a stale expectedRevision through the error envelope', async () => {
    await invoke('generation_compile', { prompt: ARMCHAIR, useModel: false })
    const compiled = await invoke('generation_state')
    for (const field of (compiled.unresolvedConflicts as string[] | undefined) ?? []) {
      await invoke('generation_set', { conflict: { field, choice: 'compiler' } })
    }
    await invoke('generation_set', { candidateCount: 1 })
    await invoke('generation_run', { useModel: false })
    cadEngine.setAutonomy('propose')
    await invoke('generation_preview', { candidateId: 'cand_brick' })
    cadEngine.setAutonomy('build')
    const stale = await invoke('generation_apply', { expectedRevision: 99 })
    expect(errorOf(stale)).toMatchObject({
      code: 'STALE_DOCUMENT',
      repair: expect.any(String),
      currentRevision: cadEngine.getDocument().revision,
    })
    expect(JSON.stringify(stale)).not.toMatch(/\/home\/|Bearer |stack/i)
  })
})

describe('refinement tools', () => {
  beforeEach(() => {
    adapter.start()
    getRefinementSession({ tickMs: 0, runner: recolorRunner(4) })
  })

  it('refuses an empty selection without partIds', async () => {
    cadEngine.setSelection([])
    const refused = await invoke('refinement_analyse', {})
    expect(errorOf(refused)?.code).toBe('INVALID_INPUT')
    expect(errorOf(refused)?.repair).toMatch(/partIds/i)
  })

  it('analyses a selection, proposes, and applies one agent transaction', async () => {
    const part = Object.values(cadEngine.getDocument().parts).find((entry) => !entry.protected)!
    const partId = part.id
    const colour = part.color === 4 ? 14 : 4
    getRefinementSession({ tickMs: 0, runner: recolorRunner(colour) })
    const analysed = await invoke('refinement_analyse', { partIds: [partId] })
    expect(analysed.scopePartIds).toEqual(expect.arrayContaining([partId]))
    expect(typeof analysed.issueCount).toBe('number')

    const proposed = await invoke('refinement_propose', { partIds: [partId], effort: 'quick' })
    expect(proposed.status).toBe('ready')
    const proposals = proposed.proposals as Array<{ id: string; operations?: unknown }>
    expect(proposals[0]).toMatchObject({ id: 'prop_recolor', operationCount: 1 })
    expect(proposals[0].operations).toBeUndefined()
    expect(proposed.revealed).toMatchObject({ surface: 'refinement', section: 'refinement.panel' })

    cadEngine.setAutonomy('propose')
    const selected = await invoke('refinement_select', { proposalId: 'prop_recolor' })
    expect(selected.revealed).toMatchObject({ surface: 'refinement', applied: false })

    cadEngine.setAutonomy('build')
    const before = cadEngine.getDocument().revision
    const applied = await invoke('refinement_apply', { expectedRevision: before })
    expect(applied.outcome).toMatchObject({ kind: 'applied' })
    expect(cadEngine.getDocument().revision).toBe(before + 1)
    expect(cadEngine.getSnapshot().transactions.at(-1)).toMatchObject({
      author: 'agent',
      sourceTool: 'refinement_apply',
    })
    expect(cadEngine.getDocument().parts[partId].color).toBe(colour)
  })
})

describe('share tools', () => {
  it('freezes an immutable publication whose hash survives a live edit', async () => {
    adapter.start()
    const prepared = await invoke('share_prepare', { title: 'Rover freeze' })
    expect(prepared.slug).toEqual(expect.any(String))
    expect(prepared.contentHash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/))
    expect(prepared.document).toBeUndefined()
    expect(prepared.cards).toBeUndefined()
    const hash = prepared.contentHash as string
    const revision = prepared.revision

    cadEngine.execute('Rename after freeze', [{ type: 'document.rename', name: 'Mutated live document' }], 'human')
    expect(cadEngine.getDocument().name).toBe('Mutated live document')
    expect(peekPreparedPublication()?.contentHash).toBe(hash)
    expect(peekPreparedPublication()?.revision).toBe(revision)
    expect(peekPreparedPublication()?.document.revision).toBe(revision)
  })

  it('forks the last prepared snapshot into a new project in Build', async () => {
    adapter.start()
    const prepared = await invoke('share_prepare', { title: 'Fork source' })
    cadEngine.setAutonomy('build')
    const forked = await invoke('share_fork_to_project', { name: 'Forked from share' })
    expect(forked.projectId).toBe(session.currentProjectId)
    expect(forked.projectId).not.toBe(createShowcaseDocument().id)
    expect(cadEngine.getDocument().name).toBe('Forked from share')
    expect(forked.sourceSlug).toBe(prepared.slug)
    expect(forked.provenance).toMatchObject({ slug: prepared.slug })
  })
})
