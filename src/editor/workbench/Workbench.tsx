import { Blocks, Boxes, Check, CircleDot, Move3d, MousePointer2, SlidersHorizontal, X } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { exportLDraw, downloadText } from '../../cad/ldraw'
import { cadEngine } from '../../cad/engine'
import { CommandDeck } from '../CommandDeck'
import { ShortcutGuide } from '../ShortcutGuide'
import { markWelcomeSeen, WelcomeGuide, welcomeUnseen } from '../WelcomeGuide'
import { CollapsedRail, DockCollapseButton, DockSection, DockSplitter, useViewportSize } from './Dock'
import {
  createExtensionRegistry,
  ExtensionRegistryProvider,
  ModalSlot,
  Slot,
  useOnlineStatus,
  type WorkbenchApi,
} from './ExtensionRegistry'
import { CommandPalette } from './CommandPalette'
import { ConnectPanel } from './ConnectPanel'
import { InspectorPanel } from './InspectorPanel'
import { PalettePanel } from './PalettePanel'
import { SelectionPanel } from './SelectionPanel'
import { StatusBar } from './StatusBar'
import { TimelinePanel } from './TimelinePanel'
import { Toolbar } from './Toolbar'
import { TopBar } from './TopBar'
import { TransformPanel } from './TransformPanel'
import { ViewportStage } from './ViewportStage'
import { OfflineState } from './states'
import {
  bottomHeight,
  clampLayout,
  DOCK_LIMITS,
  LAYOUT_PRESETS,
  STATUSBAR_HEIGHT,
  TOOLRAIL_HEIGHT,
  TOPBAR_HEIGHT,
  defaultLayout,
  loadLayout,
  recommendedPreset,
  saveLayout,
  workspaceColumns,
  type DockId,
  type LayoutPresetId,
  type WorkbenchLayout,
} from './layout'
import { applyChromeReveal, CHROME_SURFACE_TARGETS, publishChrome, setChromeRevealHandler } from '../../webmcp/chrome'
import { createCommandHandlers, disabledReason as reasonFor } from './commands'
import {
  chordFromEvent,
  commandForChord,
  isTypingTarget,
  loadShortcutMap,
  saveShortcutMap,
  type ShortcutMap,
} from './shortcuts'
import { resetPreferences } from './persistence'
import { IDLE_CONNECT, useWorkbench } from './useWorkbench'
import { visibilityActive } from './selection'

/**
 * The workbench shell.
 *
 * A layout and a keyboard, and nothing else: every panel below is a view over
 * the controller in `useWorkbench`, and every extension surface arrives through
 * the registry. `App.tsx` is now one line of composition on top of this.
 */

export interface WorkbenchProps {
  /**
   * Zero-prop components rendered inside the provider. Each is expected to call
   * `useRegisterContribution` and return null; this is how the other nine
   * workstreams put surfaces in the editor.
   */
  contributions?: readonly ComponentType[]
}

