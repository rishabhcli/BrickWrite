import { Bookmark, Crosshair, Eye, EyeOff, Ghost, Scan, Trash2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { cadEngine } from '../../cad/engine'
import { resolveSavedSelection, SELECTION_MODES, visibilityActive, type SelectionMode } from './selection'
import type { Workbench } from './useWorkbench'

/**
 * Selection modes, saved sets and visibility.
 *
 * Selection is the operation a large model spends most of its time on, and
 * clicking bricks one at a time does not scale past a few dozen. Each mode here
 * reads evidence the document already holds — colour, the connection graph,
 * subassembly membership — so none of it is a heuristic guess.
 */
export function SelectionPanel({ workbench }: { workbench: Workbench }) {
  const { state, savedSelections, visibility } = workbench
  const [name, setName] = useState('')
  const selected = state.selection.length
  const total = state.validation.partCount

  const apply = useCallback((mode: SelectionMode) => {
    workbench.applySelectionMode(mode)
  }, [workbench])

  return (
    <div className="selection-panel">
      <div className="selection-summary" role="status">
        <strong>{selected ? `${selected} of ${total} selected` : 'Nothing selected'}</strong>
        <small>
          {selected
            ? 'Modes below expand the selection from what the document already records.'
            : 'Click a part, or shift-drag a box in the viewport.'}
        </small>
      </div>

      <div className="selection-modes" role="group" aria-label="Selection modes">
        {SELECTION_MODES.map((mode) => {
          const blocked = mode.needsSeed && !selected
          return (
            <button
              key={mode.id}
              type="button"
              disabled={blocked}
              className={workbench.selectionMode === mode.id ? 'active' : ''}
              title={blocked ? `${mode.hint} — select at least one part first.` : mode.hint}
              aria-label={blocked ? `${mode.label} — select at least one part first` : mode.label}
              aria-keyshortcuts={mode.shortcut}
              onClick={() => apply(mode.id)}
            >
              {mode.label}
            </button>
          )
        })}
      </div>

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
        <button
          type="button"
          className="selection-show-all"
          disabled={!visibilityActive(visibility)}
          title={visibilityActive(visibility) ? 'Clear hide, isolate and ghost.' : 'Nothing is hidden, isolated or ghosted.'}
          onClick={() => workbench.showEverything()}
        >
          <Eye size={12} /> Show everything<kbd>⇧H</kbd>
        </button>
      </div>

      <div className="selection-sets">
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
        {savedSelections.length === 0 ? (
          <p className="selection-empty">
            A saved set survives edits and reloads. It records part ids, so a set captured before a delete says how
            many of its parts are still there rather than silently shrinking.
          </p>
        ) : (
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
    </div>
  )
}
