import { Box, Check, ChevronsLeft, ChevronsRight, Lock, RotateCcw, RotateCw, ShieldCheck, Unlock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { describeSize, getColor } from '../../cad/catalog'
import { basisFromEulerDegrees, eulerDegreesFromBasis } from '../../cad/math'
import type { ModelHealthIssue } from '../../cad/modelHealth'
import type { EngineSnapshot, PartDefinition, PartInstance, Transform } from '../../cad/types'
import { Slot } from './ExtensionRegistry'
import { ModelHealthPanel } from './ModelHealthPanel'
import { NumberField } from './NumberField'

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
}

export type InspectorView = 'object' | 'validate'

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
}: InspectorPanelProps) {
  const [localView, setLocalView] = useState<InspectorView>('object')
  const [allColors, setAllColors] = useState(false)
  const tab = view ?? localView
  const setTab = (next: InspectorView) => {
    setLocalView(next)
    onViewChange?.(next)
  }
  const report = state.validation
  const displayRotation = useMemo(
    () => (selectedPart ? eulerDegreesFromBasis(selectedPart.transform.basis) : ([0, 0, 0] as const)),
    [selectedPart],
  )
  const shownColors = useMemo(() => {
    const observed = definition?.availableColors ?? []
    if (allColors || observed.length <= INSPECTOR_SWATCH_LIMIT) return observed
    const head = observed.slice(0, INSPECTOR_SWATCH_LIMIT)
    // The applied colour must stay visible even when the evidence order buries it.
    return selectedPart && observed.includes(selectedPart.color) && !head.includes(selectedPart.color)
      ? [...head.slice(0, INSPECTOR_SWATCH_LIMIT - 1), selectedPart.color]
      : head
  }, [allColors, definition, selectedPart])
  return (
    <aside className="panel inspector-panel" aria-label="Selection inspector">
      <div className="inspector-tabs" role="tablist">
        <button className={tab === 'object' ? 'active' : ''} onClick={() => setTab('object')}>
          OBJECT
        </button>
        <button className={tab === 'validate' ? 'active' : ''} onClick={() => setTab('validate')}>
          VALIDATE
          <span className={report.healthy ? 'healthy-dot' : 'warning-dot'} />
        </button>
      </div>
      {tab === 'object' ? (
        selectedPart && definition ? (
          <div className="inspector-scroll">
            <section className="selection-identity">
              <div className="selected-glyph">
                <Box size={24} strokeWidth={1.4} />
              </div>
              <div>
                <span className="eyebrow">
                  {definition.category} / {definition.canonicalId}
                </span>
                <h3>{definition.name}</h3>
                <p>
                  {selectedPart.id} · {describeSize(definition)}
                </p>
              </div>
            </section>
            <section className="property-section">
              <header>
                <span>TRANSFORM</span>
                <em>WORLD · LDU</em>
              </header>
              <div className="fields-grid">
                {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                  <NumberField
                    key={`p_${axis}_${selectedPart.id}`}
                    label={axis}
                    value={selectedPart.transform.position[index]}
                    suffix="LDU"
                    onCommit={(value) => {
                      const position = [...selectedPart.transform.position] as [number, number, number]
                      position[index] = value
                      onTransform(selectedPart.id, { ...selectedPart.transform, position })
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
                    key={`r_${axis}_${selectedPart.id}`}
                    label={axis}
                    value={displayRotation[index]}
                    suffix="°"
                    onCommit={(value) => {
                      const rotation = [...displayRotation] as [number, number, number]
                      rotation[index] = value
                      onTransform(selectedPart.id, {
                        position: selectedPart.transform.position,
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
                <em>{getColor(selectedPart.color).name}</em>
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
                      className={selectedPart.color === code ? 'selected' : ''}
                      style={{ '--swatch': color.hex } as React.CSSProperties}
                      onClick={() => onRecolor(code)}
                      aria-label={`${color.name}, LDraw colour ${code}`}
                      aria-pressed={selectedPart.color === code}
                      title={`${color.name} · LDraw ${code}`}
                    />
                  )
                })}
              </div>
              {definition.availableColors.length > INSPECTOR_SWATCH_LIMIT && (
                <button className="swatch-more" type="button" onClick={() => setAllColors((value) => !value)}>
                  {allColors
                    ? 'Show the common colours'
                    : `Show all ${definition.availableColors.length} observed colours`}
                </button>
              )}
              <div
                className={`legality-row ${definition.availableColors.includes(selectedPart.color) ? '' : 'virtual'}`}
              >
                <Check size={12} />
                {definition.availableColors.includes(selectedPart.color)
                  ? `Observed in official sets · ${definition.availableColors.length} known colours`
                  : definition.availableColors.length
                    ? 'Virtual colour — no observed official-set appearance'
                    : 'No colour production evidence for this part'}
              </div>
            </section>
            <section className="property-section">
              <header>
                <span>CONNECTIONS</span>
                <em>{definition.connectors.length} features</em>
              </header>
              <div className="connector-summary">
                <div>
                  <span className="connector-icon male" />{' '}
                  <strong>{definition.connectors.filter((item) => item.gender === 'male').length}</strong>
                  <small>male</small>
                </div>
                <div>
                  <span className="connector-icon female" />{' '}
                  <strong>{definition.connectors.filter((item) => item.gender === 'female').length}</strong>
                  <small>female</small>
                </div>
                <div>
                  <ShieldCheck size={18} />{' '}
                  <strong>{definition.connectionStatus === 'ldcad-authoritative' ? 'LDCad' : 'none'}</strong>
                  <small>source</small>
                </div>
              </div>
            </section>
            <section className="property-section">
              <header>
                <span>OWNERSHIP</span>
                <em>{selectedPart.provenance}</em>
              </header>
              <button
                className={`lock-control ${selectedPart.protected ? 'locked' : ''}`}
                onClick={() => onProtect(!selectedPart.protected)}
              >
                {selectedPart.protected ? <Lock size={15} /> : <Unlock size={15} />}
                <span>{selectedPart.protected ? 'Protected from agent edits' : 'Unlocked for collaboration'}</span>
                <i>{selectedPart.protected ? 'LOCKED' : 'OPEN'}</i>
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
                <em>{definition.license}</em>
              </header>
              <dl className="provenance-list">
                <div>
                  <dt>Geometry</dt>
                  <dd>
                    {definition.ldrawId} · {definition.geometryAsset?.triangles.toLocaleString() ?? '—'} triangles
                  </dd>
                </div>
                <div>
                  <dt>Connections</dt>
                  <dd>
                    {definition.connectionStatus === 'ldcad-authoritative'
                      ? `LDCad Shadow Library · ${definition.connectors.length} features`
                      : 'no snap metadata'}
                  </dd>
                </div>
                <div>
                  <dt>Identity</dt>
                  <dd>
                    {definition.identity.rebrickableId
                      ? `${definition.identity.rebrickableId} · exact match`
                      : definition.identity.baseRebrickableId
                        ? `${definition.identity.baseRebrickableId} · base-design match`
                        : 'no external identity'}
                  </dd>
                </div>
                <div>
                  <dt>Colours</dt>
                  <dd>
                    {definition.availableColors.length
                      ? `${definition.availableColors.length} observed in official sets`
                      : 'no production evidence'}
                  </dd>
                </div>
                {definition.frequency > 0 && (
                  <div>
                    <dt>Usage</dt>
                    <dd>{definition.frequency.toLocaleString()} set appearances</dd>
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
          <div className="empty-inspector">
            <div className="scanner-mark">
              <span />
              <span />
              <span />
              <span />
            </div>
            <span className="eyebrow">NO OBJECT SELECTED</span>
            <h3>Inspect the build</h3>
            <p>Select any physical part to inspect its exact transform, connectors, identity and ownership.</p>
            <div className="overview-metrics">
              <div>
                <strong>{report.partCount}</strong>
                <span>parts</span>
              </div>
              <div>
                <strong>{Object.keys(state.document.subassemblies).length}</strong>
                <span>modules</span>
              </div>
              <div>
                <strong>r{state.document.revision}</strong>
                <span>revision</span>
              </div>
            </div>
          </div>
        )
      ) : (
        <ModelHealthPanel
          state={state}
          activeIssueId={activeHealthIssueId}
          onActiveIssue={onActiveHealthIssue}
          onFocusIssue={onFocusHealthIssue ?? ((issue) => onSelectIds([...issue.partIds]))}
        />
      )}
    </aside>
  )
}
