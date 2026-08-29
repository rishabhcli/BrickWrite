import { describe, expect, it } from 'vitest'
import { catalog } from '../cad/catalog'
import { basisFromAxisAngle, IDENTITY_BASIS } from '../cad/math'
import { createEmptyDocument } from '../cad/sample'
import { analysePalette, analyseRegion, createScope, mutablePartIds, rarityOf } from './analyse'
import { canMirror, mirrorTransform } from './mirror'
import { MAX_WEIGHT, defaultWeights, improvementOf, measureAll, objectiveList, resolveWeights } from './objectives'
import { captureSilhouette, silhouetteArea, silhouetteFrame, silhouetteIou } from './silhouette'
import { extractRows, findFreeStuds, findStackedSeams, findStepEdges, matedLocalFeatures, maxOneStudColumnHeight, oneStudStackCount } from './topology'
import { OBJECTIVE_IDS } from './types'
import { refinementFixture } from './__fixtures__'
import { getDocumentBounds } from '../cad/geometry'

/**
 * Analysis produces located, measured findings — never prose.
 *
 * Each case below names the fixture it is reading, so a failure says which model
 * stopped being understood rather than that "analysis broke".
 */

const analysisOf = (fixtureId: string) => {
  const fixture = refinementFixture(fixtureId)
  const scope = createScope({
    partIds: fixture.scopePartIds,
    protectedPartIds: fixture.protectedPartIds,
    boundaryPartIds: fixture.boundaryPartIds,
    symmetryExceptionPartIds: fixture.symmetryExceptionPartIds,
  })
  return { fixture, scope, analysis: analyseRegion(fixture.document, scope) }
}

describe('every finding is typed and located', () => {
  it.each(['seam-wall', 'weak-antenna', 'stepped-shelf', 'rare-hull', 'palette-noise', 'symmetric-antenna'])(
    '%s',
    (fixtureId) => {
      const { fixture, analysis } = analysisOf(fixtureId)
      expect(analysis.issues.length).toBeGreaterThan(0)
      for (const issue of analysis.issues) {
        expect(issue.partIds.length).toBeGreaterThan(0)
        expect(issue.atLdu).toHaveLength(3)
        expect(issue.atLdu.every((value) => Number.isFinite(value))).toBe(true)
        expect(Number.isFinite(issue.measure)).toBe(true)
        expect(issue.objectives.length).toBeGreaterThan(0)
        for (const objective of issue.objectives) expect(OBJECTIVE_IDS).toContain(objective)
        expect(issue.detail.length).toBeGreaterThan(0)
        // Every part an issue names is real.
        for (const partId of issue.partIds) expect(fixture.document.parts[partId]).toBeDefined()
      }
      expect(new Set(analysis.issues.map((issue) => issue.id)).size).toBe(analysis.issues.length)
    },
  )
})

