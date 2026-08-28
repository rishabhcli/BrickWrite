import {
  Box,
  Check,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  Lock,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Unlock,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { describeSize, getColor, STUD_LDU } from '../../cad/catalog'
import { basisFromEulerDegrees, eulerDegreesFromBasis } from '../../cad/math'
import {
  ABS_GRAMS_PER_LDU3,
  analyseStatics,
  DEFAULT_CLUTCH_GRAMS,
  describeMass,
  describeSupport,
  MASS_BASIS,
  type StaticsReport,
} from '../../cad/statics'
import type {
  EngineSnapshot,
  PartDefinition,
  PartInstance,
  Transform,
} from '../../cad/types'
import { Slot } from './ExtensionRegistry'

/** How many observed colours the inspector shows before offering the rest. */
const INSPECTOR_SWATCH_LIMIT = 18

/** Placeholder while the validate tab is closed, so nothing is computed for it. */
const EMPTY_STATICS: StaticsReport = {
  mass: { grams: 0, measuredParts: 0, unmeasuredParts: 0, centreLdu: [0, 0, 0] },
  support: null,
  overloaded: [],
  unsupportedPartIds: [],
  assumptions: { clutchGramsPerStud: DEFAULT_CLUTCH_GRAMS, densityGramsPerLdu3: ABS_GRAMS_PER_LDU3, massBasis: MASS_BASIS },
  coverage: 1,
}

function NumberField({ label, value, suffix, onCommit }: { label: string; value: number; suffix: string; onCommit: (value: number) => void }) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <div><input key={value} type="number" defaultValue={value} onBlur={(event) => onCommit(Number(event.target.value))} /><em>{suffix}</em></div>
    </label>
  )
}

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
  /** Joints the current selection can drive; empty for a rigid assembly. */
  articulation: ArticulationControl[]
  onTransform: (partId: string, transform: Transform) => void
  onRecolor: (color: number) => void
  onProtect: (protect: boolean) => void
  onSelectIds: (ids: string[]) => void
  onArticulate: (edgeId: string, request: { rotateDegrees?: number; slideLdu?: number }) => void
}

