import { detail } from './detail'
import { reinforce } from './reinforce'
import { restack } from './restack'
import { simplify } from './simplify'
import { smooth } from './smooth'
import { substitute } from './substitute'
import { symmetrize } from './symmetrize'
import type { ObjectiveId } from '../types'
import type { Strategy, StrategyId } from './support'

/**
 * The generators, and what each of them is for.
 *
 * `targets` is not decoration: it is how a free-form instruction reaches a
 * strategy without a language model in the loop. "Strengthen the overhang" maps
 * to objectives, objectives map to strategies, and the search runs the ones that
 * could plausibly move the weights the request cares about — so the deterministic
 * path and the model-assisted path select from exactly the same registry.
 */

export interface StrategyEntry {
  readonly id: StrategyId
  readonly label: string
  readonly run: Strategy
  /** Objectives this generator exists to improve. */
  readonly targets: readonly ObjectiveId[]
  readonly summary: string
}

export const STRATEGIES: readonly StrategyEntry[] = [
  {
    id: 'restack',
    label: 'Re-lay course',
    run: restack,
    targets: ['seamBonding', 'weakConnections'],
    summary: 'Re-partitions a course so its joints stop lining up with the one below.',
  },
  {
    id: 'substitute',
    label: 'Swap element',
    run: substitute,
    targets: ['rarityScore', 'distinctElements', 'paletteConformance'],
    summary: 'Replaces an element with a more ordinary one that carries the same live connectors.',
  },
  {
    id: 'reinforce',
    label: 'Bridge attachment',
    run: reinforce,
    targets: ['weakConnections', 'overhangLoad', 'supportMargin'],
    summary: 'Lays a plate or bracket across a loose part and its neighbour, verified by the snap solver.',
  },
  {
    id: 'smooth',
    label: 'Close stepped edge',
    run: smooth,
    targets: ['steppedEdges', 'silhouetteFidelity'],
    summary: 'Replaces a stepped part with a slope or curve of the same footprint.',
  },
  {
    id: 'symmetrize',
    label: 'Mirror region',
    run: symmetrize,
    targets: ['symmetryError'],
    summary: 'Adds the missing counterparts across the region’s best mirror plane, honouring exceptions.',
  },
  {
    id: 'simplify',
    label: 'Merge run',
    run: simplify,
    targets: ['partCount', 'seamBonding', 'buildOrderComplexity'],
    summary: 'Consolidates a run of identical short elements into fewer longer ones.',
  },
  {
    id: 'detail',
    label: 'Finish surface',
    run: detail,
    targets: ['exposedStuds'],
    summary: 'Tiles free studs on an existing surface without moving the outline.',
  },
]

export const STRATEGY_IDS: readonly StrategyId[] = STRATEGIES.map((entry) => entry.id)

export const strategyById = (id: string): StrategyEntry | undefined =>
  STRATEGIES.find((entry) => entry.id === id)

/** Generators whose targets intersect the objectives a request actually weights. */
export function strategiesFor(weights: Partial<Record<ObjectiveId, number>>): StrategyEntry[] {
  const wanted = new Set(
    (Object.entries(weights) as Array<[ObjectiveId, number]>)
      .filter(([, weight]) => typeof weight === 'number' && weight > 0)
      .map(([id]) => id),
  )
  if (!wanted.size) return [...STRATEGIES]
  const selected = STRATEGIES.filter((entry) => entry.targets.some((target) => wanted.has(target)))
  // A weight vector that touches nothing any generator can move is a caller
  // error, not a reason to return an empty plan, so every generator runs.
  return selected.length ? selected : [...STRATEGIES]
}

export { detail, reinforce, restack, simplify, smooth, substitute, symmetrize }
export type { Strategy, StrategyId } from './support'