describe('specific defects are found where they were built', () => {
  it('finds the stacked joint in a wall whose courses all break at x = 0', () => {
    const { analysis } = analysisOf('seam-wall')
    expect(analysis.stackedSeams.length).toBeGreaterThan(0)
    for (const seam of analysis.stackedSeams) expect(Math.abs(seam.atLdu)).toBeLessThan(1)
    expect(analysis.issues.some((issue) => issue.kind === 'stacked-seam')).toBe(true)
  })

  it('finds single-stud attachments', () => {
    const { fixture, analysis } = analysisOf('weak-antenna')
    expect(analysis.weakAttachments.map((entry) => entry.partId).sort()).toEqual([...fixture.scopePartIds].sort())
    for (const entry of analysis.weakAttachments) expect(entry.connections).toBe(1)
  })

  it('finds the exposed tread on an outside face, and measures it in studs', () => {
    const { analysis } = analysisOf('stepped-shelf')
    expect(analysis.stepEdges.length).toBe(2)
    for (const step of analysis.stepEdges) {
      expect(step.treadStuds).toBeCloseTo(2, 3)
      expect(['-x', '+x']).toContain(step.side)
    }
  })

  it('does not call an internal shelf a stepped edge', () => {
    const fixture = refinementFixture('tile-recess')
    // The recess floor is surrounded on all four sides; nothing about it is an
    // outside step.
    expect(findStepEdges(fixture.document, [fixture.scopePartIds[0]])).toHaveLength(0)
  })

  it('ranks rarity by official-set appearances, not by name', () => {
    const { analysis } = analysisOf('rare-hull')
    const worst = analysis.rarity.worst[0]
    expect(worst.frequency).toBe(catalog.get(worst.definitionId)!.frequency)
    expect(worst.rarity).toBeCloseTo(rarityOf(worst.frequency), 9)
    // The grille tile is scarcer than the 2 × 4 brick holding it.
    const grille = analysis.rarity.worst.find((entry) => entry.definitionId === '2412b')!
    const brick = analysis.rarity.worst.find((entry) => entry.definitionId === '3001')!
    expect(grille.rarity).toBeGreaterThan(brick.rarity)
    expect(analysis.rarity.mean).toBeGreaterThan(0)
  })

  it('infers a palette from what the region uses and names the outlier', () => {
    const { fixture, analysis } = analysisOf('palette-noise')
    expect(analysis.palette.outlierPartIds).toHaveLength(1)
    const outlier = fixture.document.parts[analysis.palette.outlierPartIds[0]]
    expect(outlier.color).toBe(25)
    expect(analysis.palette.reference).toContain(71)
    expect(analysis.palette.reference).not.toContain(25)
    expect(analysis.palette.conformance).toBeCloseTo(10 / 11, 6)
  })

  it('honours the symmetry exception list', () => {
    const { fixture, analysis } = analysisOf('symmetric-antenna')
    expect(analysis.symmetry.axis).toBe(0)
    expect(analysis.symmetry.exceptedPartIds).toEqual(fixture.symmetryExceptionPartIds)
    expect(analysis.symmetry.unmatchedPartIds).not.toContain(fixture.symmetryExceptionPartIds[0])
    expect(analysis.symmetry.unmatchedPartIds).toHaveLength(1)
    expect(analysis.symmetry.error).toBeGreaterThan(0)
  })

  it('offers only free, upward studs for surface work', () => {
    const fixture = refinementFixture('tile-recess')
    const studs = findFreeStuds(fixture.document, [fixture.scopePartIds[0]])
    expect(studs).toHaveLength(8)
    const plane = studs[0].surfaceY
    for (const stud of studs) expect(stud.surfaceY).toBeCloseTo(plane, 6)
  })

  it('finds a run of identical short elements', () => {
    const { analysis } = analysisOf('micro-run-deck')
    expect(analysis.microRuns).toHaveLength(1)
    expect(analysis.microRuns[0].partIds).toHaveLength(8)
    expect(analysis.microRuns[0].lengthStuds).toBeCloseTo(8, 6)
  })

  it('states that no cost objective exists, because the catalog carries no price', () => {
    const { analysis } = analysisOf('rare-hull')
    expect(analysis.costBasis).toBe('unavailable-no-price-data')
    // Not an opinion: no compiled part record has a price-like field at all.
    for (const definition of catalog.placeable().slice(0, 40)) {
      for (const key of Object.keys(definition)) {
        expect(key.toLowerCase()).not.toMatch(/price|cost|msrp|value/)
      }
    }
    expect(OBJECTIVE_IDS).not.toContain('cost')
  })
})

