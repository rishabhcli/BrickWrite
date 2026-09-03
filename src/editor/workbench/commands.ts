import { cadEngine } from '../../cad/engine'
import type { DockId } from './layout'
import { nextGridPreset } from './transform'
import type { Workbench } from './useWorkbench'

/**
 * The command table.
 *
 * Every keyboard shortcut, every command-palette row and every menu item runs
 * one of these. Keeping them in one place is what makes the shortcut map
 * remappable at all: a binding is a string pointing at an id, not a branch in a
 * `keydown` handler.
 */

export interface CommandHost {
  readonly workbench: Workbench
  toggleDock(dock: DockId): void
  focusSearch(): void
  exportLdr(): void
  resetWorkspace(): void
}

export interface CommandOutcome {
  ran: boolean
  /** Why it did nothing, shown in the palette and the status bar. */
  reason?: string
}

const ok: CommandOutcome = { ran: true }
const refuse = (reason: string): CommandOutcome => ({ ran: false, reason })

/**
 * Why a command is unavailable right now, or null when it will run.
 *
 * Surfaced on the palette row and as the toolbar button's tooltip, so a greyed
 * control always says what would make it live again.
 */
export function disabledReason(commandId: string, workbench: Workbench): string | null {
  const { state } = workbench
  const selected = state.selection.length
  if (['edit.reposition', 'edit.build-another'].includes(commandId) && selected !== 1) return 'Select one part first.'
  const needsSelection = [
    'edit.clone',
    'edit.delete',
    'edit.quarter-turn',
    'edit.mirror',
    'edit.array',
    'edit.copy',
    'edit.cut',
    'edit.ground',
    'edit.protect',
    'edit.paint',
    'edit.eyedropper',
    'select.inverse',
    'select.connected',
    'select.colour',
    'select.subassembly',
    'select.definition',
    'select.save',
    'visibility.hide',
    'visibility.isolate',
    'visibility.ghost',
  ]
  if (needsSelection.includes(commandId) && !selected) return 'Select at least one part first.'
  if (commandId === 'edit.paste' && !workbench.clipboard) return 'Copy or cut parts in this editor first.'
  if (commandId === 'edit.undo' && !state.canUndo) return 'Nothing to undo.'
  if (commandId === 'edit.redo' && !state.canRedo) return 'Nothing to redo.'
  if (
    commandId === 'visibility.show-all' &&
    !workbench.visibility.hidden.size &&
    !workbench.visibility.isolated &&
    !workbench.visibility.ghosted.size
  )
    return 'Nothing is hidden, isolated or ghosted.'
  if (commandId === 'project.resequence' && !state.validation.partCount)
    return 'Place parts before generating a build order.'
  return null
}

