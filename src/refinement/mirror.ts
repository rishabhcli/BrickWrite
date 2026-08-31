/**
 * Re-export of the kernel's reflection geometry.
 *
 * The arithmetic and the chirality test moved to `src/cad/mirror.ts` so the
 * editor's Mirror command and this search share one definition of what a mirror
 * is. The refinement package keeps this module path because its strategies and
 * its public surface import from it.
 */
export { canMirror, mirrorPlaneFor, mirrorTransform, type MirrorAxis } from '../cad/mirror'