export function Workbench({ contributions = [] }: WorkbenchProps) {
  const workbench = useWorkbench()
  const online = useOnlineStatus()
  const registry = useMemo(() => createExtensionRegistry(), [])
  const viewport = useViewportSize()

  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => loadShortcutMap())
  const [rawLayout, setRawLayout] = useState<WorkbenchLayout>(() => loadLayout(
    typeof window === 'undefined' ? 1600 : window.innerWidth,
  ))
  const [offlineDismissed, setOfflineDismissed] = useState(false)
  const [savingSelection, setSavingSelection] = useState('')
  const saveInput = useRef<HTMLInputElement>(null)

  const layout = useMemo(() => clampLayout(rawLayout, viewport), [rawLayout, viewport])
  const layoutRef = useRef(rawLayout)
  layoutRef.current = rawLayout
  const pendingReveal = useRef<string | null>(null)
  const chromeViewRef = useRef({
    tool: workbench.tool,
    cameraView: workbench.cameraView,
    activeColor: workbench.activeColor,
  })
  chromeViewRef.current = {
    tool: workbench.tool,
    cameraView: workbench.cameraView,
    activeColor: workbench.activeColor,
  }

  const updateLayout = useCallback((next: WorkbenchLayout) => {
    setRawLayout(next)
    saveLayout(next)
  }, [])

  const resizeDock = useCallback((dock: DockId, size: number) => {
    const clamped = Math.min(DOCK_LIMITS[dock].max, Math.max(DOCK_LIMITS[dock].min, size))
    updateLayout({ ...rawLayout, [dock]: { size: clamped, collapsed: false }, preset: null })
  }, [rawLayout, updateLayout])

  const toggleDock = useCallback((dock: DockId) => {
    updateLayout({ ...rawLayout, [dock]: { ...rawLayout[dock], collapsed: !rawLayout[dock].collapsed }, preset: null })
  }, [rawLayout, updateLayout])

  const toggleSection = useCallback((id: string) => {
    updateLayout({ ...rawLayout, sections: { ...rawLayout.sections, [id]: !rawLayout.sections[id] } })
  }, [rawLayout, updateLayout])

  const applyPreset = useCallback((preset: LayoutPresetId) => {
    updateLayout({ ...defaultLayout(preset), sections: rawLayout.sections })
  }, [rawLayout.sections, updateLayout])

  useEffect(() => {
    publishChrome({
      docks: {
        left: { collapsed: layout.left.collapsed, size: layout.left.size },
        right: { collapsed: layout.right.collapsed, size: layout.right.size },
        bottom: { collapsed: layout.bottom.collapsed, size: layout.bottom.size },
      },
      sections: { ...layout.sections },
      tool: workbench.tool,
      cameraView: workbench.cameraView,
      activeColor: workbench.activeColor,
    })
  }, [layout, workbench.activeColor, workbench.cameraView, workbench.tool])

  useEffect(() => () => publishChrome(null), [])

  useEffect(() => {
    setChromeRevealHandler((surface) => {
      const next = applyChromeReveal(layoutRef.current, surface)
      pendingReveal.current = CHROME_SURFACE_TARGETS[surface].section
      updateLayout(next)
      publishChrome({
        docks: {
          left: { collapsed: next.left.collapsed, size: next.left.size },
          right: { collapsed: next.right.collapsed, size: next.right.size },
          bottom: { collapsed: next.bottom.collapsed, size: next.bottom.size },
        },
        sections: { ...next.sections },
        ...chromeViewRef.current,
      })
    })
    return () => setChromeRevealHandler(null)
  }, [updateLayout])

  useEffect(() => {
    const section = pendingReveal.current
    if (!section) return
    pendingReveal.current = null
    document.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [layout])

  const focusSearch = useCallback(() => {
    if (rawLayout.left.collapsed) updateLayout({ ...rawLayout, left: { ...rawLayout.left, collapsed: false } })
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-catalog-search]')?.focus())
  }, [rawLayout, updateLayout])

  const exportLdr = useCallback(() => {
    const name = workbench.state.document.name.trim().replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'brickwright_model'
    downloadText(`${name}.ldr`, exportLDraw(workbench.state.document))
  }, [workbench.state.document])

  const resetWorkspace = useCallback(() => {
    resetPreferences()
    const restored = defaultLayout(recommendedPreset(viewport.width))
    setRawLayout(restored)
    saveLayout(restored)
    setShortcuts(loadShortcutMap())
    workbench.notify({
      kind: 'success',
      title: 'Workspace reset',
      detail: 'Docks, palette sets and shortcuts are back to their defaults. The model is untouched.',
    })
  }, [viewport.width, workbench])

  const handlers = useMemo(
    () => createCommandHandlers({ workbench, toggleDock, focusSearch, exportLdr, resetWorkspace }),
    [exportLdr, focusSearch, resetWorkspace, toggleDock, workbench],
  )

  const runCommand = useCallback((commandId: string) => {
    const handler = handlers[commandId]
    if (!handler) return { ran: false, reason: `No command "${commandId}" is registered.` }
    return handler()
  }, [handlers])

  // -- first run ------------------------------------------------------------
  const bootModal = useRef(false)
  useEffect(() => {
    if (bootModal.current) return
    bootModal.current = true
    if (welcomeUnseen()) workbench.setModal('core:welcome')
    // Only ever on the first commit; the guide is a first-run state, not a
    // condition that can recur mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const modal = workbench.modal
  const deckOpen = Boolean(modal?.startsWith('core:command-deck'))
  const paletteOpen = modal === 'core:command-palette' || modal === 'core:keymap'
  const shortcutsOpen = modal === 'core:shortcuts'
  const welcomeOpen = modal === 'core:welcome'
  const saveSetOpen = modal === 'core:save-selection'
  const anyCoreModal = deckOpen || paletteOpen || shortcutsOpen || welcomeOpen || saveSetOpen

  useEffect(() => {
    if (!saveSetOpen) return
    setSavingSelection('')
    const frame = requestAnimationFrame(() => saveInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [saveSetOpen])

  // -- global keyboard ------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (welcomeOpen) return
      const chord = chordFromEvent(event)

      if (anyCoreModal) {
        // A modal surface never lets a viewport command through to the model
        // behind it; only the chord that closes the surface is honoured.
        if (event.key === 'Escape') {
          event.preventDefault()
          workbench.setModal(null)
          return
        }
        if (deckOpen && chord === shortcuts['project.command-deck']) {
          event.preventDefault()
          workbench.setModal(null)
        }
        if (shortcutsOpen && chord === shortcuts['help.shortcuts']) {
          event.preventDefault()
          workbench.setModal(null)
        }
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        // Menus and dialogs own their own Escape lifecycle. Returning here
        // prevents closing an export panel from also rejecting a CAD proposal.
        if (document.querySelector('.export-panel, .project-panel')) return
        if (workbench.placement) workbench.cancelPlacement()
        else if (workbench.tool === 'connect' && workbench.connect.stage !== 'source') {
          workbench.setConnect(
            workbench.connect.stage === 'review'
              ? { ...workbench.connect, stage: 'target', targetPartId: null, targetFeatureId: null, candidateIndex: 0 }
              : IDLE_CONNECT,
          )
        } else if (workbench.playbackStep !== null) workbench.setPlaybackStep(null)
        else if (visibilityActive(workbench.visibility)) workbench.showEverything()
        else {
          const proposal = cadEngine.getSnapshot().proposals[0]
          if (proposal) cadEngine.rejectProposal(proposal.id)
          workbench.setTool('select')
          workbench.setRenderMode('beauty')
        }
        return
      }

      if (event.key === 'Enter' && !isTypingTarget(event.target)) {
        const proposal = cadEngine.getSnapshot().proposals[0]
        if (proposal) {
          event.preventDefault()
          workbench.acceptProposal(proposal.id)
          return
        }
      }

      // Inside a text field only modified chords survive, so typing "g" in the
      // catalogue search does not pick up the move tool.
      const typing = isTypingTarget(event.target)
      if (typing && !(event.metaKey || event.ctrlKey)) return

      const commandId = commandForChord(shortcuts, chord)
      if (!commandId) return
      event.preventDefault()
      const result = runCommand(commandId)
      if (!result.ran && result.reason) workbench.notify({ kind: 'info', title: 'Unavailable', detail: result.reason })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [anyCoreModal, deckOpen, runCommand, shortcuts, shortcutsOpen, welcomeOpen, workbench])

  const updateShortcuts = useCallback((map: ShortcutMap) => {
    setShortcuts(map)
    saveShortcutMap(map)
  }, [])

  // -- the API handed to extensions ----------------------------------------
  const api = useMemo<WorkbenchApi>(() => ({
    snapshot: workbench.state,
    selection: workbench.state.selection,
    tool: workbench.tool,
    activeColor: workbench.activeColor,
    renderMode: workbench.renderMode,
    cameraView: workbench.cameraView,
    placement: workbench.placement,
    online,
    hiddenPartIds: workbench.hidden,
    activeModal: modal,
    select: (ids) => cadEngine.setSelection([...ids]),
    setTool: workbench.setTool,
    setActiveColor: workbench.setActiveColor,
    setRenderMode: workbench.setRenderMode,
    setCameraView: workbench.setCameraView,
    frameSelection: workbench.focusSelection,
    armPart: (definitionId) => workbench.armPart({ id: definitionId, name: definitionId }),
    runCapability: workbench.runSharedMutation,
    execute: workbench.dispatch,
    notify: workbench.notify,
    openModal: workbench.setModal,
  }), [modal, online, workbench])

  const sections = layout.sections
  const { state } = workbench

  return (
    <ExtensionRegistryProvider registry={registry} api={api}>
      {contributions.map((Contribution, index) => (
        <Suspense fallback={null} key={index}>
          <Contribution />
        </Suspense>
      ))}
      <main
        className="app-shell"
        style={{
          gridTemplateColumns: workspaceColumns(layout),
          gridTemplateRows: `${TOPBAR_HEIGHT}px ${TOOLRAIL_HEIGHT}px minmax(0, 1fr) ${bottomHeight(layout)}px ${STATUSBAR_HEIGHT}px`,
        }}
        data-preset={layout.preset ?? 'custom'}
      >
        <TopBar workbench={workbench} />
        <Toolbar workbench={workbench} shortcuts={shortcuts} onImport={workbench.importModel} />

        {layout.left.collapsed ? (
          <CollapsedRail dock="left" label="Palette" onExpand={() => toggleDock('left')} />
        ) : (
          <div className="dock dock-left" aria-label="Palette dock">
            <div className="dock-head">
              <span className="eyebrow">LIBRARY</span>
              <DockCollapseButton dock="left" onCollapse={() => toggleDock('left')} />
            </div>
            <div className="dock-scroll">
              <DockSection
                id="palette"
                title="Parts"
                icon={<Blocks size={11} />}
                open={sections.palette !== false}
                onToggle={() => toggleSection('palette')}
                grow
              >
                <PalettePanel
                  activeColor={workbench.activeColor}
                  armedId={workbench.placement?.definitionId ?? null}
                  onColorChange={workbench.setActiveColor}
                  onAdd={workbench.addPart}
                  onArm={workbench.armPart}
                />
              </DockSection>
              <Slot
                id="panel-left"
                wrap={({ id, title, icon, content }) => (
                  <DockSection
                    id={id}
                    title={title ?? id}
                    icon={icon}
                    open={sections[id] !== false}
                    onToggle={() => toggleSection(id)}
                  >
                    {content}
                  </DockSection>
                )}
              />
            </div>
          </div>
        )}

        <DockSplitter dock="left" size={layout.left.size} onResize={(size) => resizeDock('left', size)} onDoubleClick={() => toggleDock('left')} />

        <ViewportStage workbench={workbench} />

        <DockSplitter dock="right" size={layout.right.size} onResize={(size) => resizeDock('right', size)} onDoubleClick={() => toggleDock('right')} />

        {layout.right.collapsed ? (
          <CollapsedRail dock="right" label="Inspector" onExpand={() => toggleDock('right')} />
        ) : (
          <div className="dock dock-right" aria-label="Inspector dock">
            <div className="dock-head">
              <span className="eyebrow">INSPECT & EDIT</span>
              <DockCollapseButton dock="right" onCollapse={() => toggleDock('right')} />
            </div>
            <div className="dock-scroll">
              {workbench.tool === 'connect' && (
                <DockSection
                  id="connect"
                  title="Connect"
                  icon={<CircleDot size={11} />}
                  open
                  onToggle={() => workbench.setTool('select')}
                >
                  <ConnectPanel workbench={workbench} />
                </DockSection>
              )}
              <DockSection
                id="selection"
                title="Selection"
                icon={<MousePointer2 size={11} />}
                badge={<em className="dock-badge">{state.selection.length || '—'}</em>}
                open={sections.selection !== false}
                onToggle={() => toggleSection('selection')}
              >
                <SelectionPanel workbench={workbench} />
              </DockSection>
              <DockSection
                id="transform"
                title="Transform"
                icon={<Move3d size={11} />}
                open={sections.transform !== false}
                onToggle={() => toggleSection('transform')}
              >
                <TransformPanel workbench={workbench} />
              </DockSection>
              <DockSection
                id="inspector"
                title="Inspector"
                icon={<SlidersHorizontal size={11} />}
                open={sections.inspector !== false}
                onToggle={() => toggleSection('inspector')}
              >
                <InspectorPanel
                  state={state}
                  selectedPart={workbench.selectedPart}
                  definition={workbench.selectedDefinition}
                  articulation={workbench.articulation}
                  onArticulate={workbench.driveJoint}
                  onTransform={workbench.handleTransform}
                  onRecolor={workbench.recolorSelection}
                  onProtect={workbench.protectSelection}
                  onSelectIds={(ids) => cadEngine.setSelection(ids)}
                />
              </DockSection>
              <Slot
                id="panel-right"
                wrap={({ id, title, icon, content }) => (
                  <DockSection
                    id={id}
                    title={title ?? id}
                    icon={icon}
                    open={sections[id] !== false}
                    onToggle={() => toggleSection(id)}
                  >
                    {content}
                  </DockSection>
                )}
              />
            </div>
          </div>
        )}

        {layout.bottom.collapsed ? (
          <button className="dock-bar" onClick={() => toggleDock('bottom')} aria-label="Show the build timeline">
            <Boxes size={12} /> BUILD SEQUENCE · {state.document.steps.length} steps · {state.transactions.length} edits
          </button>
        ) : (
          <TimelinePanel
            onSequence={workbench.regenerateBuildOrder}
            state={state}
            playbackStep={workbench.playbackStep}
            onPlayStep={workbench.setPlaybackStep}
            onAccept={workbench.acceptProposal}
            onReject={workbench.rejectProposal}
            onSelectIds={(ids) => cadEngine.setSelection(ids)}
          />
        )}

        <StatusBar
          workbench={workbench}
          shortcuts={shortcuts}
          online={online}
          preset={layout.preset}
          onPreset={applyPreset}
        />

        <CommandDeck
          open={deckOpen}
          state={state}
          onClose={() => workbench.setModal(null)}
          onRun={workbench.runSharedMutation}
        />
        <ShortcutGuide
          open={shortcutsOpen}
          onClose={() => workbench.setModal(null)}
          onReplayWelcome={() => workbench.setModal('core:welcome')}
        />
        <WelcomeGuide open={welcomeOpen} onClose={() => { markWelcomeSeen(); workbench.setModal(null) }} />
        <CommandPalette
          open={paletteOpen}
          initialTab={modal === 'core:keymap' ? 'keys' : 'run'}
          shortcuts={shortcuts}
          onShortcuts={updateShortcuts}
          onRun={runCommand}
          disabledReason={(commandId) => reasonFor(commandId, workbench)}
          onClose={() => workbench.setModal(null)}
        />

        {saveSetOpen && (
          <div className="workbench-prompt-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && workbench.setModal(null)}>
            <div className="workbench-prompt" role="dialog" aria-modal="true" aria-label="Save selection set">
              <h3>Save this selection</h3>
              <p>{state.selection.length} part{state.selection.length === 1 ? '' : 's'} will be recorded by id.</p>
              <input
                ref={saveInput}
                value={savingSelection}
                aria-label="Selection set name"
                placeholder="Rear hatch assembly"
                onChange={(event) => setSavingSelection(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !savingSelection.trim()) return
                  workbench.saveSelectionSet(savingSelection.trim())
                  workbench.setModal(null)
                }}
              />
              <div>
                <button type="button" onClick={() => workbench.setModal(null)}>Cancel</button>
                <button
                  type="button"
                  className="prompt-primary"
                  disabled={!savingSelection.trim()}
                  onClick={() => { workbench.saveSelectionSet(savingSelection.trim()); workbench.setModal(null) }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        <ModalSlot />

        {!online && !offlineDismissed && <OfflineState onDismiss={() => setOfflineDismissed(true)} />}

        {workbench.toast && (
          <div className={`toast ${workbench.toast.kind}`} role="status">
            <span>
              {workbench.toast.kind === 'success' ? <Check size={15} /> : workbench.toast.kind === 'error' ? <X size={15} /> : <CircleDot size={15} />}
            </span>
            <div><strong>{workbench.toast.title}</strong><p>{workbench.toast.detail}</p></div>
            <button onClick={() => workbench.setToast(null)} aria-label="Dismiss"><X size={13} /></button>
          </div>
        )}
      </main>
    </ExtensionRegistryProvider>
  )
}

export { LAYOUT_PRESETS }
