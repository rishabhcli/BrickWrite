import {
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  Copy,
  Crosshair,
  FlipHorizontal2,
  Globe,
  Link2,
  Lock,
  Magnet,
  Palette,
  Pipette,
  Repeat2,
  RotateCw,
  Unlock,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { getColor, STUD_LDU } from '../../cad/catalog'
import { findSnapCandidates } from '../../cad/snapping'
import type { CadOperation } from '../../cad/types'
import { poseRefusal } from '../../cad/validation'
import {
  AXIS_INDEX,
  canonicalisePose,
  connectorFrame,
  numericPose,
  planAlign,
  planDistribute,
  readNumericPose,
  resolvePivot,
  rotatePose,
  selectionExtent,
  translatePose,
  type AlignEdge,
  type PivotMode,
  type ReferenceFrame,
} from './transform'
import type { Workbench } from './useWorkbench'
import { NumberField } from './NumberField'

/**
 * Contextual transform controls.
 *
 * The gizmo answers "roughly there"; this answers "exactly there". Both produce
 * the same canonical matrix — `transform.ts` is the single implementation and
 * `transform.test.ts` asserts the equivalence — so an operator can start a move
 * with the pointer and finish it with the keyboard without the part shifting.
 */

const FRAMES: Array<{ id: ReferenceFrame; label: string; hint: string; icon: React.ReactElement }> = [
  { id: 'world', label: 'WORLD', hint: 'Axes are the document’s own X, Y and Z.', icon: <Globe size={11} /> },
  { id: 'local', label: 'LOCAL', hint: 'Axes follow the part’s own orientation.', icon: <RotateCw size={11} /> },
  {
    id: 'connector',
    label: 'MATE',
    hint: 'Axes follow the part’s first compiled connector frame.',
    icon: <Link2 size={11} />,
  },
]

const PIVOTS: Array<{ id: PivotMode; label: string; hint: string }> = [
  { id: 'origin', label: 'ORIGIN', hint: 'Turn about the first selected part’s LDraw origin.' },
  { id: 'centre', label: 'CENTRE', hint: 'Turn about the measured centre of the selection.' },
  { id: 'world-origin', label: 'WORLD 0', hint: 'Turn about the document origin.' },
]

/** Axis choices for the array control. LDraw is Y-down, so "up" is negative Y. */
const ARRAY_AXES: Array<{ id: 'x' | 'y' | 'z'; label: string; unit: [number, number, number] }> = [
  { id: 'x', label: 'X →', unit: [1, 0, 0] },
  { id: 'y', label: 'Y ↑', unit: [0, -1, 0] },
  { id: 'z', label: 'Z →', unit: [0, 0, 1] },
]

export function TransformPanel({ workbench }: { workbench: Workbench }) {
  const { state, transformPrefs, setTransformPrefs } = workbench
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [arrayOpen, setArrayOpen] = useState(false)
  const [mirrorOpen, setMirrorOpen] = useState(false)
  const [mirrorAxis, setMirrorAxis] = useState<'x' | 'y' | 'z'>('x')
  const [mirrorAbout, setMirrorAbout] = useState<'world' | 'selection'>('selection')
  const [arrayCopies, setArrayCopies] = useState(3)
  const [arrayAxis, setArrayAxis] = useState<'x' | 'y' | 'z'>('x')
  const [arraySpacing, setArraySpacing] = useState<number | 'auto'>('auto')

  const parts = useMemo(
    () => state.selection.map((id) => state.document.parts[id]).filter(Boolean),
    [state.document.parts, state.selection],
  )
  const single = parts.length === 1 ? parts[0] : undefined
  const extent = useMemo(() => selectionExtent(state.document, state.selection), [state.document, state.selection])
  const numeric = single ? readNumericPose(single.transform) : null
  const position = single ? single.transform.position : resolvePivot(parts, 'centre')

  /**
   * Alternative connector mates for the selected part at its current position.
   *
   * The solver already ranks every legal pose; without a way to step through
   * them the operator only ever sees the top-ranked one, which is wrong exactly
   * when a part has several equally sensible seats.
   */
  const candidates = useMemo(() => {
    if (!single) return []
    return findSnapCandidates(single, state.document, single.transform, {
      radiusLdu: STUD_LDU * 1.5,
      maxCandidates: 8,
    }).filter((candidate) => !poseRefusal(state.document, single.id, candidate.transform))
  }, [single, state.document])

  const commit = useCallback(
    (label: string, operations: CadOperation[]) => {
      if (!operations.length) return
      workbench.commitTransforms(label, operations)
    },
    [workbench],
  )

  const setPosition = useCallback(
    (axis: 0 | 1 | 2, value: number) => {
      if (!Number.isFinite(value) || !parts.length) return
      const delta: [number, number, number] = [0, 0, 0]
      delta[axis] = value - position[axis]
      commit(
        'Position selection',
        parts.map((part) => ({
          type: 'part.transform',
          partId: part.id,
          transform: translatePose(part.transform, delta, 'world'),
        })),
      )
    },
    [commit, parts, position],
  )

  const setRotation = useCallback(
    (axis: 0 | 1 | 2, value: number) => {
      if (!single || !numeric) return
      const rotation = [...numeric.rotationDegrees] as [number, number, number]
      rotation[axis] = value
      workbench.handleTransform(single.id, numericPose(single.transform, { rotationDegrees: rotation }), true)
    },
    [numeric, single, workbench],
  )

  const nudge = useCallback(
    (axis: 0 | 1 | 2, direction: 1 | -1) => {
      if (!parts.length) return
      const vector: [number, number, number] = [0, 0, 0]
      vector[axis] = transformPrefs.translateStep * direction
      if (transformPrefs.locks[(['x', 'y', 'z'] as const)[axis]]) return
      const reference = transformPrefs.frame === 'local' ? parts[0].transform.basis : connectorFrame(parts[0])
      commit(
        `Nudge ${parts.length} part${parts.length === 1 ? '' : 's'}`,
        parts.map((part) => ({
          type: 'part.transform',
          partId: part.id,
          transform: translatePose(part.transform, vector, transformPrefs.frame, reference ?? undefined),
        })),
      )
    },
    [commit, parts, transformPrefs.frame, transformPrefs.translateStep, transformPrefs.locks],
  )

  const turn = useCallback(
    (axis: 0 | 1 | 2, direction: 1 | -1) => {
      if (!parts.length) return
      const vector = [0, 0, 0] as [number, number, number]
      vector[axis] = 1
      const pivot = resolvePivot(parts, transformPrefs.pivot)
      commit(
        `Turn ${parts.length} part${parts.length === 1 ? '' : 's'} ${transformPrefs.rotationStep * direction}°`,
        parts.map((part) => ({
          type: 'part.transform',
          partId: part.id,
          transform: rotatePose(
            part.transform,
            vector,
            transformPrefs.rotationStep * direction,
            parts.length > 1 && transformPrefs.frame === 'local' ? 'connector' : transformPrefs.frame,
            transformPrefs.pivot === 'origin' && parts.length === 1 ? undefined : pivot,
            transformPrefs.frame === 'local' ? parts[0].transform.basis : (connectorFrame(parts[0]) ?? undefined),
          ),
        })),
      )
    },
    [commit, parts, transformPrefs.frame, transformPrefs.pivot, transformPrefs.rotationStep],
  )

  const runArray = useCallback(() => {
    const axis = ARRAY_AXES.find((entry) => entry.id === arrayAxis)!
    const measured = extent ? Math.max(1, extent.size[AXIS_INDEX[arrayAxis]]) : STUD_LDU
    const step = arraySpacing === 'auto' ? Math.max(STUD_LDU / 2, Math.round(measured)) : arraySpacing
    workbench.runSharedMutation('linear_array', {
      copies: arrayCopies,
      offsetLdu: [axis.unit[0] * step, axis.unit[1] * step, axis.unit[2] * step],
    })
  }, [arrayAxis, arrayCopies, arraySpacing, extent, workbench])

  const align = useCallback(
    (axis: 'x' | 'y' | 'z', edge: AlignEdge) => {
      commit(`Align ${parts.length} parts`, planAlign(parts, axis, edge))
    },
    [commit, parts],
  )

  const distribute = useCallback(
    (axis: 'x' | 'y' | 'z') => {
      commit(`Distribute ${parts.length} parts`, planDistribute(parts, axis))
    },
    [commit, parts],
  )

  const applyCandidate = useCallback(
    (index: number) => {
      const candidate = candidates[index]
      if (!candidate || !single) return
      setCandidateIndex(index)
      commit('Seat on connector', [
        { type: 'part.transform', partId: single.id, transform: canonicalisePose(candidate.transform) },
      ])
    },
    [candidates, commit, single],
  )

  const disabled = !parts.length
  const scope = disabled
    ? 'No selection'
    : parts.length === 1
      ? `1 part · ${single?.definitionId}`
      : `${parts.length} parts`

  return (
    <div className="transform-panel" data-scope={disabled ? 'empty' : 'selection'}>
      <div className="transform-scope">
        <span className="eyebrow">SCOPE</span>
        <strong>{scope}</strong>
        {extent && (
          <small>
            {(extent.size[0] / STUD_LDU).toFixed(1)} × {(extent.size[2] / STUD_LDU).toFixed(1)} studs ·{' '}
            {(extent.size[1] / 8).toFixed(1)} plates tall
          </small>
        )}
      </div>

      <div className="transform-modes">
        <div className="segmented" role="radiogroup" aria-label="Reference frame">
          {FRAMES.map((frame) => (
            <button
              key={frame.id}
              role="radio"
              aria-checked={transformPrefs.frame === frame.id}
              className={transformPrefs.frame === frame.id ? 'active' : ''}
              title={frame.hint}
              onClick={() => setTransformPrefs({ ...transformPrefs, frame: frame.id })}
            >
              {frame.icon}
              {frame.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Rotation pivot">
          {PIVOTS.map((pivot) => (
            <button
              key={pivot.id}
              role="radio"
              aria-checked={transformPrefs.pivot === pivot.id}
              className={transformPrefs.pivot === pivot.id ? 'active' : ''}
              title={pivot.hint}
              onClick={() => setTransformPrefs({ ...transformPrefs, pivot: pivot.id })}
            >
              {pivot.label}
            </button>
          ))}
        </div>
      </div>

      <div className="axis-locks" role="group" aria-label="Axis locks">
        <span>LOCK</span>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <button
            key={axis}
            type="button"
            aria-pressed={transformPrefs.locks[axis]}
            className={transformPrefs.locks[axis] ? 'locked' : ''}
            title={
              transformPrefs.locks[axis]
                ? `${axis.toUpperCase()} is locked; drags cannot change it`
                : `Lock ${axis.toUpperCase()}`
            }
            onClick={() =>
              setTransformPrefs({
                ...transformPrefs,
                locks: { ...transformPrefs.locks, [axis]: !transformPrefs.locks[axis] },
              })
            }
          >
            {transformPrefs.locks[axis] ? <Lock size={9} /> : <Unlock size={9} />}
            {axis.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          className={`snap-toggle ${transformPrefs.connectorSnap ? 'on' : ''}`}
          aria-pressed={transformPrefs.connectorSnap}
          title={
            transformPrefs.connectorSnap
              ? 'Committed poses are resolved onto real connectors'
              : 'Committed poses are taken exactly as entered'
          }
          onClick={() => setTransformPrefs({ ...transformPrefs, connectorSnap: !transformPrefs.connectorSnap })}
        >
          <Magnet size={10} /> SNAP
        </button>
      </div>

      {!disabled ? (
        <>
          {!single && (
            <p className="transform-multi-note">
              Position the selection’s centre. All {parts.length} parts move together.
            </p>
          )}
          <div className="fields-grid" role="group" aria-label="Position in LDraw units">
            {(['X', 'Y', 'Z'] as const).map((axis, index) => (
              <NumberField
                key={`p_${axis}_${state.selection.join('|')}`}
                label={axis}
                value={position[index]}
                suffix="LDU"
                disabled={transformPrefs.locks[axis.toLowerCase() as 'x' | 'y' | 'z']}
                onCommit={(value) => setPosition(index as 0 | 1 | 2, value)}
              />
            ))}
          </div>
          {/* Euler degrees are a display affordance only. The document stores an
              exact basis; these fields decompose it for editing and recompose on
              commit, through the same canonical path the gizmo uses. */}
          {single && numeric && (
            <div className="fields-grid rotation-fields" role="group" aria-label="Rotation in degrees">
              {(['RX', 'RY', 'RZ'] as const).map((axis, index) => (
                <NumberField
                  key={`r_${axis}_${single.id}`}
                  label={axis}
                  value={numeric.rotationDegrees[index]}
                  suffix="°"
                  onCommit={(value) => setRotation(index as 0 | 1 | 2, value)}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="transform-multi-note">
          {disabled
            ? 'Select a part to type an exact pose. Steppers below work on any number of parts.'
            : `${parts.length} parts selected — exact fields need one part. The steppers, align and distribute all work on the whole selection.`}
        </p>
      )}

      <div className="transform-steppers">
        <label>
          <span>STEP</span>
          <select
            value={transformPrefs.translateStep}
            onChange={(event) => setTransformPrefs({ ...transformPrefs, translateStep: Number(event.target.value) })}
            aria-label="Translation step"
          >
            <option value={20}>1 stud</option>
            <option value={10}>½ stud</option>
            <option value={8}>1 plate</option>
            <option value={4}>4 LDU</option>
            <option value={1}>1 LDU</option>
          </select>
        </label>
        <div className="stepper-grid" role="group" aria-label="Nudge the selection">
          {(['X', 'Y', 'Z'] as const).map((axis, index) => (
            <div key={axis} className="stepper-row">
              <em>{axis}</em>
              <button
                type="button"
                disabled={disabled || transformPrefs.locks[axis.toLowerCase() as 'x' | 'y' | 'z']}
                aria-label={`Nudge ${axis} negative`}
                onClick={() => nudge(index as 0 | 1 | 2, -1)}
              >
                −
              </button>
              <button
                type="button"
                disabled={disabled || transformPrefs.locks[axis.toLowerCase() as 'x' | 'y' | 'z']}
                aria-label={`Nudge ${axis} positive`}
                onClick={() => nudge(index as 0 | 1 | 2, 1)}
              >
                +
              </button>
            </div>
          ))}
        </div>
        <label>
          <span>TURN</span>
          <select
            value={transformPrefs.rotationStep}
            onChange={(event) => setTransformPrefs({ ...transformPrefs, rotationStep: Number(event.target.value) })}
            aria-label="Rotation step"
          >
            <option value={90}>90°</option>
            <option value={45}>45°</option>
            <option value={15}>15°</option>
            <option value={5}>5°</option>
            <option value={1}>1°</option>
          </select>
        </label>
        <div className="stepper-grid" role="group" aria-label="Turn the selection">
          {(['X', 'Y', 'Z'] as const).map((axis, index) => (
            <div key={`t${axis}`} className="stepper-row">
              <em>R{axis}</em>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Turn ${axis} negative`}
                onClick={() => turn(index as 0 | 1 | 2, -1)}
              >
                −
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Turn ${axis} positive`}
                onClick={() => turn(index as 0 | 1 | 2, 1)}
              >
                +
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="transform-actions">
        <ActionButton
          icon={<ArrowDownToLine size={12} />}
          label="Ground"
          shortcut="⇧D"
          disabled={disabled}
          reason="Select parts to rest on the ground."
          onClick={() => workbench.groundSelection()}
        />
        <ActionButton
          icon={<Copy size={12} />}
          label="Clone"
          shortcut="⌘D"
          disabled={disabled}
          reason="Select at least one part first."
          onClick={() => workbench.duplicateSelection()}
        />
        <ActionButton
          icon={<Repeat2 size={12} />}
          label="Array"
          shortcut="⇧A"
          disabled={disabled}
          expanded={arrayOpen}
          reason="Select at least one part first."
          onClick={() => setArrayOpen((value) => !value)}
        />
        <ActionButton
          icon={<FlipHorizontal2 size={12} />}
          label="Mirror"
          shortcut="⇧M"
          disabled={disabled}
          expanded={mirrorOpen}
          reason="Select at least one part first."
          onClick={() => setMirrorOpen((value) => !value)}
        />
        <ActionButton
          icon={<Palette size={12} />}
          label="Paint"
          shortcut="P"
          disabled={disabled}
          reason="Select at least one part first."
          onClick={() => workbench.recolorSelection(workbench.activeColor)}
          swatch={getColor(workbench.activeColor).hex}
        />
        <ActionButton
          icon={<Pipette size={12} />}
          label="Pick"
          shortcut="K"
          disabled={disabled}
          reason="Select a part to sample its colour."
          onClick={() => workbench.pickColorFromSelection()}
        />
        <ActionButton
          icon={<Crosshair size={12} />}
          label="Focus"
          shortcut="⇧F"
          disabled={disabled}
          reason="Select at least one part first."
          onClick={() => workbench.focusSelection()}
        />
      </div>

      {arrayOpen && !disabled && (
        /* An array is a decision, not a guess: a hardcoded direction and count
           is exactly what gets refused by a design envelope the operator never
           saw. Spacing defaults to the selection's own measured extent, so the
           copies sit edge to edge rather than overlapping. */
        <div className="array-control" role="group" aria-label="Linear array">
          <label>
            <span>COPIES</span>
            <input
              type="number"
              min={1}
              max={24}
              value={arrayCopies}
              aria-label="Array copies"
              onChange={(event) => setArrayCopies(Math.max(1, Math.min(24, Number(event.target.value) || 1)))}
            />
          </label>
          <label>
            <span>ALONG</span>
            <select
              value={arrayAxis}
              onChange={(event) => setArrayAxis(event.target.value as 'x' | 'y' | 'z')}
              aria-label="Array axis"
            >
              {ARRAY_AXES.map((axis) => (
                <option key={axis.id} value={axis.id}>
                  {axis.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>SPACING</span>
            <select
              value={String(arraySpacing)}
              aria-label="Array spacing"
              onChange={(event) => setArraySpacing(event.target.value === 'auto' ? 'auto' : Number(event.target.value))}
            >
              <option value="auto">Its own size</option>
              <option value={STUD_LDU}>1 stud</option>
              <option value={STUD_LDU * 2}>2 studs</option>
              <option value={24}>1 brick</option>
              <option value={8}>1 plate</option>
            </select>
          </label>
          <button type="button" className="array-run" onClick={() => runArray()}>
            ARRAY
          </button>
        </div>
      )}

      {mirrorOpen && !disabled && (
        /* Which plane, and where it sits, are both real decisions.
           Builders mirror front-to-back as often as left-to-right, and the
           command was X-only for as long as it existed. `About` matters just as
           much: reflecting through the world origin throws a selection to the
           other side of the model, which is occasionally what you want and
           almost never what you meant, so the default plane is the selection's
           own measured centre. */
        <div className="array-control" role="group" aria-label="Mirror">
          <label>
            <span>ACROSS</span>
            <select
              value={mirrorAxis}
              onChange={(event) => setMirrorAxis(event.target.value as 'x' | 'y' | 'z')}
              aria-label="Mirror axis"
            >
              <option value="x">X — left / right</option>
              <option value="z">Z — front / back</option>
              <option value="y">Y — up / down</option>
            </select>
          </label>
          <label>
            <span>ABOUT</span>
            <select
              value={mirrorAbout}
              onChange={(event) => setMirrorAbout(event.target.value as 'world' | 'selection')}
              aria-label="Mirror plane"
            >
              <option value="selection">Its own centre</option>
              <option value="world">World origin</option>
            </select>
          </label>
          <button
            type="button"
            className="array-run"
            onClick={() => {
              workbench.runSharedMutation('mirror_selection', { axis: mirrorAxis, about: mirrorAbout, axisLdu: 0 })
              setMirrorOpen(false)
            }}
          >
            MIRROR
          </button>
        </div>
      )}

      <div className="align-grid" role="group" aria-label="Align and distribute">
        <span className="eyebrow">ALIGN</span>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <div key={axis} className="align-row">
            <em>{axis.toUpperCase()}</em>
            {(['min', 'centre', 'max'] as const).map((edge) => (
              <button
                key={edge}
                type="button"
                disabled={parts.length < 2}
                aria-label={`Align ${axis.toUpperCase()} ${edge}`}
                title={
                  parts.length < 2 ? 'Select two or more parts to align.' : `Align ${edge} on ${axis.toUpperCase()}`
                }
                onClick={() => align(axis, edge)}
              >
                {edge === 'min' ? '⟨' : edge === 'max' ? '⟩' : '·'}
              </button>
            ))}
            <button
              type="button"
              disabled={parts.length < 3}
              aria-label={`Distribute ${axis.toUpperCase()}`}
              title={
                parts.length < 3
                  ? 'Select three or more parts to distribute.'
                  : `Distribute evenly on ${axis.toUpperCase()}`
              }
              onClick={() => distribute(axis)}
            >
              {axis === 'y' ? (
                <AlignVerticalDistributeCenter size={11} />
              ) : (
                <AlignHorizontalDistributeCenter size={11} />
              )}
            </button>
          </div>
        ))}
      </div>

      {single && (
        <div className="snap-candidates">
          <header>
            <span className="eyebrow">CONNECTOR SEATS</span>
            <em>{candidates.length || 'none'}</em>
          </header>
          {/* Two solutions can mate the same pair of connectors and differ only in
              the freedom the joint retains, so the connector pair alone is not a
              unique key — the rank is part of it. */}
          {candidates.length ? (
            <ul>
              {candidates.slice(0, 5).map((candidate, index) => (
                <li
                  key={`${index}:${candidate.movingFeatureId}:${candidate.targetPartId}:${candidate.targetFeatureId}`}
                >
                  <button
                    type="button"
                    className={index === candidateIndex ? 'active' : ''}
                    onClick={() => applyCandidate(index)}
                    title={`Seat ${candidate.movingFeatureId} onto ${candidate.targetPartId}/${candidate.targetFeatureId}`}
                  >
                    <strong>
                      {candidate.matches.length} mate{candidate.matches.length === 1 ? '' : 's'}
                    </strong>
                    <small>
                      {candidate.targetPartId} · {candidate.certainty} · {candidate.cursorTranslationLdu.toFixed(1)} LDU
                      away
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="snap-empty">
              No compatible unoccupied connector is within a stud and a half of where this part sits.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ActionButton({
  icon,
  label,
  shortcut,
  disabled,
  reason,
  onClick,
  swatch,
  expanded,
}: {
  icon: React.ReactElement
  label: string
  shortcut: string
  disabled?: boolean
  reason: string
  onClick: () => void
  swatch?: string
  /** Set when the action opens an inline control rather than firing. */
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      className={`transform-action ${expanded ? 'expanded' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={disabled ? reason : `${label} (${shortcut})`}
      aria-label={disabled ? `${label} — ${reason}` : label}
      aria-expanded={expanded === undefined ? undefined : expanded}
      aria-keyshortcuts={shortcut}
    >
      {swatch ? <i className="action-swatch" style={{ background: swatch }} /> : icon}
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  )
}
