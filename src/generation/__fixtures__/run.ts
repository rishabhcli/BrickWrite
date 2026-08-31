import { IDENTITY_BASIS } from '../../cad/math'
import { createBlankDocument } from '../../cad/sample'
import type { CadOperation, PartInstance } from '../../cad/types'
import type { GenerationRun } from '../engine'
import type { Candidate } from '../phases'
import type { MetricVector } from '../score'
import type { GenerationRunner } from '../session'

/**
 * A generation run with one brick in it.
 *
 * Every surface that drives generation — the panel, WebMCP, the Design Partner
 * — needs a run that is real enough to preview and apply but does not spend a
 * pipeline's worth of time or a model call. Injecting this as the session's
 * `runner` exercises the whole review path (ghost, wave, revision check)
 * against a candidate whose shape a test can assert exactly.
 */

export const passingMetrics = (partCount: number): MetricVector => ({
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

export const brickPart = (): PartInstance => ({
  id: 'gen_brick',
  definitionId: '3001',
  color: 2,
  transform: { position: [0, 0, 0], basis: IDENTITY_BASIS },
  subassemblyId: 'main',
  stepId: 'step_1',
  provenance: 'agent',
  protected: false,
})

export const brickRun = (): GenerationRun => {
  const operations: CadOperation[] = [{ type: 'part.add', part: brickPart() }]
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
    metrics: passingMetrics(1),
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

/** A session runner that answers with {@link brickRun} and never touches a model. */
export const replayBrick: GenerationRunner = async () => brickRun()
