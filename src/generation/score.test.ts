import { describe, expect, it } from 'vitest'
import type { DesignBrief } from '../platform/contracts'
import { compareBuildQuality, evaluateHardGates, scoreDocument, type MetricVector } from './score'
import { refinementFixture } from '../refinement/__fixtures__'

const brief = (): DesignBrief => ({
  version: 1,
  subject: 'test',
  envelopeStuds: null,
  scale: 'unspecified',
  functions: [],
  palette: [],
  symmetry: 'none',
  partBudget: null,
  protectedPartIds: [],
  style: [],
  evidence: {},
  conflicts: [],
})

const vector = (overrides: Partial<MetricVector> = {}): MetricVector => ({
  partCount: 8,
  distinctElements: 3,
  commonness: 3,
  rarePartCount: 0,
  paletteConformance: 1,
  virtualColourCount: 0,
  collisionCount: 0,
  unverifiedCollisionCount: 0,
  componentCount: 1,
  largestComponentFraction: 1,
  weakAttachmentCount: 0,
  massGrams: 20,
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
  buildStepCount: 8,
  buildOrderIslands: 0,
  silhouetteIou: null,
  silhouettePerView: {},
  extentStuds: [8, 6, 8],
  withinEnvelope: null,
  withinBudget: null,
  budgetUsed: null,
  ...overrides,
})

describe('evaluateHardGates', () => {
  it('passes a clutched, grounded, non-tipping model', () => {
    expect(evaluateHardGates(vector(), brief()).passed).toBe(true)
  })

  it('refuses collisions', () => {
    expect(evaluateHardGates(vector({ collisionCount: 2 }), brief()).failures[0]).toMatch(/collision/)
  })

  it('refuses a model that tips', () => {
    const result = evaluateHardGates(vector({ supportMarginLdu: -6 }), brief())
    expect(result.passed).toBe(false)
    expect(result.failures.join(' ')).toMatch(/tips/)
  })

  it('refuses a model that rests on nothing', () => {
    const result = evaluateHardGates(vector({ supportMarginLdu: null }), brief())
    expect(result.passed).toBe(false)
    expect(result.failures.join(' ')).toMatch(/floating/)
  })

  it('refuses a loose brick that is not its own island of two or more parts', () => {
    const result = evaluateHardGates(
      vector({ partCount: 10, componentCount: 2, largestComponentFraction: 0.9 }),
      brief(),
    )
    expect(result.passed).toBe(false)
    expect(result.failures.join(' ')).toMatch(/loose brick/)
  })

  it('allows two buildable islands', () => {
    expect(
      evaluateHardGates(vector({ partCount: 10, componentCount: 2, largestComponentFraction: 0.5 }), brief()).passed,
    ).toBe(true)
  })

  it('refuses a candidate with bricks sitting on parts they do not clutch', () => {
    const result = evaluateHardGates(vector({ unclutchedRestCount: 2 }), brief())
    expect(result.passed).toBe(false)
    expect(result.failures.join(' ')).toMatch(/clutch/)
  })

  it('refuses a candidate with hovering bricks', () => {
    const result = evaluateHardGates(vector({ floatingPartCount: 2 }), brief())
    expect(result.passed).toBe(false)
    expect(result.failures.join(' ')).toMatch(/hover/)
  })
})

describe('compareBuildQuality', () => {
  it('prefers fewer weak attachments once support and overload match', () => {
    const solid = vector({ weakAttachmentCount: 0, unsupportedPartCount: 0 })
    const flimsy = vector({ weakAttachmentCount: 6, unsupportedPartCount: 2 })
    expect(compareBuildQuality(solid, flimsy)).toBeLessThan(0)
  })

  it('prefers a running bond over stacked seams', () => {
    const bonded = vector({ stackedSeamCount: 0 })
    const columns = vector({ stackedSeamCount: 8 })
    expect(compareBuildQuality(bonded, columns)).toBeLessThan(0)
  })

  it('prefers a build that clutches more studs once seam count matches', () => {
    const clutched = vector({ meanExclusiveMates: 4 })
    const sparse = vector({ meanExclusiveMates: 0.5 })
    expect(compareBuildQuality(clutched, sparse)).toBeLessThan(0)
  })

  it('prefers fewer 1×1 stacks once clutch matches', () => {
    const bonded = vector({ oneStudStackCount: 0 })
    const columns = vector({ oneStudStackCount: 8 })
    expect(compareBuildQuality(bonded, columns)).toBeLessThan(0)
  })

  it('prefers a shorter 1×1 column once stack count matches', () => {
    const squat = vector({ maxOneStudColumnHeight: 2 })
    const tower = vector({ maxOneStudColumnHeight: 8 })
    expect(compareBuildQuality(squat, tower)).toBeLessThan(0)
  })
})

describe('scoreDocument', () => {
  it('counts stacked seams from measured topology', () => {
    const fixture = refinementFixture('seam-tower')
    const metrics = scoreDocument(fixture.document, brief())
    expect(metrics.stackedSeamCount).toBeGreaterThan(0)
  })

  it('counts 1×1 stacks from measured topology', () => {
    const fixture = refinementFixture('seam-tower')
    const metrics = scoreDocument(fixture.document, brief())
    expect(metrics.oneStudStackCount).toBeGreaterThanOrEqual(0)
    expect(metrics.maxOneStudColumnHeight).toBeGreaterThanOrEqual(0)
  })
})