export function createCommandHandlers(host: CommandHost): Record<string, () => CommandOutcome> {
  const w = host.workbench
  const run = (action: () => unknown): CommandOutcome => {
    action()
    return ok
  }
  // The controller already reports a precise kernel refusal. Do not overwrite
  // it with "select a part" when a selected part simply could not be moved.
  const editSelection = (action: () => boolean): CommandOutcome =>
    w.state.selection.length ? { ran: action() } : refuse('Select at least one part first.')

  return {
    // Tools ---------------------------------------------------------------
    'tool.select': () => run(() => w.setTool('select')),
    'tool.move': () => run(() => w.setTool('move')),
    'tool.rotate': () =>
      run(() => {
        // While a ghost follows the cursor, R turns the ghost. Only once nothing
        // is armed does it mean "pick up the rotate tool".
        if (w.placement) w.rotatePlacement()
        else w.setTool('rotate')
      }),
    'tool.connect': () => run(() => w.setTool('connect')),

    // Edit ----------------------------------------------------------------
    'edit.reposition': () => (w.pickUpSelection() ? ok : refuse('Select one part to pick up.')),
    'edit.build-another': () => (w.pickUpSelection(true) ? ok : refuse('Select one part to repeat.')),
    'edit.undo': () => (w.state.canUndo ? { ran: w.replayHistory('undo') } : refuse('Nothing to undo.')),
    'edit.redo': () => (w.state.canRedo ? { ran: w.replayHistory('redo') } : refuse('Nothing to redo.')),
    'edit.clone': () => editSelection(w.duplicateSelection),
    'edit.copy': () => ({ ran: w.copySelection() }),
    'edit.cut': () => ({ ran: w.copySelection(true) }),
    'edit.paste': () => (w.clipboard ? { ran: w.pasteSelection() } : refuse('Copy or cut parts in this editor first.')),
    'edit.ground': () => ({ ran: w.groundSelection() }),
    'edit.delete': () => editSelection(w.deleteSelection),
    'edit.quarter-turn': () =>
      w.placement ? run(() => w.rotatePlacement(-1)) : editSelection(() => w.rotateSelection(90)),
    // Across X, about the selection's own centre — the same defaults the
    // Mirror panel opens with, so the shortcut is the fast path to that command
    // rather than a second one. Reflecting through the world origin is still
    // reachable from the panel.
    'edit.mirror': () => editSelection(() => w.runSharedMutation('mirror_selection', { axis: 'x', about: 'selection' })),
    'edit.array': () => run(() => w.setModal('core:capability:linear_array')),
    'edit.protect': () => editSelection(w.toggleProtectSelection),
    'edit.paint': () => editSelection(() => w.recolorSelection(w.activeColor)),
    'edit.eyedropper': () => (w.pickColorFromSelection() ? ok : refuse('Select a part to sample.')),

    // Selection -----------------------------------------------------------
    'select.all': () => run(() => w.applySelectionMode('visible')),
    'select.none': () => run(() => cadEngine.setSelection([])),
    'select.inverse': () => run(() => w.applySelectionMode('inverse')),
    'select.connected': () => run(() => w.applySelectionMode('connected')),
    'select.colour': () => run(() => w.applySelectionMode('colour')),
    'select.subassembly': () => run(() => w.applySelectionMode('subassembly')),
    'select.definition': () => run(() => w.applySelectionMode('definition')),
    'select.save': () => run(() => w.setModal('core:save-selection')),

    // View ----------------------------------------------------------------
    'view.fit': () => run(() => w.fitView()),
    'view.iso': () => run(() => w.setCameraView('isometric')),
    'view.front': () => run(() => w.setCameraView('front')),
    'view.top': () => run(() => w.setCameraView('top')),
    'view.left': () => run(() => w.setCameraView('left')),
    'view.rear': () => run(() => w.setCameraView('rear')),
    'view.beauty': () => run(() => w.setRenderMode('beauty')),
    'view.connections': () => run(() => w.setRenderMode('connections')),
    'view.violations': () => run(() => w.setRenderMode('violations')),
    'view.exploded': () => run(() => w.setRenderMode('exploded')),
    // Toggles rather than sets: the island button it replaced was a toggle, and
    // a one-way "go orthographic" leaves no way back without a second chord.
    'view.orthographic': () =>
      run(() => w.setRenderMode(w.renderMode === 'orthographic' ? 'beauty' : 'orthographic')),
    'view.silhouette': () => run(() => w.setRenderMode('silhouette')),
    'view.snap-fine': () => run(() => w.setGridLdu(nextGridPreset(w.gridLdu))),

    // Visibility ----------------------------------------------------------
    'visibility.hide': () => (w.hideSelection() ? ok : refuse('Select at least one part first.')),
    'visibility.show-all': () => run(() => w.showEverything()),
    'visibility.isolate': () => (w.isolateSelection() ? ok : refuse('Select at least one part first.')),
    'visibility.ghost': () => (w.ghostSelection() ? ok : refuse('Select at least one part first.')),
    'visibility.focus': () => run(() => w.focusSelection()),

    // Panels ---------------------------------------------------------------
    'panel.left': () => run(() => host.toggleDock('left')),
    'panel.right': () => run(() => host.toggleDock('right')),
    'panel.bottom': () => run(() => host.toggleDock('bottom')),
    'panel.search': () => run(() => host.focusSearch()),

    // Project --------------------------------------------------------------
    'project.command-palette': () => run(() => w.setModal('core:command-palette')),
    'project.export': () => run(() => host.exportLdr()),
    'project.resequence': () => (w.regenerateBuildOrder() ? ok : refuse('Nothing to sequence.')),

    // Help -----------------------------------------------------------------
    'help.shortcuts': () => run(() => w.setModal(w.modal === 'core:shortcuts' ? null : 'core:shortcuts')),
    'help.welcome': () => run(() => w.setModal('core:welcome')),
    'help.keymap': () => run(() => w.setModal('core:keymap')),
    'help.reset-workspace': () => run(() => host.resetWorkspace()),
  }
}
