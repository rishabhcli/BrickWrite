import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource-variable/manrope'
import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { LandingPage } from './LandingPage'
import { useLandingRoute } from './navigation'
import '../../styles.css'

const ExplorePage = lazy(() => import('../explore/ExplorePage'))

/**
 * The landing and explore surfaces, mounted without the application shell.
 *
 * This exists to be *measured*. `src/main.tsx` mounts these inside the platform
 * shell, which statically imports the Hexclave account SDK; that is the right
 * shape for the product and the wrong shape for answering "what does this page
 * cost?", because the answer would be dominated by a dependency neither surface
 * uses. `tools/e2e/landing.mjs` builds this entry and measures LCP and CLS
 * against it, and states in its report exactly what that number does and does
 * not include.
 *
 * It is also a standing proof that neither surface depends on the shell: if one
 * of them ever reaches for a router, a boot stage or an account session, this
 * entry stops working and the acceptance run says so.
 */
function Standalone() {
  const route = useLandingRoute()
  if (route.surface === 'explore') {
    return (
      <Suspense fallback={<div className="bw-surface" style={{ minHeight: '100vh' }} />}>
        <ExplorePage />
      </Suspense>
    )
  }
  return <LandingPage />
}

const mount = document.getElementById('root')
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <Standalone />
    </StrictMode>,
  )
}

export default Standalone
