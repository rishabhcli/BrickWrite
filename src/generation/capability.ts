import { STUD_LDU } from '../cad/catalog'
import {
  assemblyPlacement,
  registerGenerationPlanner,
  SharedCapabilityError,
  type SharedMutationContext,
  type SharedMutationPlan,
} from '../cad/capabilities'
import { getDocumentBounds, getPartBounds } from '../cad/geometry'
import { hash32, type DesignBrief } from '../platform/contracts'
import type { PartInstance, Vec3 } from '../cad/types'
import { compileBriefDeterministically } from './brief'
import { candidateOperations } from './engine'
import { evaluateHardGates, compareBuildQuality } from './score'
import { runPipelineSync, STRATEGIES, type Candidate } from './phases'

/**
 * Generation as two entries in the shared human/agent vocabulary.
 *
 * The model-facing path is the `generation_*` tool family, which can consult a
 * model for the massing and hands back several candidates to choose between.
 * These two capabilities are the deterministic floor underneath it: they run
 * without a network, they plan synchronously like every other capability in
 * `planSharedMutation`, and they exist so that "build me a tower" is a *listed
 * action* in `capability_search` rather than something only a model that
 * already knew about generation could find.
 *
 * Both refuse rather than half-deliver. A brief that produces no operations is
 * an empty wave, and an empty wave that reports success is worse than a refusal
 * with the reason in it.
 */

const clampStuds = (value: number, min = 3, max = 64): number =>
  Math.max(min, Math.min(max, Math.round(value)))

const asStuds = (ldu: number): number => ldu / STUD_LDU

function briefFor(args: Record<string, unknown>, overrides: Partial<DesignBrief> = {}): DesignBrief {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) {
    throw new SharedCapabilityError('INVALID_OPERATION', 'A generation prompt is required.', 'Describe what to build in a sentence.')
  }
  const brief = compileBriefDeterministically(prompt)
  const envelope = args.envelopeStuds as [number, number, number] | undefined
  const partBudget = typeof args.partBudget === 'number' ? args.partBudget : null
  return {
    ...brief,
    ...(envelope ? { envelopeStuds: envelope } : {}),
    ...(partBudget ? { partBudget } : {}),
    ...overrides,
  }
}

/**
 * The best of `count` candidates, or a refusal naming what the gates caught.
 *
 * Candidates that fail a hard gate are not silently dropped and then reported
 * as "nothing generated": if every one failed, the refusal carries the first
 * reason, because "your budget was 40 parts" and "the pipeline is broken" are
 * different problems and only one of them is the caller's to fix.
 */
function bestCandidate(
  brief: DesignBrief,
  base: SharedMutationContext['document'],
  options: {
    count: number
    originLdu?: Vec3
    constraints?: Parameters<typeof runPipelineSync>[1]['constraints']
    /** Measured against this instead of `brief`. See `PipelineOptions.scoreAgainst`. */
    scoreAgainst?: DesignBrief
  },
): Candidate {
  const seedRoot = hash32(`${brief.subject}|${JSON.stringify(brief.envelopeStuds)}|${brief.partBudget}`) >>> 0
  const accepted: Candidate[] = []
  const failures: string[] = []

  for (let index = 0; index < options.count; index += 1) {
    const strategy = STRATEGIES[index % STRATEGIES.length]!.id
    const candidate = runPipelineSync(brief, {
      seed: (seedRoot + index) >>> 0,
      strategy,
      base,
      idPrefix: `gc${seedRoot.toString(36)}${index}`,
      ...(options.originLdu ? { originLdu: options.originLdu } : {}),
      ...(options.constraints ? { constraints: options.constraints } : {}),
      ...(options.scoreAgainst ? { scoreAgainst: options.scoreAgainst } : {}),
    })
    const gates = evaluateHardGates(candidate.metrics, options.scoreAgainst ?? brief)
    if (gates.passed) accepted.push(candidate)
    else failures.push(`${strategy}: ${gates.failures.join('; ')}`)
  }

  const winner = accepted.sort((a, b) => compareBuildQuality(a.metrics, b.metrics))[0]
  if (!winner) {
    throw new SharedCapabilityError(
      'INVALID_OPERATION',
      `No candidate passed the hard gates. ${failures[0] ?? 'The pipeline produced nothing.'}`,
      'Widen the envelope or raise partBudget, or call the generation_run tool to search with a model and compare candidates.',
      { failures },
    )
  }
  return winner
}

