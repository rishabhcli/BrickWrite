import { catalog, getColor, STUD_LDU } from './catalog'
import { analyseStatics, describeMass, describeSupport, hangingArmIssues } from './statics'
import type { ModelDocument, ValidationReport } from './types'
import {
  airbornePartIds,
  findWeakAttachments,
  unclutchedRestPartIds,
} from './validation'

export type ModelHealthSeverity = 'blocker' | 'warning' | 'notice'
export type ModelHealthIssueKind =
  | 'collision'
  | 'constraint'
  | 'grounding'
  | 'connection'
  | 'colour-evidence'
  | 'balance'
  | 'clutch-load'
  | 'measurement'

export interface ModelHealthIssue {
  readonly id: string
  readonly kind: ModelHealthIssueKind
  readonly severity: ModelHealthSeverity
  readonly title: string
  readonly detail: string
  readonly evidence: string
  readonly repair: string
  readonly partIds: readonly string[]
}

export interface ModelHealthCheck {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly status: 'pass' | 'warn' | 'fail'
}

export interface ModelHealthSummary {
  readonly revision: number
  readonly ready: boolean
  readonly blockers: number
  readonly warnings: number
  readonly notices: number
  readonly issues: readonly ModelHealthIssue[]
  readonly checks: readonly ModelHealthCheck[]
  readonly metrics: {
    readonly parts: number
    readonly connections: number
    readonly components: number
    readonly massGrams: number
    readonly massCoverage: number
    readonly supportMarginLdu: number | null
  }
}

const unique = (ids: readonly string[]) => [...new Set(ids)].sort()

const issueOrder: Record<ModelHealthSeverity, number> = {
  blocker: 0,
  warning: 1,
  notice: 2,
}

function constraintPartIds(document: ModelDocument, constraintId: string): string[] {
  const constraint = document.constraints.find((candidate) => candidate.id === constraintId)
  if (constraint?.kind !== 'palette') return []
  const allowed = constraint.value as number[]
  return Object.values(document.parts)
    .filter((part) => !allowed.includes(part.color))
    .map((part) => part.id)
    .sort()
}

/**
 * Turns the kernel's aggregate reports into a stable, navigable issue list.
 *
 * This is evidence, not another gate. CadEngine remains authoritative for
 * mutations; the same pure summary is consumed by the React inspector and by
 * WebMCP so a human and an agent cannot disagree about what an issue id means.
 * Statics is intentionally computed only when this explicit health view/tool
 * is opened, never on the edit path.
 */
