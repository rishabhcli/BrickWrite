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
 * the available directions. The three visible faces now go directly to Top,
 * Front and Right; the back row exposes the opposite axes and the isometric
 * home view without spending model space on words.
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
      <div className="view-cube-opposites" role="group" aria-label="Opposite and home views">
        {viewButton('left', 'Left', 'view-axis view-axis-x', <span>−X</span>)}
        {viewButton('isometric', 'Isometric', 'view-home', <WorkbenchIcon name="iso" size={15} />)}
        {viewButton('rear', 'Back', 'view-axis view-axis-z', <span>−Z</span>)}
      </div>
    </GlassIsland>
  )
}