function planFromBrief(args: Record<string, unknown>, context: SharedMutationContext): SharedMutationPlan {
  if (args.useModel === true) {
    throw new SharedCapabilityError(
      'INVALID_OPERATION',
      'generate_from_brief is the deterministic path and cannot consult a model.',
      'Call the generation_compile and generation_run tools instead; generation_run takes useModel.',
    )
  }
  const brief = briefFor(args)
  const count = typeof args.candidateCount === 'number' ? Math.max(1, Math.min(6, Math.round(args.candidateCount))) : 1
  const candidate = bestCandidate(brief, context.document, { count })
  const operations = candidateOperations(candidate)
  if (!operations.some((operation) => operation.type === 'part.add')) {
    throw new SharedCapabilityError(
      'INVALID_OPERATION',
      `The pipeline produced no parts for “${brief.subject}”.`,
      'Give the subject an envelope — "a 24 x 20 stud workshop, 3 storeys" — or call generation_compile to see what the brief actually said.',
      { notes: candidate.notes },
    )
  }
  return {
    capability: 'generate_from_brief',
    label: `Generated: ${brief.subject}`,
    operations,
    summary: `${candidate.metrics.partCount} parts from the ${candidate.strategy} strategy, in one transaction.`,
    report: {
      subject: brief.subject,
      strategy: candidate.strategy,
      structuralHash: candidate.structuralHash,
      parts: candidate.metrics.partCount,
      collisions: candidate.metrics.collisionCount,
      components: candidate.metrics.componentCount,
      envelopeStuds: brief.envelopeStuds,
      partBudget: brief.partBudget,
      conflicts: brief.conflicts,
      notes: candidate.notes.slice(0, 12),
    },
  }
}

/**
 * The measured extent a region defaults to.
 *
 * The anchor's own assembly, not the whole document and not the single brick:
 * "add a boarding ramp to this wing" means a region the size of the wing. A
 * builder who wants something else passes `envelopeStuds` and gets exactly
 * that.
 */
function measuredEnvelope(context: SharedMutationContext, anchor: PartInstance | null): [number, number, number] {
  const scope = anchor
    ? (context.document.subassemblies[anchor.subassemblyId]?.partIds ?? [anchor.id])
        .map((id) => context.document.parts[id])
        .filter((part): part is PartInstance => Boolean(part))
    : []
  if (!scope.length) return [16, 12, 16]

  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const part of scope) {
    const bounds = getPartBounds(part)
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], bounds.min[axis])
      max[axis] = Math.max(max[axis], bounds.max[axis])
    }
  }
  return [
    clampStuds(asStuds(max[0] - min[0])),
    clampStuds(asStuds(max[1] - min[1]), 3, 96),
    clampStuds(asStuds(max[2] - min[2])),
  ]
}

function planRegion(args: Record<string, unknown>, context: SharedMutationContext): SharedMutationPlan {
  const { origin, anchor } = assemblyPlacement(context, args)
  const envelope = (args.envelopeStuds as [number, number, number] | undefined) ?? measuredEnvelope(context, anchor)
  const existing = Object.keys(context.document.parts)
  const brief = briefFor({ ...args, envelopeStuds: envelope }, { protectedPartIds: existing })

  // The realiser's envelope check measures the whole document, so a region
  // envelope on its own would refuse every placement on any model already
  // bigger than the region. The bound that means what it says here is "the
  // existing extent, plus room for the region".
  const documentSize = existing.length ? getDocumentBounds(context.document).size : [0, 0, 0]
  const allowed: [number, number, number] = [
    Math.ceil(asStuds(documentSize[0]) + envelope[0]),
    Math.ceil(asStuds(documentSize[1]) + envelope[1]),
    Math.ceil(asStuds(documentSize[2]) + envelope[2]),
  ]

  // Massed to the region, measured against the model it joins: extent and
  // budget are properties of the whole document once the region lands in it.
  const gateBrief: DesignBrief = {
    ...brief,
    envelopeStuds: allowed,
    partBudget: brief.partBudget === null ? null : existing.length + brief.partBudget,
  }

  const candidate = bestCandidate(brief, context.document, {
    count: 1,
    originLdu: origin,
    scoreAgainst: gateBrief,
    constraints: {
      envelopeStuds: allowed,
      protectedPartIds: existing,
      ...(brief.partBudget ? { partBudget: brief.partBudget } : {}),
      ...(brief.palette.length ? { palette: brief.palette } : {}),
    },
  })

  // The build order is the whole document's, and replacing it would resequence
  // parts this capability promised not to touch. A region contributes parts.
  const operations = candidateOperations(candidate).filter((operation) => operation.type !== 'steps.replace')
  const added = operations.filter((operation) => operation.type === 'part.add').length
  if (!added) {
    throw new SharedCapabilityError(
      'INVALID_OPERATION',
      `Nothing could be placed in the ${envelope.join(' × ')}-stud region at ${origin.map(Math.round).join(', ')}: every candidate part collided with the model already there or found nothing to clutch onto.`,
      'Anchor on a part with a free face — scene_query reports approaches — or widen envelopeStuds so the region clears the existing build.',
      { notes: candidate.notes, envelopeStuds: envelope, originLdu: origin },
    )
  }

  return {
    capability: 'generate_region',
    label: `Generated into region: ${brief.subject}`,
    operations,
    summary: `${added} part(s) added${anchor ? ` onto ${anchor.id}` : ''}; ${existing.length} existing part(s) left untouched.`,
    report: {
      subject: brief.subject,
      strategy: candidate.strategy,
      parts: added,
      documentParts: candidate.metrics.partCount,
      originLdu: origin,
      envelopeStuds: envelope,
      anchorPartId: anchor?.id ?? null,
      protectedPartIds: existing.length,
      notes: candidate.notes.slice(0, 12),
    },
  }
}

registerGenerationPlanner((capability, args, context) =>
  capability === 'generate_from_brief' ? planFromBrief(args, context) : planRegion(args, context),
)
