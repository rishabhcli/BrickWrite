import { Box, Check, ChevronsLeft, ChevronsRight, Lock, RotateCcw, RotateCw, ShieldCheck, Unlock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { catalog, describeSize, getColor } from '../../cad/catalog'
import { basisFromEulerDegrees, eulerDegreesFromBasis } from '../../cad/math'
import { inspectModelHealth, type ModelHealthIssue, type ModelHealthSummary } from '../../cad/modelHealth'
import type { EngineSnapshot, PartDefinition, PartInstance, Transform, ValidationReport } from '../../cad/types'
import { Slot } from './ExtensionRegistry'
import { ModelHealthPanel } from './ModelHealthPanel'
import { NumberField } from './NumberField'
import { describeConnectHudLabel } from './ConnectPanel'
import type { ConnectFlow } from './useWorkbench'
import {
  applyLocks,
  canonicalisePose,
  referenceBasis,
  type AxisLocks,
  type ReferenceFrame,
} from './transform'

/** How many observed colours the inspector shows before offering the rest. */
const INSPECTOR_SWATCH_LIMIT = 18

export interface ArticulationControl {
  edgeId: string
  label: string
  family: string
  canRotate: boolean
  canSlide: boolean
  rotateStep: number
  slideStep: number
  movingCount: number
}

interface InspectorPanelProps {
  state: EngineSnapshot
  selectedPart?: PartInstance
  definition?: PartDefinition
  view?: InspectorView
  activeHealthIssueId?: string | null
  /** Joints the current selection can drive; empty for a rigid assembly. */
  articulation: ArticulationControl[]
  onViewChange?: (view: InspectorView) => void
  onActiveHealthIssue?: (issueId: string) => void
  onFocusHealthIssue?: (issue: ModelHealthIssue, mode: 'select' | 'frame' | 'isolate') => void
  onTransform: (partId: string, transform: Transform) => void
  onRecolor: (color: number) => void
  onProtect: (protect: boolean) => void
  onSelectIds: (ids: string[]) => void
  onArticulate: (edgeId: string, request: { rotateDegrees?: number; slideLdu?: number }) => void
  /** Two-stage Connect naming, so OBJECT does not pretend the kernel selection is the whole mate. */
  connect?: ConnectFlow
  locks?: AxisLocks
  frame?: ReferenceFrame
}

export type InspectorView = 'object' | 'validate'

const TABS: InspectorView[] = ['object', 'validate']

/**
 * Accessible name for the VALIDATE tab.
 *
 * The coloured dot is otherwise unnamed, and `inspectModelHealth` (statics)
 * stays off this path — it runs when the VALIDATE panel itself opens.
 * Kernel collisions and failed constraints are already on the snapshot.
 */
export function validateTabLabel(report: ValidationReport): string {
  const confirmed = report.collisions.filter((item) => item.certainty !== 'unknown').length
  const failed = report.constraints.filter((item) => item.status === 'fail').length
  const blockers = confirmed + failed
  if (blockers) {
    return `Validate, ${blockers} blocker${blockers === 1 ? '' : 's'}`
  }
  const watches =
    report.collisions.length - confirmed + report.constraints.filter((item) => item.status === 'warning').length
  if (watches) {
    return `Validate, ${watches} watch${watches === 1 ? '' : 'es'}`
  }
  // Statics stay off this path. Calling a kernel-clear document "healthy" here
  // is a lie the moment hanging bricks exist, so the closed tab only claims
  // what the snapshot actually ran.
  return 'Validate, kernel clear'
}

/** Tab name once VALIDATE is open — matches the health panel, including statics. */
export function validateTabLabelFromHealth(health: ModelHealthSummary): string {
  if (health.blockers) return `Validate, ${health.blockers} blocker${health.blockers === 1 ? '' : 's'}`
  if (health.warnings) return `Validate, ${health.warnings} watch${health.warnings === 1 ? '' : 'es'}`
  if (health.notices) return `Validate, ${health.notices} notice${health.notices === 1 ? '' : 's'}`
  return 'Validate, healthy'
}

/**
 * What the OBJECT tab should describe, from the kernel snapshot.
 *
 * The `selectedPart` prop is a convenience for single-part tests; it must not
 * win over a live selection, and it must not invent "nothing selected" when
 * the document still has part ids in `state.selection`.
 */
export function inspectorKernelParts(state: EngineSnapshot, selectedPart?: PartInstance): PartInstance[] {
  const fromKernel = state.selection
    .map((id) => state.document.parts[id])
    .filter((part): part is PartInstance => Boolean(part))
  if (fromKernel.length) return fromKernel
  return selectedPart ? [selectedPart] : []
}

export function InspectorPanel({
  state,
  selectedPart,
  definition,
  view,
  activeHealthIssueId,
  articulation,
  onViewChange,
  onActiveHealthIssue,
  onFocusHealthIssue,
  onTransform,
  onRecolor,
  onProtect,
  onSelectIds,
  onArticulate,
  connect,
  locks,
  frame = 'world',
}: InspectorPanelProps) {
  const [localView, setLocalView] = useState<InspectorView>('object')
  const [allColors, setAllColors] = useState(false)
  const tab = view ?? localView
  const setTab = (next: InspectorView) => {
    setLocalView(next)
    onViewChange?.(next)
  }
  const report = state.validation
  const kernelParts = inspectorKernelParts(state, selectedPart)
  const inspectPart = kernelParts.length === 1 ? kernelParts[0] : undefined
  const inspectDefinition = inspectPart
    ? definition && definition.canonicalId === inspectPart.definitionId
      ? definition
      : catalog.get(inspectPart.definitionId)
    : definition
  const health = useMemo(
    () => (tab === 'validate' ? inspectModelHealth(state.document, report) : null),
    [report, state.document, tab],
  )
  const validateName = health ? validateTabLabelFromHealth(health) : validateTabLabel(report)
  const validateReady = health ? health.ready : report.healthy
  const displayRotation = useMemo(
    () => (inspectPart ? eulerDegreesFromBasis(inspectPart.transform.basis) : ([0, 0, 0] as const)),
    [inspectPart],
  )
  const shownColors = useMemo(() => {
    const observed = inspectDefinition?.availableColors ?? []
    if (allColors || observed.length <= INSPECTOR_SWATCH_LIMIT) return observed
    const head = observed.slice(0, INSPECTOR_SWATCH_LIMIT)
    // The applied colour must stay visible even when the evidence order buries it.
    return inspectPart && observed.includes(inspectPart.color) && !head.includes(inspectPart.color)
      ? [...head.slice(0, INSPECTOR_SWATCH_LIMIT - 1), inspectPart.color]
      : head
  }, [allColors, inspectDefinition, inspectPart])
  return (
    <aside className="panel inspector-panel" aria-label="Selection inspector">
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label="Inspector views"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') {
            return
          }
          event.preventDefault()
          const current = TABS.indexOf(tab)
          const next =
            event.key === 'Home'
              ? TABS[0]
              : event.key === 'End'
                ? TABS[TABS.length - 1]
                : event.key === 'ArrowRight'
                  ? TABS[(current + 1) % TABS.length]
                  : TABS[(current - 1 + TABS.length) % TABS.length]
          setTab(next)
          requestAnimationFrame(() => document.getElementById(`inspector-tab-${next}`)?.focus())
        }}
      >
        <button
          id="inspector-tab-object"
          type="button"
          role="tab"
          aria-selected={tab === 'object'}
          aria-controls="inspector-object-panel"
          tabIndex={tab === 'object' ? 0 : -1}
          className={tab === 'object' ? 'active' : ''}
          onClick={() => setTab('object')}
        >
          OBJECT
        </button>
        <button
          id="inspector-tab-validate"
          type="button"
          role="tab"
          aria-selected={tab === 'validate'}
          aria-controls="inspector-validate-panel"
          tabIndex={tab === 'validate' ? 0 : -1}
          aria-label={validateName}
          className={tab === 'validate' ? 'active' : ''}
          onClick={() => setTab('validate')}
        >
          VALIDATE
          <span
            className={
              health ? (validateReady ? 'healthy-dot' : 'warning-dot') : validateReady ? 'kernel-dot' : 'warning-dot'
            }
            aria-hidden="true"
          />
        </button>
      </div>
      {tab === 'object' ? (
        inspectPart && inspectDefinition ? (
          <div
            className="inspector-scroll"
            role="tabpanel"
            id="inspector-object-panel"
            aria-labelledby="inspector-tab-object"
          >
            <section className="selection-identity">
              <div className="selected-glyph">
                <Box size={24} strokeWidth={1.4} />
              </div>
              <div>
                <span className="eyebrow">
                  {inspectDefinition.category} / {inspectDefinition.canonicalId}
                </span>
                <h3>{inspectDefinition.name}</h3>
                <p>
                  {inspectPart.id} · {describeSize(inspectDefinition)}
                </p>
              </div>
            </section>
            {connect && connect.sourcePartId && connect.stage !== 'source' ? (
              <p className="connect-mate-note">{describeConnectHudLabel(connect, state.document, 'Connect')}</p>
            ) : null}
            <section className="property-section">
              <header>
                <span>TRANSFORM</span>
                <em>WORLD · LDU</em>
              </header>
              <div className="fields-grid" data-position-frame="world">
                {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                  <NumberField
                    key={`p_${axis}_${inspectPart.id}`}
                    label={axis}
                    value={inspectPart.transform.position[index]}
                    suffix="LDU"
                    disabled={frame === 'world' && Boolean(locks?.[axis.toLowerCase() as 'x' | 'y' | 'z'])}
                    onCommit={(value) => {
                      const position = [...inspectPart.transform.position] as [number, number, number]
                      position[index] = value
                      const next = canonicalisePose({ ...inspectPart.transform, position })
                      onTransform(
                        inspectPart.id,
                        applyLocks(inspectPart.transform, next, locks ?? { x: false, y: false, z: false }, referenceBasis(inspectPart, frame)),
                      )
                    }}
                  />
                ))}
              </div>
              {/* Euler degrees are a display affordance only. The document
                  stores an exact basis; these fields decompose it for editing
                  and recompose on commit. */}
              <div className="fields-grid rotation-fields">
                {(['RX', 'RY', 'RZ'] as const).map((axis, index) => (
                  <NumberField
                    key={`r_${axis}_${inspectPart.id}`}
                    label={axis}
                    value={displayRotation[index]}
                    suffix="°"
                    onCommit={(value) => {
                      const rotation = [...displayRotation] as [number, number, number]
                      rotation[index] = value
                      onTransform(inspectPart.id, {
                        position: inspectPart.transform.position,
                        basis: basisFromEulerDegrees(rotation),
                      })
                    }}
                  />
                ))}
              </div>
            </section>
            <section className="property-section">
              <header>
                <span>COLOR</span>
                <em>{getColor(inspectPart.color).name}</em>
              </header>
              {/* A part observed in 61 official colours produced a wall of
                  unlabelled circles. The evidence order puts the common ones
                  first, so the list is capped and the rest are one click away —
                  with the colour actually applied always shown. */}
              <div className="swatches inspector-swatches">
                {shownColors.map((code) => {
                  const color = getColor(code)
                  return (
                    <button
                      key={code}
                      className={inspectPart.color === code ? 'selected' : ''}
                      style={{ '--swatch': color.hex } as React.CSSProperties}
                      onClick={() => onRecolor(code)}
                      aria-label={`${color.name}, LDraw colour ${code}`}
                      aria-pressed={inspectPart.color === code}
                      title={`${color.name} · LDraw ${code}`}
                    />
                  )
                })}
              </div>
              {inspectDefinition.availableColors.length > INSPECTOR_SWATCH_LIMIT && (
                <button className="swatch-more" type="button" onClick={() => setAllColors((value) => !value)}>
                  {allColors
                    ? 'Show the common colours'
                    : `Show all ${inspectDefinition.availableColors.length} observed colours`}
                </button>
              )}
              <div
                className={`legality-row ${inspectDefinition.availableColors.includes(inspectPart.color) ? '' : 'virtual'}`}
              >
                <Check size={12} />
                {inspectDefinition.availableColors.includes(inspectPart.color)
                  ? `Observed in official sets · ${inspectDefinition.availableColors.length} known colours`
                  : inspectDefinition.availableColors.length
                    ? 'Virtual colour — no observed official-set appearance'
                    : 'No colour production evidence for this part'}
              </div>
            </section>
            <section className="property-section">
              <header>
                <span>CONNECTIONS</span>
                <em>{inspectDefinition.connectors.length} features</em>
              </header>
              <div className="connector-summary">
                <div>
                  <span className="connector-icon male" />{' '}
                  <strong>{inspectDefinition.connectors.filter((item) => item.gender === 'male').length}</strong>
                  <small>male</small>
                </div>
                <div>
                  <span className="connector-icon female" />{' '}
                  <strong>{inspectDefinition.connectors.filter((item) => item.gender === 'female').length}</strong>
                  <small>female</small>
                </div>
                <div>
                  <ShieldCheck size={18} />{' '}
                  <strong>{inspectDefinition.connectionStatus === 'ldcad-authoritative' ? 'LDCad' : 'none'}</strong>
                  <small>source</small>
                </div>
              </div>
            </section>
            <section className="property-section">
              <header>
                <span>OWNERSHIP</span>
                <em>{inspectPart.provenance}</em>
              </header>
              <button
                className={`lock-control ${inspectPart.protected ? 'locked' : ''}`}
                onClick={() => onProtect(!inspectPart.protected)}
              >
                {inspectPart.protected ? <Lock size={15} /> : <Unlock size={15} />}
                <span>{inspectPart.protected ? 'Protected from agent edits' : 'Unlocked for collaboration'}</span>
                <i>{inspectPart.protected ? 'LOCKED' : 'OPEN'}</i>
              </button>
            </section>
            {articulation.length > 0 && (
              <section className="property-section">
                <header>
                  <span>ARTICULATION</span>
                  <em>
                    {articulation.length} joint{articulation.length === 1 ? '' : 's'}
                  </em>
                </header>
                {/* Only interfaces designed to move appear here. A stud
                    connection is rigid once built, so a brick wall offers
                    nothing to drive. */}
                {articulation.map((joint) => (
                  <div className="joint-row" key={joint.edgeId}>
                    <div className="joint-copy">
                      <strong>{joint.family}</strong>
                      <small>
                        {joint.label.split(' · ').slice(2).join(' · ')} · moves {joint.movingCount}
                      </small>
                    </div>
                    <div className="joint-controls">
                      {joint.canRotate && (
                        <>
                          <button
                            onClick={() => onArticulate(joint.edgeId, { rotateDegrees: -joint.rotateStep })}
                            title={`Rotate -${joint.rotateStep}°`}
                          >
                            <RotateCcw size={12} />
                          </button>
                          <button
                            onClick={() => onArticulate(joint.edgeId, { rotateDegrees: joint.rotateStep })}
                            title={`Rotate +${joint.rotateStep}°`}
                          >
                            <RotateCw size={12} />
                          </button>
                        </>
                      )}
                      {joint.canSlide && (
                        <>
                          <button
                            onClick={() => onArticulate(joint.edgeId, { slideLdu: -joint.slideStep })}
                            title={`Slide -${joint.slideStep} LDU`}
                          >
                            <ChevronsLeft size={12} />
                          </button>
                          <button
                            onClick={() => onArticulate(joint.edgeId, { slideLdu: joint.slideStep })}
                            title={`Slide +${joint.slideStep} LDU`}
                          >
                            <ChevronsRight size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
            <section className="property-section">
              <header>
                <span>DATA PROVENANCE</span>
                <em>{inspectDefinition.license}</em>
              </header>
              <dl className="provenance-list">
                <div>
                  <dt>Geometry</dt>
                  <dd>
                    {inspectDefinition.ldrawId} · {inspectDefinition.geometryAsset?.triangles.toLocaleString() ?? '—'}{' '}
                    triangles
                  </dd>
                </div>
                <div>
                  <dt>Connections</dt>
                  <dd>
                    {inspectDefinition.connectionStatus === 'ldcad-authoritative'
                      ? `LDCad Shadow Library · ${inspectDefinition.connectors.length} features`
                      : 'no snap metadata'}
                  </dd>
                </div>
                <div>
                  <dt>Identity</dt>
                  <dd>
                    {inspectDefinition.identity.rebrickableId
                      ? `${inspectDefinition.identity.rebrickableId} · exact match`
                      : inspectDefinition.identity.baseRebrickableId
                        ? `${inspectDefinition.identity.baseRebrickableId} · base-design match`
                        : 'no external identity'}
                  </dd>
                </div>
                <div>
                  <dt>Colours</dt>
                  <dd>
                    {inspectDefinition.availableColors.length
                      ? `${inspectDefinition.availableColors.length} observed in official sets`
                      : 'no production evidence'}
                  </dd>
                </div>
                {inspectDefinition.frequency > 0 && (
                  <div>
                    <dt>Usage</dt>
                    <dd>{inspectDefinition.frequency.toLocaleString()} set appearances</dd>
                  </div>
                )}
              </dl>
            </section>
            {/* Extension point. Refinement review, cloud status and share all
                mount their per-selection surfaces here without editing this
                file; see docs/integration/workbench-ui.md. */}
            <Slot
              id="inspector"
              wrap={({ title, icon, content }) => (
                <section className="property-section">
                  {title ? (
                    <header>
                      <span>
                        {icon}
                        {title.toUpperCase()}
                      </span>
                    </header>
                  ) : null}
                  {content}
                </section>
              )}
            />
          </div>
        ) : (
          <div
            className={`empty-inspector${kernelParts.length ? ' has-selection' : ''}`}
            role="tabpanel"
            id="inspector-object-panel"
            aria-labelledby="inspector-tab-object"
            data-selection-count={kernelParts.length}
          >
            <div className="scanner-mark">
              <span />
              <span />
              <span />
              <span />
            </div>
            {kernelParts.length > 1 ? (
              <>
                <span className="eyebrow">{kernelParts.length} PARTS SELECTED</span>
                <h3>Inspect one part at a time</h3>
                <p>
                  The kernel has {kernelParts.length} parts in the selection
                  {inspectIdentities(kernelParts)}. Click a single brick to see its transform, connectors and ownership,
                  or paint the whole set here.
                </p>
                <div className="swatches inspector-swatches inspector-set-swatches">
                  {inspectorSetSwatches(kernelParts).map((code) => {
                    const color = getColor(code)
                    const applied = kernelParts.every((part) => part.color === code)
                    return (
                      <button
                        key={code}
                        className={applied ? 'selected' : ''}
                        style={{ '--swatch': color.hex } as React.CSSProperties}
                        onClick={() => onRecolor(code)}
                        aria-label={`${color.name}, LDraw colour ${code}`}
                        aria-pressed={applied}
                        title={`${color.name} · LDraw ${code}`}
                      />
                    )
                  })}
                </div>
              </>
            ) : kernelParts.length === 1 ? (
              <>
                <span className="eyebrow">IDENTITY MISSING</span>
                <h3>{kernelParts[0].definitionId} is selected</h3>
                <p>
                  The kernel still holds this part, but this build has no compiled catalog identity for it, so there is
                  nothing honest to show for transform evidence or colour.
                </p>
              </>
            ) : (
              <>
                <span className="eyebrow">NO OBJECT SELECTED</span>
                <h3>Inspect the build</h3>
                <p>Select any physical part to inspect its exact transform, connectors, identity and ownership.</p>
              </>
            )}
            <div className="overview-metrics">
              <div>
                <strong>{report.partCount}</strong>
                <span>parts</span>
              </div>
              <div>
                <strong>{kernelParts.length || Object.keys(state.document.subassemblies).length}</strong>
                <span>{kernelParts.length ? 'selected' : 'modules'}</span>
              </div>
              <div>
                <strong>r{state.document.revision}</strong>
                <span>revision</span>
              </div>
            </div>
          </div>
        )
      ) : (
        <div role="tabpanel" id="inspector-validate-panel" aria-labelledby="inspector-tab-validate">
          <ModelHealthPanel
            state={state}
            health={health ?? undefined}
            activeIssueId={activeHealthIssueId}
            onActiveIssue={onActiveHealthIssue}
            onFocusIssue={onFocusHealthIssue ?? ((issue) => onSelectIds([...issue.partIds]))}
          />
        </div>
      )}
    </aside>
  )
}

function inspectIdentities(parts: PartInstance[]): string {
  const ids = [...new Set(parts.map((part) => part.definitionId))]
  if (ids.length === 1) return ` · ${ids[0]}`
  if (ids.length <= 3) return ` · ${ids.join(', ')}`
  return ` · ${ids.length} identities`
}

/** Colours the set already uses, then observed catalogue colours, capped. */
export function inspectorSetSwatches(parts: PartInstance[]): number[] {
  const seen = new Set<number>()
  const codes: number[] = []
  const push = (code: number) => {
    if (seen.has(code)) return
    seen.add(code)
    codes.push(code)
  }
  for (const part of parts) push(part.color)
  for (const part of parts) {
    for (const code of catalog.get(part.definitionId)?.availableColors ?? []) push(code)
  }
  return codes.slice(0, INSPECTOR_SWATCH_LIMIT)
}
