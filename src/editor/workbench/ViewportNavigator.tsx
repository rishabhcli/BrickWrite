import type { CameraView } from '../CadViewport'
import { GlassIsland } from '../../ui/liquid'
import { WorkbenchIcon } from './WorkbenchIcons'

type ViewportNavigatorProps = {
  view: CameraView
  onView: (view: CameraView) => void
}

/**
 * A compact CAD orientation cube.
 *
 * The old camera dropdown made every canonical view two actions away and hid
 * the available directions. The three visible faces go directly to Top, Front
 * and Right, and one button returns to the isometric home.
 *
 * The −X and −Z opposites used to sit beside home. They are one orbit-drag
 * away — the focused canvas orbits on the arrow keys — and both now have a
 * chord and a palette entry, so the cube spends its corner of the model on the
 * three faces it can actually draw.
 */
export function ViewportNavigator({ view, onView }: ViewportNavigatorProps) {
  const viewButton = (next: CameraView, label: string, className: string, mark: React.ReactNode) => (
    <button
      type="button"
      className={className}
      aria-label={`${label} view`}
      aria-pressed={view === next}
      title={`${label} view`}
      onClick={() => onView(next)}
    >
      {mark}
    </button>
  )

  return (
    <GlassIsland className="viewport-navigator" radius="section" blur="control">
      <div className="view-cube" role="toolbar" aria-label="Camera orientation">
        {viewButton('top', 'Top', 'view-cube-face view-cube-top', <span>Y</span>)}
        {viewButton('front', 'Front', 'view-cube-face view-cube-front', <span>Z</span>)}
        {viewButton('right', 'Right', 'view-cube-face view-cube-right', <span>X</span>)}
      </div>
      <div className="view-cube-opposites" role="group" aria-label="Home view">
        {viewButton('isometric', 'Isometric', 'view-home', <WorkbenchIcon name="iso" size={15} />)}
      </div>
    </GlassIsland>
  )
}
