import type { ComponentType } from 'react'
import type { RouteId } from './contracts'
import { StatePanel } from './states'

/**
 * A route id nothing has registered a surface for.
 *
 * This is the single deliberate placeholder in the platform layer. It is honest
 * about what it is: the route exists in the shell's table, and the build simply
 * does not contain the surface. It is not a mock of the missing feature.
 *
 * This lives outside `states.tsx` so the route table can lazy-load the uncommon
 * fallback without producing an ineffective dynamic-import warning for the
 * state components that the shell needs immediately.
 */
export function NotInstalledSurface({ route }: { route: RouteId }) {
  return (
    <StatePanel
      tone="notice"
      eyebrow="SURFACE NOT INSTALLED"
      heading={`The "${route}" surface is not installed in this build`}
      actions={
        <a className="pf-button pf-button--primary" href="/">
          Back to the start
        </a>
      }
    >
      <p>
        The application shell knows this route, but no module has registered a surface for it. That
        is a build composition fact, not an error: Brickwright ships its surfaces independently, and
        this one is absent here.
      </p>
      <p className="pf-state__hint">
        To install it, call <code>registerRoute('{route}', () =&gt; import(…))</code> before the
        shell mounts.
      </p>
    </StatePanel>
  )
}

/** Wrap the placeholder as a zero-prop surface the route table can load. */
export function createNotInstalledSurface(route: RouteId): ComponentType {
  function NotInstalledRoute() {
    return <NotInstalledSurface route={route} />
  }
  NotInstalledRoute.displayName = `NotInstalledSurface(${route})`
  return NotInstalledRoute
}
