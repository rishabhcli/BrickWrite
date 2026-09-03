import { Bookmark, Box, Crosshair, Eye, EyeOff, Ghost, Lock, Scan, Trash2, Unlock } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { describeSize, getColor } from '../../cad/catalog'
import { cadEngine } from '../../cad/engine'
import { resolveSavedSelection, SELECTION_MODES, visibilityActive, type SelectionMode } from './selection'
import { formatChord, type ShortcutMap } from './shortcuts'
import type { Workbench } from './useWorkbench'

/**
 * What is selected, and what can be done to it.
 *
 * Selection is the operation a large model spends most of its time on, and
 * clicking bricks one at a time does not scale past a few dozen. Each mode here
 * reads evidence the document already holds — colour, the connection graph,
 * subassembly membership — so none of it is a heuristic guess.
 *
 * The identity card at the top is the half the deleted Inspector was actually
 * carrying: which part this is, in which colour, and whether the agent may
 * touch it. Its other half — position and rotation fields — is the Transform
 * block directly underneath, and having both was the duplication.
 */
export function SelectionPanel({ workbench, shortcuts }: { workbench: Workbench; shortcuts: ShortcutMap }) {
  const { state, savedSelections, visibility, selectedPart, selectedDefinition } = workbench
  const [name, setName] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const selected = state.selection.length
  const total = state.validation.partCount
  const parts = state.selection.map((id) => state.document.parts[id]).filter(Boolean)
  const kinds = new Set(parts.map((part) => part.definitionId)).size
  const allProtected = parts.length > 0 && parts.every((part) => part.protected)

  const apply = useCallback((mode: SelectionMode) => {
    workbench.applySelectionMode(mode)
  }, [workbench])

  const [inline, extra] = useMemo(
    () => [SELECTION_MODES.filter((mode) => mode.primary), SELECTION_MODES.filter((mode) => !mode.primary)],
    [],
  )

  const modeButton = (mode: (typeof SELECTION_MODES)[number]) => {
    const chord = mode.commandId ? formatChord(shortcuts[mode.commandId]) : ''
    return (
      <button
        key={mode.id}
        type="button"
        className={workbench.selectionMode === mode.id ? 'active' : ''}
        title={chord ? `${mode.hint} (${chord})` : mode.hint}
        aria-label={mode.label}
        aria-keyshortcuts={chord || undefined}
        onClick={() => apply(mode.id)}
      >
        {mode.label}
      </button>
    )
  }

  return (
    <div className={`selection-panel ${selected ? '' : 'is-empty'}`}>
      {selected > 0 && (
        <section className="selection-identity">
          <div
            className="selected-glyph"
            style={
              selectedPart ? ({ '--swatch': getColor(selectedPart.color).hex } as React.CSSProperties) : undefined
            }
          >
            <Box size={20} strokeWidth={1.4} />
          </div>
          <div className="selection-identity-text">
            {selectedPart && selectedDefinition ? (
              <>
                <h3>{selectedDefinition.name}</h3>
                <p>
                  {selectedDefinition.canonicalId} · {describeSize(selectedDefinition)} ·{' '}
                  {getColor(selectedPart.color).name}
                </p>
              </>
            ) : (
              <>
                <h3>
                  {selected} parts selected
                </h3>
                <p>
                  {kinds} kind{kinds === 1 ? '' : 's'} · {selected} of {total} in the model
                </p>
              </>
            )}
          </div>
          <button
            type="button"
            className={`selection-protect ${allProtected ? 'on' : ''}`}
            aria-pressed={allProtected}
            title={
              allProtected
                ? 'Protected. The agent will design around these parts.'
                : 'Protect these parts from agent edits.'
            }
            aria-label={allProtected ? 'Unprotect the selection' : 'Protect the selection from agent edits'}
            onClick={() => workbench.protectSelection(!allProtected)}
          >
            {allProtected ? <Lock size={12} /> : <Unlock size={12} />}
          </button>
        </section>
      )}
      <div className="selection-summary" role="status">
        <strong>{selected ? `${selected} of ${total} selected` : 'Nothing selected'}</strong>
        {/* Only the empty state earns a sentence, because only the empty state
         * is asking for something. Once parts are selected the count says it,
         * and the buttons underneath are labelled. */}
        {selected ? null : <small>Click a part, or shift-drag a box.</small>}
      </div>

      {selected > 0 && (
        <>
          <div className="selection-modes" role="group" aria-label="Selection modes">
            {inline.map(modeButton)}
            <button
              type="button"
              className={`selection-more ${moreOpen ? 'active' : ''}`}
              aria-expanded={moreOpen}
              aria-controls="selection-more-ways"
              title="Module, same part, visible, inverse, and saved sets"
              onClick={() => setMoreOpen((open) => !open)}
            >
              More…
            </button>
          </div>
          {moreOpen && (
            <div className="selection-modes selection-modes-extra" id="selection-more-ways" role="group" aria-label="More ways to select">
              {extra.map(modeButton)}
            </div>
          )}

          <div className="selection-actions" role="group" aria-label="Visibility">
            <button
              type="button"
              disabled={!selected}
              title={selected ? 'Stop drawing the selection. The document is unchanged.' : 'Select at least one part first.'}
              onClick={() => workbench.hideSelection()}
            >
              <EyeOff size={12} /> Hide<kbd>H</kbd>
            </button>
            <button
              type="button"
              disabled={!selected}
              title={selected ? 'Draw only the selection until cleared.' : 'Select at least one part first.'}
              onClick={() => workbench.isolateSelection()}
            >
              <Scan size={12} /> Isolate<kbd>⇧I</kbd>
            </button>
            <button
              type="button"
              disabled={!selected}
              title={selected ? 'Draw the selection translucent so its context stays readable.' : 'Select at least one part first.'}
              onClick={() => workbench.ghostSelection()}
            >
              <Ghost size={12} /> Ghost<kbd>⇧G</kbd>
            </button>
            <button
              type="button"
              disabled={!selected}
              title={selected ? 'Frame the camera tightly on the selection.' : 'Select at least one part first.'}
              onClick={() => workbench.focusSelection()}
            >
              <Crosshair size={12} /> Focus<kbd>⇧F</kbd>
            </button>
          </div>
        </>
      )}

      {visibilityActive(visibility) && (
        <div className="selection-actions" role="group" aria-label="Restore visibility">
          <button
            type="button"
            className="selection-show-all"
            title="Clear hide, isolate and ghost."
            onClick={() => workbench.showEverything()}
          >
            <Eye size={12} /> Show everything<kbd>⇧H</kbd>
          </button>
        </div>
      )}

      {moreOpen && (selected > 0 || savedSelections.length > 0) && (
        <div className="selection-sets">
          {selected > 0 && (
            <>
              <header>
                <span className="eyebrow">SAVED SETS</span>
                <em>{savedSelections.length}</em>
              </header>
              <div className="selection-save">
                <input
                  value={name}
                  placeholder="Name this selection"
                  aria-label="Selection set name"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || !name.trim()) return
                    event.preventDefault()
                    if (workbench.saveSelectionSet(name.trim())) setName('')
                  }}
                />
                <button
                  type="button"
                  disabled={!selected || !name.trim()}
                  title={!selected ? 'Select at least one part first.' : !name.trim() ? 'Give the set a name.' : `Save ${selected} parts as “${name.trim()}”`}
                  onClick={() => { if (workbench.saveSelectionSet(name.trim())) setName('') }}
                >
                  <Bookmark size={11} /> SAVE
                </button>
              </div>
            </>
          )}
          {savedSelections.length > 0 && (
            <ul>
              {savedSelections.map((set) => {
                const { present, missing } = resolveSavedSelection(state.document, set)
                return (
                  <li key={set.id}>
                    <button
                      type="button"
                      className="selection-set-open"
                      disabled={!present.length}
                      title={missing
                        ? `${present.length} of ${set.partIds.length} parts still exist; ${missing} were removed after r${set.revision}.`
                        : `Select ${present.length} parts saved at r${set.revision}`}
                      onClick={() => cadEngine.setSelection(present)}
                    >
                      <strong>{set.name}</strong>
                      <small>{present.length} part{present.length === 1 ? '' : 's'}{missing ? ` · ${missing} gone` : ''}</small>
                    </button>
                    <button
                      type="button"
                      className="selection-set-delete"
                      aria-label={`Delete the saved set ${set.name}`}
                      onClick={() => workbench.deleteSelectionSet(set.id)}
                    >
                      <Trash2 size={11} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
