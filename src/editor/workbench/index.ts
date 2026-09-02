/**
 * Workstream 5 — the workbench UI.
 *
 * Everything another workstream needs is exported here. The extension registry
 * is the contract: register into a named slot and the shell renders you, with
 * no edits to any file this workstream owns.
 *
 * See docs/integration/workbench-ui.md for the worked example.
 */

export { Workbench, type WorkbenchProps } from './Workbench'

export {
  Contribution,
  createExtensionRegistry,
  ExtensionRegistryProvider,
  ModalSlot,
  Slot,
  useContributions,
  useExtensionRegistry,
  useOnlineStatus,
  useRegisterContribution,
  useSlotOccupied,
  useWorkbenchApi,
  WORKBENCH_SLOTS,
  type ExtensionRegistry,
  type WorkbenchApi,
  type WorkbenchContribution,
  type WorkbenchNotice,
  type WorkbenchSlotId,
} from './ExtensionRegistry'

export {
  applyLocks,
  gizmoAxisVisible,
  gizmoSpace,
  lockRotation,
  readSelectionAttitude,
  canonicalisePose,
  connectorFrame,
  gizmoPose,
  numericPose,
  planAlign,
  planDistribute,
  planRotateSelection,
  planTranslateSelection,
  poseKey,
  posesEqual,
  readNumericPose,
  referenceBasis,
  resolvePivot,
  rotatePose,
  selectionExtent,
  snapPosition,
  translatePose,
  type AlignEdge,
  type AxisLocks,
  type NumericPose,
  type PivotMode,
  type ReferenceFrame,
} from './transform'

export {
  applyVisibility,
  connectedComponent,
  describeVisibility,
  hiddenPartIds,
  resolveSavedSelection,
  resolveSelection,
  SELECTION_MODES,
  visibilityActive,
  type SavedSelection,
  type SelectionMode,
  type VisibilityState,
} from './selection'

export {
  chordFromEvent,
  commandForChord,
  defaultShortcutMap,
  detectConflicts,
  formatChord,
  loadShortcutMap,
  normaliseChord,
  saveShortcutMap,
  WORKBENCH_COMMANDS,
  type CommandDefinition,
  type ShortcutMap,
} from './shortcuts'

export {
  clampLayout,
  defaultLayout,
  DOCK_LIMITS,
  LAYOUT_PRESETS,
  loadLayout,
  recommendedPreset,
  workspaceColumns,
  type DockId,
  type LayoutPresetId,
  type WorkbenchLayout,
} from './layout'

export { readPreference, usePersistentState, writePreference } from './persistence'
export { useWorkbench, type Workbench as WorkbenchController } from './useWorkbench'
export { PalettePanel } from './PalettePanel'
export { InspectorPanel, type ArticulationControl, type InspectorView } from './InspectorPanel'
export { ModelHealthPanel, type ModelHealthPanelProps } from './ModelHealthPanel'
export { TimelinePanel } from './TimelinePanel'
export { AutonomySwitch, ColorLabel } from './AutonomySwitch'
export { SelectionPanel } from './SelectionPanel'
export { ModelExplorerPanel } from './ModelExplorerPanel'
export { TransformPanel } from './TransformPanel'
export { ConnectPanel } from './ConnectPanel'
export { CommandPalette } from './CommandPalette'
export {
  BusyState,
  EmptyBuildState,
  InvalidSelectionState,
  OfflineState,
  ProposalReviewState,
  UnavailablePartState,
} from './states'
