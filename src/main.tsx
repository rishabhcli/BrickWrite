import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource-variable/manrope'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell, registerRoute } from './platform'
import './styles.css'

/**
 * Boot sequence.
 *
 * Every surface is registered here and loaded lazily. The shell owns what a
 * route may download before it paints — the compiled catalog, the CAD kernel
 * and the session are staged per route, not fetched universally. There is still
 * no procedural fallback catalog: a route that declared it needs one and cannot
 * get it says so and refuses to start. See docs/integration/platform-shell.md.
 *
 * Surfaces still under construction are deliberately absent rather than stubbed
 * here: an unregistered id renders the shell's "not installed in this build"
 * state, which is a truthful answer, and each workstream adds its own line.
 */
registerRoute('landing', () => import('./features/landing/LandingPage'))
registerRoute('explore', () => import('./features/explore/ExplorePage'))
registerRoute('editor', () => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