export function inspectModelHealth(
  document: ModelDocument,
  validation: ValidationReport,
): ModelHealthSummary {
  const issues: ModelHealthIssue[] = []
  const allPartIds = Object.keys(document.parts).sort()

  for (const collision of validation.collisions) {
    const unverified = collision.certainty === 'unknown'
    issues.push({
      id: `collision:${collision.id}`,
      kind: 'collision',
      severity: unverified ? 'warning' : 'blocker',
      title: unverified ? 'Unverified overlap' : 'Confirmed collision',
      detail: collision.message,
      evidence: `${collision.partA} / ${collision.partB} · overlap ${collision.overlapLdu.join(' × ')} LDU · ${collision.certainty}`,
      repair: unverified
        ? 'Load both meshes and validate again before treating the overlap as physical.'
        : 'Move, replace, or reconnect one of the two highlighted parts, then validate again.',
      partIds: unique([collision.partA, collision.partB]),
    })
  }

  for (const constraint of validation.constraints.filter((item) => item.status !== 'pass')) {
    const partIds = constraintPartIds(document, constraint.id)
    issues.push({
      id: `constraint:${constraint.id}`,
      kind: 'constraint',
      severity: constraint.status === 'fail' ? 'blocker' : 'warning',
      title: constraint.label,
      detail: constraint.message,
      evidence: `Kernel constraint ${constraint.id} · ${constraint.status}`,
      repair: partIds.length
        ? 'Recolour the highlighted parts into the allowed palette, or revise the constraint through the shared command bus.'
        : 'Bring the build back inside the declared limit, or revise the constraint through the shared command bus.',
      partIds,
    })
  }

  const airborne = unique(airbornePartIds(document))
  if (airborne.length) {
    issues.push({
      id: 'grounding:airborne',
      kind: 'grounding',
      severity: 'warning',
      title: 'Assembly does not reach ground',
      detail: `${airborne.length} part${airborne.length === 1 ? '' : 's'} belong to a connected island with no load path to the ground plane.`,
      evidence: `${airborne.length} airborne · exact connection graph and measured bounds`,
      repair: 'Connect the highlighted island to grounded structure, or place it on the ground plane.',
      partIds: airborne,
    })
  }

  const unclutched = unique(unclutchedRestPartIds(document))
  if (unclutched.length) {
    issues.push({
      id: 'grounding:unclutched-rest',
      kind: 'grounding',
      severity: 'warning',
      title: 'Parts rest without clutch',
      detail: `${unclutched.length} part${unclutched.length === 1 ? '' : 's'} sit on other parts without a compatible engaged connector.`,
      evidence: `${unclutched.length} unclutched rest${unclutched.length === 1 ? '' : 's'} · measured contact planes`,
      repair: 'Move each highlighted part onto compatible free connectors, or redesign the supporting surface.',
      partIds: unclutched,
    })
  }

  if (validation.componentCount > 1) {
    issues.push({
      id: 'connection:separate-islands',
      kind: 'connection',
      severity: 'notice',
      title: 'Separate build islands',
      detail: `${validation.componentCount} connected components are present. Separate grounded models are legal, but the relationship should be intentional.`,
      evidence: `${validation.componentCount} components · ${validation.connectionCount} connector pairs`,
      repair: 'Inspect the secondary islands; connect them if this is intended to be one physical assembly.',
      partIds: unique(validation.disconnectedPartIds),
    })
  }

  if (validation.virtualColors.length) {
    const colors = unique(validation.virtualColors.map((entry) => String(entry.color)))
      .map((code) => getColor(Number(code)).name)
    issues.push({
      id: 'colour:virtual',
      kind: 'colour-evidence',
      severity: 'notice',
      title: 'Virtual colour choices',
      detail: `${validation.virtualColors.length} part${validation.virtualColors.length === 1 ? '' : 's'} use colours with no observed official-set appearance for that design.`,
      evidence: `${colors.slice(0, 4).join(', ')}${colors.length > 4 ? ` +${colors.length - 4}` : ''}`,
      repair: 'Keep the virtual colours intentionally, or recolour the highlighted parts to observed production combinations.',
      partIds: unique(validation.virtualColors.map((entry) => entry.partId)),
    })
  }

  const weak = findWeakAttachments(document)
  if (weak.length) {
    issues.push({
      id: 'connection:single-point',
      kind: 'connection',
      severity: 'notice',
      title: 'Single-point attachments',
      detail: `${weak.length} part${weak.length === 1 ? '' : 's'} are held by exactly one neighboring part. This can be intentional detail work, but deserves a pickup check.`,
      evidence: `${weak.length} one-neighbor attachment${weak.length === 1 ? '' : 's'}`,
      repair: 'Add a second attachment where strength matters, or leave intentional decorative details unchanged.',
      partIds: unique(weak.map((entry) => entry.partId)),
    })
  }

  const statics = analyseStatics(document)
  if (statics.support && !statics.support.stable) {
    issues.push({
      id: 'balance:outside-footprint',
      kind: 'balance',
      severity: 'blocker',
      title: 'Centre of mass leaves the footprint',
      detail: 'The measured centre of mass falls outside the support polygon, so the model tips under the current static assumptions.',
      evidence: `${(statics.support.marginLdu / STUD_LDU).toFixed(1)} studs margin · ${describeSupport(statics.support)} footprint`,
      repair: 'Widen the grounded footprint or move mass back over the support polygon.',
      partIds: allPartIds,
    })
  }

  const airborneSet = new Set(airborne)
  const unsupported = unique(statics.unsupportedPartIds.filter((id) => !airborneSet.has(id)))
  if (unsupported.length) {
    issues.push({
      id: 'grounding:unsupported-load-path',
      kind: 'grounding',
      severity: 'warning',
      title: 'No measured load path',
      detail: `${unsupported.length} part${unsupported.length === 1 ? ' is' : 's are'} not reached by the static load path from grounded structure.`,
      evidence: `${unsupported.length} unsupported · connector graph plus measured mass`,
      repair: 'Add a connected path to grounded structure and validate the result again.',
      partIds: unsupported,
    })
  }

  for (const [index, load] of statics.overloaded.entries()) {
    const arm = load.leverage
    issues.push({
      id: `clutch:${index}:${unique(load.hangingPartIds).slice(0, 3).join('-')}`,
      kind: 'clutch-load',
      severity: load.severity === 'over-capacity' ? 'blocker' : 'warning',
      title: arm ? 'Hanging load exceeds leverage margin' : 'Attachment load is marginal',
      detail: load.message,
      evidence: arm
        ? `${Math.round(arm.momentGramLdu)} / ${Math.round(arm.capacityGramLdu)} g·LDU moment`
        : `${load.grams.toFixed(1)} / ${load.capacityGrams.toFixed(1)} g assumed capacity`,
      repair: 'Add attachment points, shorten the hanging arm, or move mass closer to its anchors.',
      partIds: unique(load.partIds),
    })
  }

  if (statics.coverage < 0.999) {
    issues.push({
      id: 'measurement:mass-coverage',
      kind: 'measurement',
      severity: 'notice',
      title: 'Mass evidence is incomplete',
      detail: `${statics.mass.unmeasuredParts} part${statics.mass.unmeasuredParts === 1 ? '' : 's'} have no compiled volume and are excluded rather than estimated.`,
      evidence: `${Math.round(statics.coverage * 100)}% of parts measured by count`,
      repair: 'Treat balance and load conclusions as partial until compiled volume exists for the unmeasured parts.',
      partIds: allPartIds.filter((id) => {
        const definition = catalog.get(document.parts[id].definitionId)
        return !definition?.dimensions?.volumeLdu3
      }),
    })
  }

  issues.sort((a, b) => issueOrder[a.severity] - issueOrder[b.severity] || a.id.localeCompare(b.id))
  const blockers = issues.filter((issue) => issue.severity === 'blocker').length
  const warnings = issues.filter((issue) => issue.severity === 'warning').length
  const notices = issues.filter((issue) => issue.severity === 'notice').length
  const failedConstraints = validation.constraints.filter((constraint) => constraint.status === 'fail').length
  const arms = hangingArmIssues(statics.overloaded)

  return {
    revision: validation.revision,
    ready: blockers === 0,
    blockers,
    warnings,
    notices,
    issues,
    checks: [
      {
        id: 'collision',
        label: 'Geometry',
        value: validation.collisions.length
          ? `${validation.collisions.length} overlap${validation.collisions.length === 1 ? '' : 's'}`
          : 'collision-free',
        status: validation.collisions.length
          ? validation.unverifiedCollisions === validation.collisions.length ? 'warn' : 'fail'
          : 'pass',
      },
      {
        id: 'connections',
        label: 'Connectivity',
        value: `${validation.connectionCount} mates · ${validation.componentCount} island${validation.componentCount === 1 ? '' : 's'}`,
        status: airborne.length || unclutched.length ? 'warn' : 'pass',
      },
      {
        id: 'balance',
        label: 'Balance',
        value: statics.support
          ? statics.support.stable
            ? `${(statics.support.marginLdu / STUD_LDU).toFixed(1)} studs margin`
            : 'outside footprint'
          : validation.partCount ? 'not measurable' : 'empty model',
        status: statics.support ? statics.support.stable ? 'pass' : 'fail' : validation.partCount ? 'warn' : 'pass',
      },
      {
        id: 'clutch',
        label: 'Clutch load',
        value: statics.overloaded.length
          ? `${statics.overloaded.length} load${statics.overloaded.length === 1 ? '' : 's'} · ${arms.length} lever${arms.length === 1 ? '' : 's'}`
          : 'within assumption',
        status: statics.overloaded.some((load) => load.severity === 'over-capacity')
          ? 'fail'
          : statics.overloaded.length ? 'warn' : 'pass',
      },
      {
        id: 'constraints',
        label: 'Constraints',
        value: validation.constraints.length
          ? `${validation.constraints.length - failedConstraints}/${validation.constraints.length} passing`
          : 'none declared',
        status: failedConstraints ? 'fail' : 'pass',
      },
      {
        id: 'evidence',
        label: 'Mass evidence',
        value: statics.mass.measuredParts
          ? `${describeMass(statics.mass.grams)} · ${Math.round(statics.coverage * 100)}% coverage`
          : 'nothing measured',
        status: statics.coverage >= 0.999 ? 'pass' : 'warn',
      },
    ],
    metrics: {
      parts: validation.partCount,
      connections: validation.connectionCount,
      components: validation.componentCount,
      massGrams: Math.round(statics.mass.grams * 10) / 10,
      massCoverage: Math.round(statics.coverage * 1000) / 1000,
      supportMarginLdu: statics.support ? Math.round(statics.support.marginLdu * 10) / 10 : null,
    },
  }
}
