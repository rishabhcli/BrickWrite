import { ArrowLeft, Check, CircleDot, Link2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { cadEngine } from '../../cad/engine'
import { catalog } from '../../cad/catalog'
import { getWorldConnectors, type WorldConnector } from '../../cad/snapping'
import { legalConnectCandidates } from '../../cad/placement'
import { canonicalisePose } from './transform'
import { IDLE_CONNECT, type ConnectFlow, type Workbench } from './useWorkbench'
import type { ModelDocument, PartInstance } from '../../cad/types'

function partLabel(part: PartInstance | undefined): string | null {
  if (!part) return null
  return catalog.get(part.definitionId)?.name ?? part.definitionId
}

/**
 * What HUD, inspector and the Connect sheet should all call the in-progress mate.
 *
 * Kernel selection stays the moving part (transforms must not drag the target),
 * so chrome that only reads `state.selection` silently drops the named target.
 */
export function describeConnectHudLabel(
  connect: Pick<ConnectFlow, 'stage' | 'sourcePartId' | 'targetPartId'>,
  document: ModelDocument,
  fallback: string,
): string {
  const sourceName = partLabel(connect.sourcePartId ? document.parts[connect.sourcePartId] : undefined)
  const targetName = partLabel(connect.targetPartId ? document.parts[connect.targetPartId] : undefined)
  if (sourceName && targetName) return `${sourceName} → ${targetName}`
  if (sourceName && connect.stage !== 'source') return `Moving ${sourceName}`
  return fallback
}

/**
 * Connect, as two explicit stages.
 *
 * The old behaviour was implicit: select a part, switch tool, click another
 * part, and a mate happened. That is fine when it guesses right and completely
 * opaque when it does not. Here the operator names the part that will move, sees
 * which of its connectors are live, names what it mates onto, and reviews the
 * ranked results before anything commits. Every stage can be backed out of.
 */

function ConnectorChips({
  connectors,
  selectedId,
  onSelect,
  label,
}: {
  connectors: readonly WorldConnector[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  label: string
}) {
  return (
    <div className="connector-chips" role="radiogroup" aria-label={label} data-connector-count={connectors.length}>
      <button
        type="button"
        role="radio"
        aria-checked={!selectedId}
        className={!selectedId ? 'active' : ''}
        onClick={() => onSelect(null)}
        title="Let the solver choose whichever connector seats best"
      >
        ANY
      </button>
      {connectors.map((connector) => (
        <button
          key={connector.id}
          type="button"
          role="radio"
          aria-checked={selectedId === connector.id}
          className={selectedId === connector.id ? 'active' : ''}
          onClick={() => onSelect(connector.id)}
          title={`${connector.family} · ${connector.gender}`}
        >
          <CircleDot size={8} className={connector.gender === 'male' ? 'male' : 'female'} />
          {connector.family}
        </button>
      ))}
    </div>
  )
}

export function ConnectPanel({ workbench }: { workbench: Workbench }) {
  const { state, connect, setConnect } = workbench
  const source = connect.sourcePartId ? state.document.parts[connect.sourcePartId] : undefined
  const target = connect.targetPartId ? state.document.parts[connect.targetPartId] : undefined

  const sourceConnectors = useMemo(() => (source ? getWorldConnectors(source) : []), [source])
  const targetConnectors = useMemo(() => (target ? getWorldConnectors(target) : []), [target])

  /**
   * Ranked mates for the current pair, restricted to whichever connectors the
   * operator pinned. The solver is the same one the drag path and the agent use.
   */
  const candidates = useMemo(() => {
    if (!source || !target) return []
    return legalConnectCandidates(source, target, state.document, {
      radiusLdu: 400,
      maxCandidates: 48,
      sourceFeatureId: connect.sourceFeatureId,
      targetFeatureId: connect.targetFeatureId,
    })
  }, [connect.sourceFeatureId, connect.targetFeatureId, source, state.document, target])

  const preview = candidates[connect.candidateIndex] ?? candidates[0]

  // A pinned connector that no longer yields any mate leaves the operator with
  // an empty list and no explanation, so the index is kept in range instead.
  useEffect(() => {
    if (connect.candidateIndex && connect.candidateIndex >= candidates.length) {
      setConnect({ ...connect, candidateIndex: 0 })
    }
  }, [candidates.length, connect, setConnect])

  const commit = useCallback(() => {
    if (!preview || !source) return
    const committed = canonicalisePose(preview.transform)
    const label = `Connect ${source.definitionId} to ${target?.definitionId ?? 'target'}`
    if (workbench.dispatch(label, [{ type: 'part.transform', partId: source.id, transform: committed }])) {
      cadEngine.setSelection([source.id])
      workbench.setConnect(IDLE_CONNECT)
    }
  }, [preview, source, target?.definitionId, workbench])

  const back = useCallback(() => {
    if (connect.stage === 'review')
      setConnect({ ...connect, stage: 'target', targetPartId: null, targetFeatureId: null, candidateIndex: 0 })
    else if (connect.stage === 'target') setConnect(IDLE_CONNECT)
  }, [connect, setConnect])

  const cycle = useCallback(() => {
    if (!candidates.length) return
    setConnect({ ...connect, candidateIndex: (connect.candidateIndex + 1) % candidates.length })
  }, [candidates.length, connect, setConnect])

  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (connect.stage === 'review') panelRef.current?.focus()
  }, [connect.stage])

  const onPanelKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (connect.stage !== 'review') return
      if (event.key === 'Tab' && !event.shiftKey && candidates.length > 1) {
        event.preventDefault()
        cycle()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    },
    [candidates.length, commit, connect.stage, cycle],
  )

  const stageIndex = connect.stage === 'source' ? 0 : connect.stage === 'target' ? 1 : 2

  return (
    <div
      ref={panelRef}
      className="connect-panel"
      data-stage={connect.stage}
      tabIndex={connect.stage === 'review' ? 0 : undefined}
      onKeyDown={onPanelKey}
      aria-label={
        connect.stage === 'review'
          ? 'Connect review. Tab cycles solutions, Shift+Tab leaves, Enter commits.'
          : undefined
      }
    >
      <ol className="connect-stages" aria-label="Connect progress">
        {['Pick the part that moves', 'Pick what it mates onto', 'Review and commit'].map((label, index) => (
          <li
            key={label}
            className={index === stageIndex ? 'current' : index < stageIndex ? 'done' : ''}
            aria-current={index === stageIndex}
          >
            <span>{index < stageIndex ? <Check size={9} /> : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {connect.stage === 'source' && (
        <p className="connect-hint">
          Click a part in the viewport. Nothing commits until the final stage, and <kbd>Esc</kbd> backs out at any
          point.
        </p>
      )}

      {source && (
        <section className="connect-side">
          <header>
            <span className="eyebrow">MOVING</span>
            <strong>{catalog.get(source.definitionId)?.name ?? source.definitionId}</strong>
            <em>{sourceConnectors.length} connectors</em>
          </header>
          <ConnectorChips
            label="Source connector"
            connectors={sourceConnectors}
            selectedId={connect.sourceFeatureId}
            onSelect={(id) => setConnect({ ...connect, sourceFeatureId: id, candidateIndex: 0 })}
          />
        </section>
      )}

      {connect.stage !== 'source' && !target && (
        <p className="connect-hint">
          Now click the part it should mate onto. Compatible connectors on that part are listed once it is picked.
        </p>
      )}

      {target && (
        <section className="connect-side">
          <header>
            <span className="eyebrow">TARGET</span>
            <strong>{catalog.get(target.definitionId)?.name ?? target.definitionId}</strong>
            <em>{targetConnectors.length} connectors</em>
          </header>
          <ConnectorChips
            label="Target connector"
            connectors={targetConnectors}
            selectedId={connect.targetFeatureId}
            onSelect={(id) => setConnect({ ...connect, targetFeatureId: id, candidateIndex: 0 })}
          />
        </section>
      )}

      {connect.stage === 'review' && (
        <section className="connect-review">
          <header>
            <span className="eyebrow">RESULTING MATE</span>
            <em>
              {candidates.length} solution{candidates.length === 1 ? '' : 's'}
            </em>
          </header>
          {preview ? (
            <>
              <dl className="connect-preview">
                <div>
                  <dt>Simultaneous mates</dt>
                  <dd>{preview.matches.length}</dd>
                </div>
                <div>
                  <dt>Certainty</dt>
                  <dd>{preview.certainty}</dd>
                </div>
                <div>
                  <dt>Moves</dt>
                  <dd>
                    {preview.cursorTranslationLdu.toFixed(1)} LDU · {preview.cursorRotationDeg.toFixed(1)}°
                  </dd>
                </div>
                <div>
                  <dt>Seat</dt>
                  <dd>
                    {preview.movingFeatureId} → {preview.targetFeatureId}
                  </dd>
                </div>
              </dl>
              <div className="connect-cycle">
                <button
                  type="button"
                  onClick={cycle}
                  disabled={candidates.length < 2}
                  title={candidates.length < 2 ? 'Only one solution' : 'Cycle to the next ranked mate'}
                >
                  Solution {connect.candidateIndex + 1} of {candidates.length}
                </button>
              </div>
            </>
          ) : (
            <p className="connect-empty">
              No legal mate exists between these two parts with the connectors chosen. Widen either side to ANY, or pick
              a different target — the solver refuses rather than inventing a pose.
            </p>
          )}
        </section>
      )}

      <footer className="connect-actions">
        <button
          type="button"
          onClick={back}
          disabled={connect.stage === 'source'}
          title={connect.stage === 'source' ? 'Nothing to go back to' : 'Back one stage'}
        >
          <ArrowLeft size={12} /> BACK
        </button>
        <button type="button" onClick={() => setConnect(IDLE_CONNECT)} title="Abandon this mate">
          <X size={12} /> CANCEL
        </button>
        <button
          type="button"
          className="connect-commit"
          disabled={!preview}
          onClick={commit}
          title={preview ? 'Commit this mate as one transaction' : 'Pick two parts with a legal mate first'}
        >
          <Link2 size={13} /> CONNECT
        </button>
      </footer>
    </div>
  )
}
