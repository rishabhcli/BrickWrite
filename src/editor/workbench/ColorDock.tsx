import { Check, ChevronDown, Paintbrush, PlusSquare } from 'lucide-react'
import { catalog, getColor } from '../../cad/catalog'
import { useCadSnapshot } from '../useCad'
import type { EngineSnapshot } from '../../cad/types'

const selectCount = (snapshot: EngineSnapshot) => snapshot.selection.length

export interface ColorDockProps {
  activeColor: number
  colours: readonly number[]
  expanded: boolean
  favourites: readonly number[]
  onToggleExpanded: () => void
  onColorChange: (color: number) => void
  onToggleFavourite: (code: number) => void
}

/**
 * The colour strip, and which of its two jobs the next click will do.
 *
 * A swatch repaints the selection when there is one and loads the next brick
 * when there is not. Both used to be the same silent click with nothing on
 * screen naming the difference, and "I clicked red and nothing happened" is how
 * a beginner concludes the editor is broken.
 *
 * It subscribes to the selection *count* itself rather than taking it as a
 * prop, because its parent is memoised precisely so that a selection-only
 * commit does not re-render sixty part cards. Six characters of state do not
 * get to dissolve that (see the contract on `PalettePanel`).
 */
export function ColorDock({
  activeColor,
  colours,
  expanded,
  favourites,
  onToggleExpanded,
  onColorChange,
  onToggleFavourite,
}: ColorDockProps) {
  const selected = useCadSnapshot(selectCount)
  const active = getColor(activeColor)

  return (
    <div className={`palette-dock ${expanded ? 'expanded' : ''}`} data-target={selected ? 'selection' : 'next'}>
      <div className="palette-label">
        <span className="palette-target">
          {selected ? (
            <>
              <Paintbrush size={11} aria-hidden="true" />
              Paints {selected} selected
            </>
          ) : (
            <>
              <PlusSquare size={11} aria-hidden="true" />
              Colours the next brick
            </>
          )}
        </span>
        <button
          type="button"
          className="palette-expand"
          aria-expanded={expanded}
          aria-label={expanded ? 'Show the everyday palette' : `Show all ${catalog.colors().length} LDraw colours`}
          title={expanded ? 'Show the everyday palette' : `Show all ${catalog.colors().length} LDraw colours`}
          onClick={onToggleExpanded}
        >
          {expanded ? 'FEWER' : 'ALL'}
          <ChevronDown size={11} />
        </button>
      </div>
      <div className="palette-current">
        <i style={{ '--swatch': active.hex } as React.CSSProperties} aria-hidden="true" />
        <strong>{active.name}</strong>
        <em>LDraw {active.code}</em>
      </div>
      <div className="swatches" role="group" aria-label="Colours">
        {colours
          .map((code) => getColor(code))
          .map((color) => (
            <button
              key={color.code}
              type="button"
              className={`${activeColor === color.code ? 'selected' : ''} ${favourites.includes(color.code) ? 'favourite' : ''}`}
              style={{ '--swatch': color.hex } as React.CSSProperties}
              onClick={() => onColorChange(color.code)}
              onContextMenu={(event) => {
                event.preventDefault()
                onToggleFavourite(color.code)
              }}
              aria-label={selected ? `Paint the selection ${color.name}` : `Use ${color.name} for the next brick`}
              aria-pressed={activeColor === color.code}
              title={`${color.name} · LDraw ${color.code} · ${selected ? `paints ${selected} selected part${selected === 1 ? '' : 's'}` : 'loads the next brick'} · right-click to ${favourites.includes(color.code) ? 'unpin' : 'pin'}`}
            >
              {favourites.includes(color.code) ? <Check size={8} /> : null}
            </button>
          ))}
      </div>
    </div>
  )
}