describe('scope', () => {
  it('excludes locked, protected and boundary parts from what may be rewritten', () => {
    const locked = analysisOf('locked-cockpit')
    const mutable = mutablePartIds(locked.fixture.document, locked.scope)
    for (const partId of locked.fixture.document.subassemblies.cockpit.partIds) {
      expect(locked.fixture.scopePartIds).toContain(partId)
      expect(mutable).not.toContain(partId)
    }

    const flagged = analysisOf('protected-cap')
    expect(mutablePartIds(flagged.fixture.document, flagged.scope)).not.toContain(flagged.fixture.protectedPartIds[0])

    const hinge = analysisOf('mechanism-hinge-wall')
    const hingeScope = createScope({
      partIds: [...hinge.fixture.scopePartIds, ...hinge.fixture.boundaryPartIds],
      boundaryPartIds: hinge.fixture.boundaryPartIds,
    })
    for (const partId of hinge.fixture.boundaryPartIds) {
      expect(mutablePartIds(hinge.fixture.document, hingeScope)).not.toContain(partId)
    }
  })
})

describe('objectives', () => {
  it('publishes a direction, a scale and a description for every axis', () => {
    expect(objectiveList).toHaveLength(OBJECTIVE_IDS.length)
    for (const definition of objectiveList) {
      expect(['lower-is-better', 'higher-is-better']).toContain(definition.direction)
      expect(definition.scale).toBeGreaterThan(0)
      expect(definition.defaultWeight).toBeGreaterThanOrEqual(0)
      expect(definition.description.length).toBeGreaterThan(40)
      expect(definition.unit.length).toBeGreaterThan(0)
    }
  })

  it('signs improvement by the declared direction', () => {
    expect(improvementOf('partCount', 10, 6)).toBeGreaterThan(0)
    expect(improvementOf('partCount', 6, 10)).toBeLessThan(0)
    expect(improvementOf('seamBonding', 0.5, 1)).toBeGreaterThan(0)
    expect(improvementOf('seamBonding', 1, 0.5)).toBeLessThan(0)
  })

  it('clamps caller weights and keeps the rest at their defaults', () => {
    const resolved = resolveWeights({ seamBonding: 1e9, partCount: -4 })
    expect(resolved.seamBonding).toBe(MAX_WEIGHT)
    expect(resolved.partCount).toBe(0)
    expect(resolved.silhouetteFidelity).toBe(defaultWeights().silhouetteFidelity)
  })

  it('measures a complete vector for every fixture region', () => {
    const { fixture, scope } = analysisOf('roof-steps')
    const vector = measureAll(fixture.document, scope)
    expect(Object.keys(vector).sort()).toEqual([...OBJECTIVE_IDS].sort())
    for (const id of OBJECTIVE_IDS) expect(Number.isFinite(vector[id])).toBe(true)
    expect(vector.partCount).toBe(fixture.scopePartIds.length)
    expect(vector.silhouetteFidelity).toBe(1)
  })
})

describe('topology', () => {
  it('recovers courses from measured geometry, in both axes', () => {
    const fixture = refinementFixture('seam-tower')
    const rows = extractRows(fixture.document)
    const alongX = rows.filter((row) => row.axis === 'x' && row.members.length === 2)
    expect(alongX.length).toBe(3)
    for (const row of alongX) {
      expect(row.contiguous).toBe(true)
      expect(row.toLdu - row.fromLdu).toBeCloseTo(160, 6)
    }
    expect(findStackedSeams(rows).length).toBeGreaterThan(0)
  })

  it('measures the tallest 1×1 column from stacked 1×1 bricks', () => {
    const slim = (id: string, y: number) => ({
      id,
      definitionId: '3005',
      color: 15,
      transform: { position: [0, y, 0] as [number, number, number], basis: IDENTITY_BASIS },
      subassemblyId: 'hull',
      stepId: 'step_1',
      provenance: 'human' as const,
      protected: false,
    })
    const base = createEmptyDocument()
    const stacked = [slim('a', 0), slim('b', -24), slim('c', -48), slim('d', -72)]
    const document = {
      ...base,
      parts: Object.fromEntries(stacked.map((item) => [item.id, item])),
      subassemblies: { ...base.subassemblies, hull: { ...base.subassemblies.hull, partIds: stacked.map((item) => item.id) } },
    }
    expect(oneStudStackCount(document)).toBe(3)
    expect(maxOneStudColumnHeight(document)).toBe(4)
  })

  it('reports the local connectors an instance is actually mated through', () => {
    const fixture = refinementFixture('rare-hull')
    const tile = Object.values(fixture.document.parts).find((part) => part.definitionId === '2412b')!
    const used = matedLocalFeatures(fixture.document, tile.id)
    expect(used.length).toBeGreaterThan(0)
    for (const key of used) expect(key.startsWith('anti-stud:')).toBe(true)
    // The grille's bar is unused, so a plain tile is a legal replacement.
    expect(used.some((key) => key.startsWith('bar:'))).toBe(false)
  })
})

