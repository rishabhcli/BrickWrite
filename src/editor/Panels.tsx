/**
 * Compatibility surface for the panels that moved into the workbench.
 *
 * The catalog, inspector and timeline are now `src/editor/workbench/*Panel.tsx`,
 * where they sit alongside the dock that arranges them. This file stays so that
 * imports written against the old layout keep resolving; new code should import
 * from `src/editor/workbench`.
 */
export { PalettePanel as CatalogPanel } from './workbench/PalettePanel'
export { InspectorPanel, type ArticulationControl } from './workbench/InspectorPanel'
export { TimelinePanel as Timeline } from './workbench/TimelinePanel'
export { AutonomySwitch, ColorLabel } from './workbench/AutonomySwitch'
