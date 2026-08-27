import {
  Box,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  CircleDot,
  Clock3,
  ListOrdered,
  Lock,
  MessageSquareText,
  Plus,
  Search,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { catalog, describeSize, getColor, searchCatalog, STUD_LDU } from '../cad/catalog'
import { basisFromEulerDegrees, eulerDegreesFromBasis } from '../cad/math'
import type {
  AutonomyMode,
  CatalogSearchRecord,
  ColorDefinition,
  PartDefinition,
  EngineSnapshot,
  PartInstance,
  Transform,
  Transaction,
} from '../cad/types'

/**
 * Palette preview.
 *
 * Uses the offline-rendered thumbnail, tinted to the active colour: a coloured
 * layer masked by the thumbnail's alpha, with the same image multiplied over it
 * to restore shading. One asset therefore serves every LDraw colour, instead of
 * needing a render per part per colour.
 *
 * A part with no compiled geometry has no thumbnail either, and falls back to an
 * empty outline rather than a decorative stand-in — the card should not imply a
 * part is placeable when it is not.
 */
function PartPreview({ record, color }: { record: CatalogSearchRecord; color: string }) {
  const thumbnail = catalog.get(record.id)?.thumbnail
  if (!thumbnail) return <div className="part-glyph empty" aria-hidden><span /></div>
  return (
    <div className="part-thumb" aria-hidden>
      <span
        className="thumb-tint"
        style={{ '--part-color': color, '--thumb': `url(${thumbnail.file})` } as React.CSSProperties}
      />
      <img className="thumb-shade" src={thumbnail.file} alt="" width={thumbnail.size} height={thumbnail.size} loading="lazy" />
    </div>
  )
}

interface CatalogPanelProps {
  activeColor: number
  onColorChange: (color: number) => void
  onAdd: (record: CatalogSearchRecord) => void
}

/**
 * Palette colours shown in the dock. The compiled table carries all 322 LDraw
 * colours; these are the everyday building codes, in LDraw code order.
 */
const DOCK_COLORS = [15, 71, 72, 0, 4, 14, 1, 2, 25, 320, 322, 191, 27, 70, 47, 36]

export function CatalogPanel({ activeColor, onColorChange, onAdd }: CatalogPanelProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All parts')
  const [placeableOnly, setPlaceableOnly] = useState(true)
  const categories = useMemo(() => {
    // Categories that actually contain placeable parts, most populous first.
    const counts = new Map<string, number>()
    for (const part of catalog.placeable()) counts.set(part.category, (counts.get(part.category) ?? 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([name]) => name)
  }, [])
  const results = useMemo(
    () => searchCatalog({
      text: query,
      category: category === 'All parts' ? undefined : category,
      requireGeometry: placeableOnly,
      limit: 60,
    }),
    [category, query, placeableOnly],
  )
  return (
    <aside className="panel catalog-panel" aria-label="Parts catalog">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">BUILD LIBRARY</span>
          <h2>Parts catalog</h2>
        </div>
        <span className="count-badge">{results.length}</span>
      </div>
      <label className="search-field">
        <Search size={14} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Part, ID, shape…" aria-label="Search parts" />
        <kbd>⌘ K</kbd>
      </label>
      <div className="category-row" role="tablist" aria-label="Part categories">
        {['All parts', ...categories].map((item) => (
          <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)} role="tab" aria-selected={category === item}>
            {item.replace('Windscreens', 'Glass')}
          </button>
        ))}
      </div>
      <div className="catalog-meta">
        <span>{catalog.identityCount.toLocaleString()} LDRAW IDENTITIES</span>
        <button
          type="button"
          className={`status-ready ${placeableOnly ? '' : 'muted'}`}
          onClick={() => setPlaceableOnly((value) => !value)}
          title={placeableOnly
            ? `Showing the ${catalog.placeableCount} parts with compiled geometry in this build`
            : 'Showing every catalog identity, including parts this build cannot place'}
        >
          <CircleDot size={10} /> {placeableOnly ? `${catalog.placeableCount} placeable` : 'all identities'}
        </button>
      </div>
      <div className="parts-grid" data-testid="parts-grid">
        {results.map((record) => (
          <button
            type="button"
            className={`part-card ${record.geometryAvailable ? '' : 'unplaceable'}`}
            key={record.id}
            onDoubleClick={() => record.geometryAvailable && onAdd(record)}
            onClick={() => undefined}
            title={record.geometryAvailable
              ? `Double-click to place ${record.name} (${record.frequency} official set appearances)`
              : `${record.name} is in the catalog but has no compiled geometry in this build`}
          >
            <PartPreview record={record} color={getColor(activeColor).hex} />
            <div className="part-copy">
              <strong>{record.name.replace(/^(Brick|Plate|Tile|Slope) /, '')}</strong>
              <span>{record.id}{record.dimensions ? ` · ${record.dimensions[0]}×${record.dimensions[2]}` : ' · no geometry'}</span>
            </div>
            {record.geometryAvailable ? (
              <span
                role="button"
                tabIndex={0}
                className="part-add"
                aria-label={`Add ${record.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onAdd(record)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onAdd(record)
                }}
              >
                <Plus size={13} />
              </span>
            ) : (
              <span className="part-add disabled" aria-label="No compiled geometry">—</span>
            )}
          </button>
        ))}
      </div>
      <div className="palette-dock">
        <div className="palette-label">
          <span>PROJECT PALETTE</span>
          <button aria-label="Expand palette"><ChevronDown size={12} /></button>
        </div>
        <div className="swatches compact">
          {DOCK_COLORS.map((code) => getColor(code)).map((color) => (
            <button
              key={color.code}
              className={activeColor === color.code ? 'selected' : ''}
              style={{ '--swatch': color.hex } as React.CSSProperties}
              onClick={() => onColorChange(color.code)}
              aria-label={color.name}
              title={`${color.name} · LDraw ${color.code}`}
            />
          ))}
        </div>
      </div>
    </aside>
  )
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
  const report = state.validation
  const displayRotation = useMemo(
    () => (selectedPart ? eulerDegreesFromBasis(selectedPart.transform.basis) : ([0, 0, 0] as const)),
    [selectedPart],
  )
  const dimensions = report.bounds.size.map((value) => value / STUD_LDU)
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
              <div className="swatches inspector-swatches">
                {definition.availableColors.map((code) => {
                  const color = getColor(code)
                  return (
                    <button
                      key={code}
                      className={selectedPart.color === code ? 'selected' : ''}
                      style={{ '--swatch': color.hex } as React.CSSProperties}
                      onClick={() => onRecolor(code)}
                      title={`${color.name} · LDraw ${code}`}
                    />
                  )
                })}
              </div>
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

interface TimelineProps {
  state: EngineSnapshot
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onSelectIds: (ids: string[]) => void
  onSequence: () => void
}

const transactionIcon = (transaction: Transaction) => transaction.author === 'agent' ? <Sparkles size={13} /> : <Box size={13} />

export function Timeline({ state, onAccept, onReject, onSelectIds, onSequence }: TimelineProps) {
  const latestTransactions = state.transactions.slice(-6).reverse()
  return (
    <section className="timeline" aria-label="Build history">
      <div className="timeline-label">
        <span className="eyebrow">SHARED HISTORY</span>
        <h3>Build sequence</h3>
        <div><Clock3 size={12} /> {state.document.steps.length} steps · {state.validation.partCount} pcs</div>
        {/* Sequencing is a precedence problem over the connection graph, so it is
            regenerated from the model rather than authored by hand. */}
        <button className="sequence-button" onClick={onSequence} title="Derive a build sequence in which every part attaches to earlier structure">
          <ListOrdered size={11} /> SEQUENCE
        </button>
      </div>
      <div className="timeline-track">
        {state.proposals.map((proposal) => (
          <article className="proposal-card" key={proposal.id}>
            <div className="proposal-glow" />
            <header><Sparkles size={13} /><span>CODEX PROPOSAL</span><em>r{proposal.baseRevision}</em></header>
            <strong>{proposal.label}</strong>
            <p>{proposal.operations.length} operations · {proposal.validation.collisions.length} collisions</p>
            <footer>
              <button onClick={() => onAccept(proposal.id)}><Check size={12} /> Accept</button>
              <button onClick={() => onReject(proposal.id)}><X size={12} /> Reject</button>
            </footer>
          </article>
        ))}
        {latestTransactions.length > 0 ? latestTransactions.map((transaction, index) => (
          <button
            className={`transaction-card ${transaction.author}`}
            key={transaction.id}
            onClick={() => onSelectIds(transaction.affectedPartIds)}
          >
            <span className="transaction-index">{String(state.transactions.length - index).padStart(2, '0')}</span>
            <div className="transaction-icon">{transactionIcon(transaction)}</div>
            <div><strong>{transaction.label}</strong><small>{transaction.operations.length} operation{transaction.operations.length === 1 ? '' : 's'} · {transaction.author}</small></div>
            <em>r{transaction.resultRevision}</em>
          </button>
        )) : state.document.steps.map((step, index) => (
          <button className={`step-card ${index < 4 ? 'complete' : ''}`} key={step.id} onClick={() => onSelectIds(step.partIds)}>
            <span>{String(step.index).padStart(2, '0')}</span>
            <div className="step-node">{index < 4 ? <Check size={11} /> : <CircleDot size={10} />}</div>
            <strong>{step.name}</strong>
            <small>{step.partIds.length} parts</small>
          </button>
        ))}
      </div>
      <div className="timeline-note">
        <MessageSquareText size={14} />
        <div><span>OPEN NOTE</span><strong>{state.document.notes.find((note) => note.status === 'open')?.text ?? 'No unresolved builder notes'}</strong></div>
      </div>
    </section>
  )
}

export function AutonomySwitch({ value, onChange }: { value: AutonomyMode; onChange: (mode: AutonomyMode) => void }) {
  return (
    <div className="autonomy-switch" aria-label="Codex autonomy mode">
      {(['inspect', 'propose', 'build'] as AutonomyMode[]).map((mode) => (
        <button key={mode} className={value === mode ? `active ${mode}` : ''} onClick={() => onChange(mode)}>
          {mode === 'inspect' && <CircleDot size={11} />}
          {mode === 'propose' && <Sparkles size={11} />}
          {mode === 'build' && <ShieldCheck size={11} />}
          {mode}
        </button>
      ))}
    </div>
  )
}

export function ColorLabel({ color }: { color: ColorDefinition }) {
  return <span className="color-label"><i style={{ background: color.hex }} />{color.name}</span>
}