describe('mirroring', () => {
  it('reflects a pose without producing a left-handed part', () => {
    const fixture = refinementFixture('symmetric-antenna')
    const part = Object.values(fixture.document.parts).find((entry) => entry.definitionId === '3004')!
    const mirrored = mirrorTransform(part.transform, 0, 0)
    expect(mirrored.position[0]).toBeCloseTo(-part.transform.position[0], 6)
    expect(mirrored.position[1]).toBeCloseTo(part.transform.position[1], 6)
    const determinant =
      mirrored.basis[0] * (mirrored.basis[4] * mirrored.basis[8] - mirrored.basis[5] * mirrored.basis[7]) -
      mirrored.basis[1] * (mirrored.basis[3] * mirrored.basis[8] - mirrored.basis[5] * mirrored.basis[6]) +
      mirrored.basis[2] * (mirrored.basis[3] * mirrored.basis[7] - mirrored.basis[4] * mirrored.basis[6])
    expect(determinant).toBeGreaterThan(0)
  })

  it('refuses to mirror an off-lattice orientation', () => {
    const fixture = refinementFixture('symmetric-antenna')
    const partId = Object.keys(fixture.document.parts)[1]
    const tilted = {
      ...fixture.document,
      parts: {
        ...fixture.document.parts,
        [partId]: {
          ...fixture.document.parts[partId],
          transform: { ...fixture.document.parts[partId].transform, basis: basisFromAxisAngle([0, 1, 0], 0.3) },
        },
      },
    }
    expect(canMirror(tilted, partId, 0)).toBe(false)
  })
})

describe('silhouette', () => {
  it('is 1 against itself and drops when the model changes', () => {
    const fixture = refinementFixture('roof-steps')
    const frame = silhouetteFrame(getDocumentBounds(fixture.document))
    const full = captureSilhouette(fixture.document, frame)
    expect(silhouetteArea(full)).toBeGreaterThan(0)
    expect(silhouetteIou(full, full)).toBe(1)

    const half = captureSilhouette(fixture.document, frame, Object.keys(fixture.document.parts).slice(0, 3))
    expect(silhouetteIou(full, half)).toBeLessThan(1)
    expect(silhouetteIou(full, half)).toBeGreaterThan(0)
  })

  it('compares two empty outlines as identical rather than dividing by zero', () => {
    const fixture = refinementFixture('seam-wall')
    const frame = silhouetteFrame(getDocumentBounds(fixture.document))
    const empty = captureSilhouette(fixture.document, frame, [])
    expect(silhouetteArea(empty)).toBe(0)
    expect(silhouetteIou(empty, empty)).toBe(1)
  })
})

describe('palette analysis', () => {
  it('prefers a declared palette constraint over an inferred one', () => {
    const fixture = refinementFixture('palette-noise')
    const constrained = {
      ...fixture.document,
      constraints: [
        { id: 'c_palette', kind: 'palette' as const, label: 'Orange only', value: [25], hard: false },
      ],
    }
    const inferred = analysePalette(fixture.document, fixture.scopePartIds)
    const declared = analysePalette(constrained, fixture.scopePartIds)
    expect(inferred.reference).toContain(71)
    expect(declared.reference).toEqual([25])
    expect(declared.conformance).toBeLessThan(inferred.conformance)
  })
})