export function InspectorPanel({
  state,
  selectedPart,
  definition,
  articulation,
  onTransform,
  onRecolor,
  onProtect,
  onSelectIds,
  onArticulate,
}: InspectorPanelProps) {
  const [tab, setTab] = useState<'object' | 'validate'>('object')
  const [allColors, setAllColors] = useState(false)
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
  const dimensions = report.bounds.size.map((value) => value / STUD_LDU)
  // Only while the tab is open, and only then. Statics walks the whole
  // connection graph — 164 ms on a 1,464-part model — so computing it on every
  // commit put it on the edit path, which is exactly where it must not be.
  const showStatics = tab === 'validate'
  const statics = useMemo(
    () => (showStatics ? analyseStatics(state.document) : EMPTY_STATICS),
    [showStatics, state.document],
  )
  return (
    <aside className="panel inspector-panel" aria-label="Selection inspector">
      <div className="inspector-tabs" role="tablist">
        <button className={tab === 'object' ? 'active' : ''} onClick={() => setTab('object')}>OBJECT</button>
        <button className={tab === 'validate' ? 'active' : ''} onClick={() => setTab('validate')}>
          VALIDATE
          <span className={report.healthy ? 'healthy-dot' : 'warning-dot'} />
        </button>
      </div>
      {tab === 'object' ? (
        selectedPart && definition ? (
          <div className="inspector-scroll">
            <section className="selection-identity">
              <div className="selected-glyph"><Box size={24} strokeWidth={1.4} /></div>
              <div>
                <span className="eyebrow">{definition.category} / {definition.canonicalId}</span>
                <h3>{definition.name}</h3>
                <p>{selectedPart.id} · {describeSize(definition)}</p>
              </div>
            </section>
            <section className="property-section">
              <header><span>TRANSFORM</span><em>WORLD · LDU</em></header>
              <div className="fields-grid">
                {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                  <NumberField
                    key={`p_${axis}`}
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
                    key={`r_${axis}`}
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
              <header><span>COLOR</span><em>{getColor(selectedPart.color).name}</em></header>
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
              <div className={`legality-row ${definition.availableColors.includes(selectedPart.color) ? '' : 'virtual'}`}>
                <Check size={12} />
                {definition.availableColors.includes(selectedPart.color)
                  ? `Observed in official sets · ${definition.availableColors.length} known colours`
                  : definition.availableColors.length
                    ? 'Virtual colour — no observed official-set appearance'
                    : 'No colour production evidence for this part'}
              </div>
            </section>
            <section className="property-section">
              <header><span>CONNECTIONS</span><em>{definition.connectors.length} features</em></header>
              <div className="connector-summary">
                <div><span className="connector-icon male" /> <strong>{definition.connectors.filter((item) => item.gender === 'male').length}</strong><small>male</small></div>
                <div><span className="connector-icon female" /> <strong>{definition.connectors.filter((item) => item.gender === 'female').length}</strong><small>female</small></div>
                <div><ShieldCheck size={18} /> <strong>{definition.connectionStatus === 'ldcad-authoritative' ? 'LDCad' : 'none'}</strong><small>source</small></div>
              </div>
            </section>
            <section className="property-section">
              <header><span>OWNERSHIP</span><em>{selectedPart.provenance}</em></header>
              <button className={`lock-control ${selectedPart.protected ? 'locked' : ''}`} onClick={() => onProtect(!selectedPart.protected)}>
                {selectedPart.protected ? <Lock size={15} /> : <Unlock size={15} />}
                <span>{selectedPart.protected ? 'Protected from agent edits' : 'Unlocked for collaboration'}</span>
                <i>{selectedPart.protected ? 'LOCKED' : 'OPEN'}</i>
              </button>
            </section>
            {articulation.length > 0 && (
              <section className="property-section">
                <header><span>ARTICULATION</span><em>{articulation.length} joint{articulation.length === 1 ? '' : 's'}</em></header>
                {/* Only interfaces designed to move appear here. A stud
                    connection is rigid once built, so a brick wall offers
                    nothing to drive. */}
                {articulation.map((joint) => (
                  <div className="joint-row" key={joint.edgeId}>
                    <div className="joint-copy">
                      <strong>{joint.family}</strong>
                      <small>{joint.label.split(' · ').slice(2).join(' · ')} · moves {joint.movingCount}</small>
                    </div>
                    <div className="joint-controls">
                      {joint.canRotate && (
                        <>
                          <button onClick={() => onArticulate(joint.edgeId, { rotateDegrees: -joint.rotateStep })} title={`Rotate -${joint.rotateStep}°`}>
                            <RotateCcw size={12} />
                          </button>
                          <button onClick={() => onArticulate(joint.edgeId, { rotateDegrees: joint.rotateStep })} title={`Rotate +${joint.rotateStep}°`}>
                            <RotateCw size={12} />
                          </button>
                        </>
                      )}
                      {joint.canSlide && (
                        <>
                          <button onClick={() => onArticulate(joint.edgeId, { slideLdu: -joint.slideStep })} title={`Slide -${joint.slideStep} LDU`}>
                            <ChevronsLeft size={12} />
                          </button>
                          <button onClick={() => onArticulate(joint.edgeId, { slideLdu: joint.slideStep })} title={`Slide +${joint.slideStep} LDU`}>
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
              <header><span>DATA PROVENANCE</span><em>{definition.license}</em></header>
              <dl className="provenance-list">
                <div>
                  <dt>Geometry</dt>
                  <dd>{definition.ldrawId} · {definition.geometryAsset?.triangles.toLocaleString() ?? '—'} triangles</dd>
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
                  {title ? <header><span>{icon}{title.toUpperCase()}</span></header> : null}
                  {content}
                </section>
              )}
            />
          </div>
        ) : (
          <div className="empty-inspector">
            <div className="scanner-mark"><span /><span /><span /><span /></div>
            <span className="eyebrow">NO OBJECT SELECTED</span>
            <h3>Inspect the build</h3>
            <p>Select any physical part to inspect its exact transform, connectors, identity and ownership.</p>
            <div className="overview-metrics">
              <div><strong>{report.partCount}</strong><span>parts</span></div>
              <div><strong>{Object.keys(state.document.subassemblies).length}</strong><span>modules</span></div>
              <div><strong>r{state.document.revision}</strong><span>revision</span></div>
            </div>
          </div>
        )
      ) : (
        <div className="validation-view inspector-scroll">
          <div className={`validation-hero ${report.healthy ? 'pass' : 'warn'}`}>
            <div>{report.healthy ? <ShieldCheck size={25} /> : <CircleAlert size={25} />}</div>
            <span className="eyebrow">LIVE KERNEL REPORT</span>
            <h3>{report.healthy ? 'Geometry is clean' : 'Review build warnings'}</h3>
            <p>Deterministic checks at revision {report.revision}</p>
          </div>
          <section className="validation-list">
            {/* Certainty is surfaced, not folded away: a verdict reached from
                bounding boxes alone must not read the same as a triangle-exact
                one. */}
            <ValidationRow
              label="Collisions"
              value={
                report.collisions.length
                  ? `${report.collisions.length} found${report.unverifiedCollisions ? ` · ${report.unverifiedCollisions} unverified` : ''}`
                  : 'None'
              }
              status={report.collisions.length ? (report.unverifiedCollisions === report.collisions.length ? 'warn' : 'fail') : 'pass'}
              onClick={() => onSelectIds(report.collisions.flatMap((item) => [item.partA, item.partB]))}
            />
            <ValidationRow label="Connections" value={`${report.connectionCount} mated`} status="pass" />
            <ValidationRow label="Loose groups" value={report.componentCount <= 1 ? 'None' : String(report.componentCount - 1)} status={report.componentCount <= 1 ? 'pass' : 'warn'} onClick={() => onSelectIds(report.disconnectedPartIds)} />
            <ValidationRow label="Colour evidence" value={report.virtualColors.length ? `${report.virtualColors.length} virtual` : 'All observed'} status={report.virtualColors.length ? 'warn' : 'pass'} onClick={() => onSelectIds(report.virtualColors.map((item) => item.partId))} />
            <ValidationRow label="Dimensions" value={`${dimensions[0].toFixed(1)} × ${dimensions[2].toFixed(1)} studs`} status="pass" />
          </section>

          {/* Statics answers what collision cannot: does it stand up, and what
              is holding it together. Recomputed only while this tab is open,
              because it walks the connection graph. */}
          <section className="validation-list statics-list">
            <header className="statics-header">
              <span className="eyebrow">STATIC ANALYSIS</span>
              <em title={statics.assumptions.massBasis}>measured mass</em>
            </header>
            <ValidationRow
              label="Mass"
              value={statics.mass.measuredParts ? describeMass(statics.mass.grams) : 'nothing measured'}
              status={statics.coverage >= 0.999 ? 'pass' : 'warn'}
            />
            <ValidationRow
              label="Balance"
              value={statics.support
                ? statics.support.stable
                  ? `stable · ${(statics.support.marginLdu / STUD_LDU).toFixed(1)} studs of margin`
                  : 'centre of mass is outside the footprint'
                : 'nothing resting'}
              status={statics.support ? (statics.support.stable ? 'pass' : 'fail') : 'warn'}
            />
            <ValidationRow
              label="Footprint"
              value={describeSupport(statics.support)}
              status="pass"
            />
            <ValidationRow
              label="Reaches the ground"
              value={statics.unsupportedPartIds.length ? `${statics.unsupportedPartIds.length} part(s) do not` : 'every part'}
              status={statics.unsupportedPartIds.length ? 'warn' : 'pass'}
              onClick={statics.unsupportedPartIds.length ? () => onSelectIds(statics.unsupportedPartIds) : undefined}
            />
            <ValidationRow
              label="Clutch load"
              value={statics.overloaded.length ? `${statics.overloaded.length} over ${statics.assumptions.clutchGramsPerStud} g/stud` : 'within assumption'}
              status={statics.overloaded.length ? 'fail' : 'pass'}
              onClick={statics.overloaded.length ? () => onSelectIds(statics.overloaded.flatMap((item) => item.partIds)) : undefined}
            />
            {statics.coverage < 0.999 && (
              <p className="statics-note">
                {statics.mass.unmeasuredParts} part{statics.mass.unmeasuredParts === 1 ? '' : 's'} have no compiled volume, so they are
                excluded from the mass rather than estimated.
              </p>
            )}
          </section>
          <section className="constraint-list">
            <header><span>DESIGN CONSTRAINTS</span><em>{report.constraints.length}</em></header>
            {report.constraints.map((constraint) => (
              <div className="constraint-row" key={constraint.id}>
                <span className={`check-state ${constraint.status}`}>{constraint.status === 'pass' ? <Check size={11} /> : <CircleAlert size={11} />}</span>
                <div><strong>{constraint.label}</strong><small>{constraint.message}</small></div>
              </div>
            ))}
          </section>
        </div>
      )}
    </aside>
  )
}

function ValidationRow({ label, value, status, onClick }: { label: string; value: string; status: 'pass' | 'warn' | 'fail'; onClick?: () => void }) {
  return (
    <button className="validation-row" onClick={onClick} disabled={!onClick}>
      <span className={`check-state ${status}`}>{status === 'pass' ? <Check size={11} /> : <CircleAlert size={11} />}</span>
      <strong>{label}</strong>
      <em>{value}</em>
    </button>
  )
}
