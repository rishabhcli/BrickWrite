import './workbench.css'
import { Blocks, Boxes, Check, CircleAlert, CircleDot, Move3d, MousePointer2, SlidersHorizontal, X } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { exportLDraw, downloadText } from '../../cad/ldraw'
import { cadEngine } from '../../cad/engine'
import type { SharedMutationId } from '../../cad/capabilities'
import { inspectModelHealth, type ModelHealthIssue } from '../../cad/modelHealth'
import { applyEditorQuery, consumeSearchParams } from '../../platform/boot'
import { GlassDock } from '../../ui/liquid'
import { CommandDeck } from '../CommandDeck'
import { ShortcutGuide } from '../ShortcutGuide'
import { markWelcomeSeen, WelcomeGuide } from '../WelcomeGuide'
import { CollapsedRail, DockCollapseButton, DockSection, DockSplitter, useViewportSize } from './Dock'
import {
  createExtensionRegistry,
  ExtensionRegistryProvider,
  ModalSlot,
  Slot,
  useOnlineStatus,
  type WorkbenchApi,
  type WorkbenchNotice,
} from './ExtensionRegistry'
import { CommandPalette } from './CommandPalette'
import { ConnectPanel } from './ConnectPanel'
import { InspectorPanel, type InspectorView } from './InspectorPanel'
import { ModelExplorerPanel } from './ModelExplorerPanel'
import { PalettePanel } from './PalettePanel'
import { SelectionPanel } from './SelectionPanel'
import { TimelinePanel, type TimelineView } from './TimelinePanel'
import { Toolbar } from './Toolbar'
import { TopBar } from './TopBar'
import { TransformPanel } from './TransformPanel'
import { ViewportStage } from './ViewportStage'
import { watchCatalogSearch } from './catalogSearchFocus'
import { watchGeneratePrompt } from './promptFocus'
import { OfflineState } from './states'
import {
  clampLayout,
  DOCK_LIMITS,
  LAYOUT_PRESETS,
  defaultLayout,
  loadLayout,
  recommendedPreset,
  saveLayout,
  workspaceColumns,
  workspaceRows,
  bottomHeight,
  type DockId,
  type LayoutPresetId,
  type WorkbenchLayout,
} from './layout'
import {
  CHROME_SURFACE_TARGETS,
  applyChromeReveal,
  applyDockFocus,
  focusProposalReview,
  publishChrome,
  setChromeRevealHandler,
  setModelHealthHandler,
  setProposalReviewHandler,
  setWorkspaceFocusHandler,
  type ChromeSurface,
} from '../../webmcp/chrome'
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
import { WorkbenchIcon } from './WorkbenchIcons'

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

const DESIGN_SECTION_IDS = ['generation.panel', 'refinement.panel', 'agent.workbench'] as const
type DesignSurfaceId = (typeof DESIGN_SECTION_IDS)[number]
const DESIGN_SURFACES: readonly { id: DesignSurfaceId; label: string; icon: 'generate' | 'refine' | 'agent' }[] = [
  { id: 'generation.panel', label: 'Make', icon: 'generate' },
  { id: 'refinement.panel', label: 'Tune', icon: 'refine' },
  { id: 'agent.workbench', label: 'Ask', icon: 'agent' },
]
const OBJECT_SECTION_IDS = ['model.explorer', 'selection', 'transform', 'inspector', 'connect'] as const
const OBJECT_SURFACES = [
  { id: 'model.explorer', label: 'Map', icon: Boxes },
  { id: 'selection', label: 'Pick', icon: MousePointer2 },
  { id: 'transform', label: 'Move', icon: Move3d },
  { id: 'inspector', label: 'Inspect', icon: SlidersHorizontal },
  { id: 'connect', label: 'Mate', icon: CircleDot },
] as const
const LEFT_SURFACES = [
  { id: 'palette', label: 'Parts', icon: 'parts' },
  { id: 'cloud.projects', label: 'Builds', icon: 'projects' },
  { id: 'cloud.members', label: 'Share', icon: 'share' },
  { id: 'cloud.presence', label: 'Live', icon: 'presence' },
] as const
type LeftSurfaceId = (typeof LEFT_SURFACES)[number]['id']
const isDesignSection = (id: string) => (DESIGN_SECTION_IDS as readonly string[]).includes(id)
const isObjectSection = (id: string) => (OBJECT_SECTION_IDS as readonly string[]).includes(id)

/**
 * WebMCP still models the right dock as one exclusive stack. At the Workbench
 * seam we retain that focus behaviour for Object, while preserving the three
 * independently collapsible Design preferences for when the operator returns.
 */
function applyWorkbenchReveal(layout: WorkbenchLayout, surface: ChromeSurface): WorkbenchLayout {
  const target = CHROME_SURFACE_TARGETS[surface]
  if (target.dock === 'right' && target.section && isDesignSection(target.section)) {
    return {
      ...layout,
      right: { ...layout.right, collapsed: false },
      rightTab: 'design',
      sections: { ...layout.sections, [target.section]: true },
    }
  }

  const next = applyChromeReveal(layout, surface)
  if (target.dock !== 'right') return next
  const designSections = Object.fromEntries(DESIGN_SECTION_IDS.map((id) => [id, layout.sections[id]]))
  return {
    ...next,
    rightTab: 'object',
    sections: { ...next.sections, ...designSections },
  }
}

function applyWorkbenchSectionFocus(layout: WorkbenchLayout, id: string, open: boolean): WorkbenchLayout {
  if (isDesignSection(id)) {
    return { ...layout, rightTab: 'design', sections: { ...layout.sections, [id]: open } }
  }
  const next = applyDockFocus(layout, id, open)
  if (!isObjectSection(id)) return next
  const designSections = Object.fromEntries(DESIGN_SECTION_IDS.map((section) => [section, layout.sections[section]]))
  return {
    ...next,
    rightTab: 'object',
    sections: { ...next.sections, ...designSections },
  }
}

export function Workbench({ contributions = [] }: WorkbenchProps) {
  const workbench = useWorkbench()
  const location = useLocation()
  const navigate = useNavigate()
  const online = useOnlineStatus()
  const registry = useMemo(() => createExtensionRegistry(), [])
  const viewport = useViewportSize()

  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => loadShortcutMap())
  const [rawLayout, setRawLayout] = useState<WorkbenchLayout>(() =>
    loadLayout(typeof window === 'undefined' ? 1600 : window.innerWidth),
  )
  const [offlineDismissed, setOfflineDismissed] = useState(false)
  const [savingSelection, setSavingSelection] = useState('')
  const [timelineView, setTimelineView] = useState<TimelineView>('steps')
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null)
  const [inspectorView, setInspectorView] = useState<InspectorView>('object')
  const [activeHealthIssueId, setActiveHealthIssueId] = useState<string | null>(null)
  const [activeDesignSurface, setActiveDesignSurface] = useState<DesignSurfaceId>('generation.panel')
  const [activeLeftSurface, setActiveLeftSurface] = useState<LeftSurfaceId>('palette')
  /**
   * Bumped every time something asks for Generate.
   *
   * The prompt cannot be focused from the reveal itself: Generate is a lazily
   * imported contribution, so at that moment the textarea does not exist. The
   * token is the wait key: when it bumps, `watchGeneratePrompt` claims the
   * field as soon as the field announces itself (or appears in the tree).
   */
  const [promptFocusToken, setPromptFocusToken] = useState(0)
  const saveInput = useRef<HTMLInputElement>(null)

  const layout = useMemo(() => clampLayout(rawLayout, viewport), [rawLayout, viewport])
  const layoutRef = useRef(rawLayout)
  layoutRef.current = rawLayout
  const pendingReveal = useRef<string | null>(null)
  const catalogSearchWatch = useRef<(() => void) | null>(null)
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
  const workbenchRef = useRef(workbench)
  workbenchRef.current = workbench
  const activeProposalRef = useRef(activeProposalId)
  activeProposalRef.current = activeProposalId
  const inspectorViewRef = useRef(inspectorView)
  inspectorViewRef.current = inspectorView

  const updateLayout = useCallback((next: WorkbenchLayout) => {
    setRawLayout(next)
    saveLayout(next)
  }, [])

  const revealWorkbenchSurface = useCallback(
    (surface: ChromeSurface) => {
      if (surface === 'feedback') setTimelineView('feedback')
      if (surface === 'review') setTimelineView('review')
      if (surface === 'generation') setPromptFocusToken((token) => token + 1)
      if (surface === 'generation') setActiveDesignSurface('generation.panel')
      if (surface === 'refinement') setActiveDesignSurface('refinement.panel')
      if (surface === 'agent') setActiveDesignSurface('agent.workbench')
      // `health` and `inspector` are two surfaces sharing one panel, so asking
      // for either has to land on that one — otherwise a reveal returns whatever
      // tab was last looked at, and an agent calling `workspace_reveal` gets a
      // different answer depending on history it cannot see.
      //
      // The `inspector` line has a guard, though not a unit one: it lives in a
      // component too large to mount for a single assertion, so
      // `tools/e2e-smoke.mjs` covers it — it reveals `inspector` and then waits
      // for `.inspector-panel .selection-identity`, which only renders on the
      // Object tab. Remove this line and that wait times out. Worth knowing,
      // because the coupling is invisible from here.
      if (surface === 'health') setInspectorView('validate')
      if (surface === 'inspector') setInspectorView('object')
      const next = applyWorkbenchReveal(layoutRef.current, surface)
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
    },
    [updateLayout],
  )

  // The feedback inbox carries tabs, filters, anchored cards and a reply field.
  // A laptop preset's 124px build strip is enough for step cards but clips the
  // inbox controls into the status bar, so entering this view grants it the
  // smallest height at which every action remains visible. We never shrink a
  // layout the operator has already made larger.
  useEffect(() => {
    if (timelineView !== 'feedback' || rawLayout.bottom.collapsed || rawLayout.bottom.size >= 168) return
    updateLayout({
      ...rawLayout,
      bottom: { ...rawLayout.bottom, size: 168 },
      preset: null,
    })
  }, [rawLayout, timelineView, updateLayout])

  // A new preflight is an explicit handoff that needs a decision. Bring the
  // measured review queue on screen, but do not keep stealing the dock after
  // the operator deliberately changes tabs.
  const previousProposalCount = useRef(workbench.state.proposals.length)
  useEffect(() => {
    const proposals = workbench.state.proposals
    const before = previousProposalCount.current
    previousProposalCount.current = proposals.length
    if (!proposals.length) {
      setActiveProposalId(null)
      if (timelineView === 'review') setTimelineView('history')
      return
    }
    if (!proposals.some((proposal) => proposal.id === activeProposalRef.current)) {
      setActiveProposalId(proposals.at(-1)!.id)
    }
    if (proposals.length <= before) return
    setActiveProposalId(proposals.at(-1)!.id)
    setTimelineView('review')
    if (rawLayout.bottom.collapsed || rawLayout.bottom.size < 220) {
      updateLayout({
        ...rawLayout,
        bottom: { ...rawLayout.bottom, collapsed: false, size: Math.max(220, rawLayout.bottom.size) },
        preset: null,
      })
    }
  }, [rawLayout, timelineView, updateLayout, workbench.state.proposals])

  const resizeDock = useCallback(
    (dock: DockId, size: number) => {
      const clamped = Math.min(DOCK_LIMITS[dock].max, Math.max(DOCK_LIMITS[dock].min, size))
      updateLayout({ ...rawLayout, [dock]: { size: clamped, collapsed: false }, preset: null })
    },
    [rawLayout, updateLayout],
  )

  const toggleDock = useCallback(
    (dock: DockId) => {
      updateLayout({
        ...rawLayout,
        [dock]: { ...rawLayout[dock], collapsed: !rawLayout[dock].collapsed },
        preset: null,
      })
    },
    [rawLayout, updateLayout],
  )

  const applyPreset = useCallback(
    (id: LayoutPresetId) => {
      updateLayout({
        ...LAYOUT_PRESETS[id].layout,
        sections: rawLayout.sections,
      })
    },
    [rawLayout.sections, updateLayout],
  )

  const toggleSection = useCallback(
    (id: string) => {
      if (workbench.tool === 'connect' && id !== 'connect') workbench.setTool('select')
      const open = rawLayout.sections[id] !== false
      updateLayout(applyWorkbenchSectionFocus(rawLayout, id, !open))
    },
    [rawLayout, updateLayout, workbench],
  )

  // The inspector is no longer permanent chrome. It arrives when the work
  // creates context, then stays under the operator's control. A new selection
  // opens Selection; entering Connect opens the guided mate sheet. Collapsing
  // the dock afterwards is respected until a genuinely new context begins.
  const previousContext = useRef({
    selection: workbench.state.selection.length,
    tool: workbench.tool,
    toolPicks: workbench.toolPicks,
  })
  useEffect(() => {
    const before = previousContext.current
    const selection = workbench.state.selection.length
    const enteredSelection = before.selection === 0 && selection > 0
    const enteredConnect = before.tool !== 'connect' && workbench.tool === 'connect'
    // Reaching for Move or Rotate is a request for exact numbers, so the
    // Transform sheet opens. Landing in Move because a brick was clicked or
    // quick-added is not: unfurling reference frames, axis locks, pivots and
    // align rows on top of "I clicked a brick" is how a viewport turns into a
    // cockpit. Hence `toolPicks` rather than the tool itself — both arrive as
    // 'move'. The small Selection sheet answers a click; Transform is one
    // click away in the same dock.
    const askedForTransform =
      selection > 0 &&
      (workbench.tool === 'move' || workbench.tool === 'rotate') &&
      workbench.toolPicks !== before.toolPicks
    previousContext.current = { selection, tool: workbench.tool, toolPicks: workbench.toolPicks }
    if (!enteredSelection && !enteredConnect && !askedForTransform) return
    // Model Map is itself a selection workspace. Replacing it with the generic
    // Selection sheet after its first row click would make browsing feel like
    // navigation that closes itself.
    if (
      enteredSelection &&
      !askedForTransform &&
      (layoutRef.current.sections['model.explorer'] === true ||
        (layoutRef.current.sections.inspector === true && inspectorViewRef.current === 'validate'))
    )
      return
    const next = enteredConnect
      ? applyWorkbenchSectionFocus(
          { ...layoutRef.current, right: { ...layoutRef.current.right, collapsed: false } },
          'connect',
          true,
        )
      : applyWorkbenchReveal(layoutRef.current, askedForTransform ? 'transform' : 'selection')
    updateLayout(next)
  }, [updateLayout, workbench.state.selection.length, workbench.tool, workbench.toolPicks])

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

  const notifyRef = useRef(workbench.notify)
  notifyRef.current = workbench.notify

  useEffect(() => {
    setChromeRevealHandler(revealWorkbenchSurface)
    setWorkspaceFocusHandler((request) => {
      const snapshot = cadEngine.getSnapshot()
      const assembly = request.subassemblyId ? snapshot.document.subassemblies[request.subassemblyId] : undefined
      const requested = assembly?.partIds ?? request.partIds ?? []
      const matched = requested.filter((id) => Boolean(snapshot.document.parts[id]))
      const missing = requested.filter((id) => !snapshot.document.parts[id])
      // The focus tool already chose Model Map as the shared visual context.
      // Prevent the generic 0 -> N selection affordance below from immediately
      // replacing it with the Selection sheet on the next render.
      previousContext.current = { ...previousContext.current, selection: matched.length }
      cadEngine.setSelection(matched)
      if (matched.length && request.mode === 'frame') workbenchRef.current.focusSelection()
      if (matched.length && request.mode === 'isolate') workbenchRef.current.isolateSelection()
      return {
        requestedCount: requested.length,
        matchedCount: matched.length,
        selectedPartIds: matched.slice(0, 200),
        missingPartIds: missing.slice(0, 200),
        subassemblyFound: request.subassemblyId ? Boolean(assembly) : null,
        truncated: matched.length > 200 || missing.length > 200,
      }
    })
    setProposalReviewHandler((proposalId) => {
      const proposals = cadEngine.getSnapshot().proposals
      const proposal = proposalId ? proposals.find((candidate) => candidate.id === proposalId) : proposals.at(-1)
      if (proposal) setActiveProposalId(proposal.id)
      setTimelineView('review')
      return {
        activeProposalId: proposal?.id ?? null,
        found: Boolean(proposal),
        pending: proposals.length,
      }
    })
    setModelHealthHandler((issueId) => {
      const snapshot = cadEngine.getSnapshot()
      const health = inspectModelHealth(snapshot.document, snapshot.validation)
      const issue = issueId ? health.issues.find((candidate) => candidate.id === issueId) : health.issues[0]
      setInspectorView('validate')
      setActiveHealthIssueId(issue?.id ?? null)
      const partIds = issue?.partIds.filter((id) => Boolean(snapshot.document.parts[id])) ?? []
      // Health is the intended selection workspace. Keep the generic selection
      // affordance from replacing it after this exact diagnostic focus.
      previousContext.current = { ...previousContext.current, selection: partIds.length }
      cadEngine.setSelection([...partIds])
      if (partIds.length) workbenchRef.current.focusSelection()
      if (issue?.kind === 'collision') workbenchRef.current.setRenderMode('violations')
      return {
        activeIssueId: issue?.id ?? null,
        found: Boolean(issue),
        revision: health.revision,
        blockers: health.blockers,
        warnings: health.warnings,
        selectedPartIds: partIds.slice(0, 200),
        truncated: partIds.length > 200,
      }
    })
    const search = typeof window === 'undefined' ? location.search : window.location.search
    const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    const syncAddressBar = () => {
      if (typeof window === 'undefined') return
      const live = `${window.location.pathname}${window.location.search}${window.location.hash}`
      const routed = `${location.pathname}${location.search}${location.hash}`
      if (live !== routed) navigate(live, { replace: true })
    }
    const run = async () => {
      if (query.get('doc') === 'blank' || query.get('project')) {
        const sessionMod = await import('../../cad/session')
        const result = await applyEditorQuery(
          sessionMod,
          typeof window === 'undefined' ? search : window.location.search,
        )
        if (result.applied !== 'none' && !result.ok) {
          notifyRef.current({
            kind: 'error',
            title: result.applied === 'project' ? 'Project not opened' : 'Blank project not created',
            detail: result.message,
          })
        }
      }
      if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('intent') === 'describe') {
        revealWorkbenchSurface('generation')
        // Announced for anything already listening, and consumed here because
        // this shell owns the query parameter — nothing else can read the URL for
        // itself without racing that consumption.
        window.dispatchEvent(new CustomEvent('brickwright:intent-describe'))
        consumeSearchParams(['intent'])
      }
      syncAddressBar()
    }
    // For anything that announces the intent without going through the query
    // parameter — the agent surface, a deep link handled elsewhere, a test.
    // Focus is not claimed here: revealing Generate bumps `promptFocusToken`,
    // and that effect waits for the field to announce itself (or appear).
    const describeIntent = () => {
      revealWorkbenchSurface('generation')
    }
    window.addEventListener('brickwright:intent-describe', describeIntent)
    void run()
    return () => {
      window.removeEventListener('brickwright:intent-describe', describeIntent)
      setChromeRevealHandler(null)
      setWorkspaceFocusHandler(null)
      setProposalReviewHandler(null)
      setModelHealthHandler(null)
    }
  }, [location.hash, location.pathname, location.search, navigate, revealWorkbenchSurface])

  useEffect(() => {
    const section = pendingReveal.current
    if (!section) return
    pendingReveal.current = null
    document.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [layout])

  const focusSearch = useCallback(() => {
    setActiveLeftSurface('palette')
    const current = layoutRef.current
    if (current.left.collapsed) updateLayout({ ...current, left: { ...current.left, collapsed: false } })
    catalogSearchWatch.current?.()
    catalogSearchWatch.current = watchCatalogSearch()
  }, [updateLayout])

  useEffect(() => () => catalogSearchWatch.current?.(), [])

  const exportLdr = useCallback(() => {
    const name =
      workbench.state.document.name
        .trim()
        .replace(/\W+/g, '_')
        .replace(/^_+|_+$/g, '') || 'brickwright_model'
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

  const runCommand = useCallback(
    (commandId: string) => {
      const handler = handlers[commandId]
      if (!handler) return { ran: false, reason: `No command "${commandId}" is registered.` }
      return handler()
    },
    [handlers],
  )

  // -- first run ------------------------------------------------------------
  const bootModal = useRef(false)
  useEffect(() => {
    if (bootModal.current) return
    bootModal.current = true
    // The guide no longer opens itself. A modal over the viewport on first
    // load is the first thing an operator has to dismiss before they can see
    // the tool at all, and it says less than the empty grid behind it does.
    // It stays reachable from the shortcuts sheet's "replay welcome".
    // Only ever on the first commit; the guide is a first-run state, not a
    // condition that can recur mid-session.
  }, [])

  const modal = workbench.modal
  const deckOpen = Boolean(modal?.startsWith('core:command-deck'))
  const paletteOpen = modal === 'core:command-palette' || modal === 'core:keymap'
  const shortcutsOpen = modal === 'core:shortcuts'
  const welcomeOpen = modal === 'core:welcome'
  const saveSetOpen = modal === 'core:save-selection'
  const anyCoreModal = deckOpen || paletteOpen || shortcutsOpen || welcomeOpen || saveSetOpen

  // `?intent=describe` promises "just describe it". Two races, not one: the
  // panel it reveals is a lazily imported contribution, and on a first run a
  // core modal may still hold focus. The field announces when it is in the
  // document; this claims it then, and waits behind `anyCoreModal` rather than
  // a timer, because a person reading that dialog takes as long as they take.
  // It never pulls focus out of somewhere the operator has since put it.
  useEffect(() => {
    if (!promptFocusToken || anyCoreModal) return
    return watchGeneratePrompt()
  }, [anyCoreModal, promptFocusToken])

  useEffect(() => {
    if (!saveSetOpen) return
    setSavingSelection('')
    const frame = requestAnimationFrame(() => saveInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [saveSetOpen])

  // -- global keyboard ------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
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
        if (isTypingTarget(event.target)) return
        const origin = event.target instanceof Element ? event.target : null
        if (origin?.closest('[role=dialog][aria-modal=true], .export-panel, .project-panel, .bw-cloud-members')) {
          return
        }
        event.preventDefault()
        // Menus and dialogs own their own Escape lifecycle. Returning here
        // prevents closing an export panel from also rejecting a CAD proposal.
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
          const proposals = cadEngine.getSnapshot().proposals
          const proposal = proposals.find((candidate) => candidate.id === activeProposalRef.current) ?? proposals[0]
          if (proposal) cadEngine.rejectProposal(proposal.id)
          workbench.setTool('select')
          workbench.setRenderMode('beauty')
        }
        return
      }

      if (event.key === 'Enter' && !isTypingTarget(event.target)) {
        const proposals = cadEngine.getSnapshot().proposals
        const proposal = proposals.find((candidate) => candidate.id === activeProposalRef.current) ?? proposals[0]
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
      // Native copy/paste, undo, and select-all belong to the focused text field.
      if (typing && (commandId.startsWith('edit.') || commandId.startsWith('select.'))) return
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
  const api = useMemo<WorkbenchApi>(
    () => ({
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
    }),
    [modal, online, workbench],
  )

  const sections = layout.sections
  const { state } = workbench
  const connectActive = workbench.tool === 'connect'
  const rightTab = connectActive ? 'object' : layout.rightTab
  const rightSectionOpen = (id: string) => rightTab === 'object' && !connectActive && sections[id] === true
  const activeObjectSurface = connectActive
    ? 'connect'
    : (OBJECT_SECTION_IDS.find((id) => sections[id] === true) ?? 'selection')

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
          gridTemplateRows: workspaceRows(layout),
          ['--timeline-track' as string]: `${bottomHeight(layout)}px`,
        }}
        data-preset={layout.preset ?? 'custom'}
        data-timeline={layout.bottom.collapsed ? undefined : 'open'}
        data-bottom-size={layout.bottom.size}
      >
        {/* The editor's outline began at h2, so assistive technology had no
         * top-level heading for the route and no way to hear which document
         * was open without reading the chrome. It is hidden because the
         * document name is already on screen in the title bar. */}
        <h1 className="visually-hidden">{workbench.state.document.name} — Brickwright editor</h1>
        <TopBar workbench={workbench} preset={layout.preset} onPreset={applyPreset} />
        <Toolbar
          workbench={workbench}
          shortcuts={shortcuts}
          onImport={workbench.importModel}
          timelineOpen={!layout.bottom.collapsed}
          onToggleTimeline={() => toggleDock('bottom')}
        />

        {layout.left.collapsed ? (
          <CollapsedRail dock="left" label="Palette" onExpand={() => toggleDock('left')} />
        ) : (
          <GlassDock as="div" className="dock dock-left" role="region" aria-label="Palette dock">
            <div className="dock-head left-tool-head">
              <div className="left-tool-switcher" role="tablist" aria-label="Library and collaboration tools">
                {LEFT_SURFACES.map((surface) => (
                  <button
                    key={surface.id}
                    type="button"
                    role="tab"
                    aria-selected={activeLeftSurface === surface.id}
                    aria-controls="left-tool-panel"
                    className={activeLeftSurface === surface.id ? 'active' : ''}
                    title={surface.label}
                    onClick={() => setActiveLeftSurface(surface.id)}
                  >
                    <WorkbenchIcon name={surface.icon} size={15} />
                    <span>{surface.label}</span>
                  </button>
                ))}
              </div>
              <DockCollapseButton dock="left" onCollapse={() => toggleDock('left')} />
            </div>
            <div
              id="left-tool-panel"
              className={`dock-scroll left-dock-${activeLeftSurface.replace('.', '-')}`}
              role="tabpanel"
            >
              <DockSection
                id="palette"
                title="Parts"
                icon={<Blocks size={11} />}
                open={activeLeftSurface === 'palette'}
                onToggle={() => setActiveLeftSurface('palette')}
                grow
              >
                <PalettePanel
                  activeColor={workbench.activeColor}
                  armedId={workbench.placement?.definitionId ?? null}
                  /* A colour click paints what is selected, and only sets the
                     next-brick colour when nothing is. Wiring this to
                     `setActiveColor` meant clicking red with a brick selected
                     did nothing at all on screen — the one outcome a beginner
                     reads as "this application is broken". `recolorSelection`
                     already carries both behaviours; it was simply never
                     reachable from the swatches. */
                  onColorChange={workbench.recolorSelection}
                  onAdd={workbench.addPart}
                  onArm={workbench.armPart}
                  onDragPart={workbench.beginPartDrag}
                  onDropPart={workbench.dropPart}
                  onDragEnd={workbench.endPartDrag}
                />
              </DockSection>
              <Slot
                id="panel-left"
                wrap={({ id, title, icon, content }) => (
                  <DockSection
                    id={id}
                    title={title ?? id}
                    icon={icon}
                    open={id === activeLeftSurface}
                    grow={id === activeLeftSurface}
                    onToggle={() => {
                      if (LEFT_SURFACES.some((surface) => surface.id === id)) setActiveLeftSurface(id as LeftSurfaceId)
                    }}
                  >
                    {content}
                  </DockSection>
                )}
              />
            </div>
          </GlassDock>
        )}

        <DockSplitter
          dock="left"
          size={layout.left.size}
          onResize={(size) => resizeDock('left', size)}
          onDoubleClick={() => toggleDock('left')}
        />

        <ViewportStage
          workbench={workbench}
          activeProposalId={activeProposalId}
          onReviewProposal={(proposalId) => {
            setActiveProposalId(proposalId)
            focusProposalReview(proposalId)
          }}
        />

        <DockSplitter
          dock="right"
          size={layout.right.size}
          onResize={(size) => resizeDock('right', size)}
          onDoubleClick={() => toggleDock('right')}
        />

        {layout.right.collapsed ? (
          <CollapsedRail dock="right" label="Design and Object" onExpand={() => toggleDock('right')} />
        ) : (
          <GlassDock as="div" className="dock dock-right" role="region" aria-label="Inspector dock">
            <div className="dock-head right-tool-head">
              <div className="right-tool-switcher" role="tablist" aria-label="Design and object tools">
                {DESIGN_SURFACES.map((surface) => {
                  const selected = rightTab === 'design' && activeDesignSurface === surface.id
                  return (
                    <button
                      key={surface.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls="right-tool-panel"
                      title={
                        surface.id === 'generation.panel'
                          ? 'Generate a build'
                          : surface.id === 'refinement.panel'
                            ? 'Refine a region'
                            : 'Ask the design partner'
                      }
                      className={selected ? 'active' : ''}
                      onClick={() => {
                        if (workbench.tool === 'connect') workbench.setTool('select')
                        setActiveDesignSurface(surface.id)
                        updateLayout({
                          ...rawLayout,
                          right: { ...rawLayout.right, collapsed: false },
                          rightTab: 'design',
                          sections: { ...rawLayout.sections, [surface.id]: true },
                        })
                      }}
                    >
                      <WorkbenchIcon name={surface.icon} size={15} />
                      <span>{surface.label}</span>
                    </button>
                  )
                })}
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === 'object'}
                  aria-controls="right-tool-panel"
                  title="Object tools"
                  className={rightTab === 'object' ? 'active' : ''}
                  onClick={() => {
                    const visibleObjectSurface =
                      OBJECT_SECTION_IDS.find((id) => rawLayout.sections[id] === true) ?? 'selection'
                    updateLayout(
                      applyWorkbenchSectionFocus(
                        {
                          ...rawLayout,
                          right: { ...rawLayout.right, collapsed: false },
                          rightTab: 'object',
                        },
                        visibleObjectSurface,
                        true,
                      ),
                    )
                  }}
                >
                  <WorkbenchIcon name="object" size={15} />
                  <span>Object</span>
                </button>
              </div>
              <DockCollapseButton dock="right" onCollapse={() => toggleDock('right')} />
            </div>
            <div
              id="right-tool-panel"
              className={`dock-scroll right-dock-${rightTab}`}
              role="tabpanel"
              aria-label={`${rightTab} tools`}
            >
              {rightTab === 'design' ? (
                <Slot
                  id="panel-right"
                  wrap={({ id, title, icon, content }) => (
                    <DockSection
                      id={id}
                      title={id === 'agent.workbench' ? 'Agent' : (title ?? id)}
                      icon={icon}
                      open={id === activeDesignSurface}
                      grow={id === activeDesignSurface}
                      onToggle={() => {
                        if (isDesignSection(id)) setActiveDesignSurface(id as DesignSurfaceId)
                      }}
                    >
                      {content}
                    </DockSection>
                  )}
                />
              ) : (
                <>
                  <div className="object-tool-switcher" role="toolbar" aria-label="Object tools">
                    {OBJECT_SURFACES.map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        className={activeObjectSurface === id ? 'active' : ''}
                        aria-pressed={activeObjectSurface === id}
                        title={
                          id === 'model.explorer'
                            ? 'Browse the model map'
                            : id === 'selection'
                              ? 'Selection tools'
                              : id === 'transform'
                                ? 'Exact transform tools'
                                : id === 'inspector'
                                  ? 'Inspect object properties'
                                  : 'Connect two parts'
                        }
                        onClick={() => {
                          if (id === 'connect') {
                            workbench.setTool('connect')
                            return
                          }
                          if (workbench.tool === 'connect') workbench.setTool('select')
                          updateLayout(
                            applyWorkbenchSectionFocus(
                              {
                                ...rawLayout,
                                right: { ...rawLayout.right, collapsed: false },
                                rightTab: 'object',
                              },
                              id,
                              true,
                            ),
                          )
                        }}
                      >
                        <Icon size={14} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                  <DockSection
                    id="connect"
                    title="Connect"
                    icon={<CircleDot size={11} />}
                    open={connectActive}
                    grow={connectActive}
                    onToggle={() => workbench.setTool(connectActive ? 'select' : 'connect')}
                  >
                    <ConnectPanel workbench={workbench} />
                  </DockSection>
                  <DockSection
                    id="model.explorer"
                    title="Model map"
                    icon={<Boxes size={11} />}
                    badge={<em className="dock-badge">{Object.keys(state.document.subassemblies).length}</em>}
                    open={rightSectionOpen('model.explorer')}
                    grow={rightSectionOpen('model.explorer')}
                    onToggle={() => toggleSection('model.explorer')}
                  >
                    <ModelExplorerPanel workbench={workbench} />
                  </DockSection>
                  <DockSection
                    id="selection"
                    title="Selection"
                    icon={<MousePointer2 size={11} />}
                    badge={<em className="dock-badge">{state.selection.length || '—'}</em>}
                    open={rightSectionOpen('selection')}
                    grow={rightSectionOpen('selection') && state.selection.length > 0}
                    onToggle={() => toggleSection('selection')}
                  >
                    <SelectionPanel workbench={workbench} />
                  </DockSection>
                  <DockSection
                    id="transform"
                    title="Transform"
                    icon={<Move3d size={11} />}
                    open={rightSectionOpen('transform')}
                    grow={rightSectionOpen('transform')}
                    onToggle={() => toggleSection('transform')}
                  >
                    <TransformPanel workbench={workbench} />
                  </DockSection>
                  <DockSection
                    id="inspector"
                    title={inspectorView === 'validate' ? 'Model health' : 'Inspector'}
                    icon={inspectorView === 'validate' ? <CircleAlert size={11} /> : <SlidersHorizontal size={11} />}
                    open={rightSectionOpen('inspector')}
                    grow={rightSectionOpen('inspector')}
                    onToggle={() => toggleSection('inspector')}
                  >
                    <InspectorPanel
                      state={state}
                      selectedPart={workbench.selectedPart}
                      definition={workbench.selectedDefinition}
                      view={inspectorView}
                      activeHealthIssueId={activeHealthIssueId}
                      articulation={workbench.articulation}
                      onViewChange={setInspectorView}
                      onActiveHealthIssue={setActiveHealthIssueId}
                      onFocusHealthIssue={(issue: ModelHealthIssue, mode) => {
                        const ids = issue.partIds.filter((id) => Boolean(cadEngine.getDocument().parts[id]))
                        previousContext.current = { ...previousContext.current, selection: ids.length }
                        cadEngine.setSelection([...ids])
                        if (mode === 'frame' && ids.length) workbench.focusSelection()
                        if (mode === 'isolate' && ids.length) workbench.isolateSelection()
                        if (issue.kind === 'collision') workbench.setRenderMode('violations')
                      }}
                      onArticulate={workbench.driveJoint}
                      onTransform={(id, transform) => workbench.handleTransform(id, transform, true)}
                      onRecolor={workbench.recolorSelection}
                      onProtect={workbench.protectSelection}
                      onSelectIds={(ids) => cadEngine.setSelection(ids)}
                      connect={workbench.connect}
                    />
                  </DockSection>
                </>
              )}
            </div>
          </GlassDock>
        )}

        {!layout.bottom.collapsed && (
          <TimelinePanel
            onSequence={workbench.regenerateBuildOrder}
            state={state}
            playbackStep={workbench.playbackStep}
            view={timelineView}
            onViewChange={setTimelineView}
            activeProposalId={activeProposalId}
            onActiveProposal={setActiveProposalId}
            onPlayStep={workbench.setPlaybackStep}
            onAccept={workbench.acceptProposal}
            onReject={workbench.rejectProposal}
            onSelectIds={(ids) => cadEngine.setSelection(ids)}
            onAddNote={(text) => workbench.runSharedMutation('add_builder_note', { text })}
            onRespondNote={(noteId, response, resolved) =>
              workbench.runSharedMutation('respond_to_note', { noteId, response, resolved })
            }
          />
        )}

        <CommandDeck
          open={deckOpen}
          state={state}
          initialCapability={
            modal?.startsWith('core:command-deck:')
              ? (modal.slice('core:command-deck:'.length) as SharedMutationId)
              : undefined
          }
          onClose={() => workbench.setModal(null)}
          onRun={workbench.runSharedMutation}
        />
        <ShortcutGuide
          open={shortcutsOpen}
          shortcuts={shortcuts}
          onClose={() => workbench.setModal(null)}
          onReplayWelcome={() => workbench.setModal('core:welcome')}
        />
        <WelcomeGuide
          open={welcomeOpen}
          onClose={() => {
            markWelcomeSeen()
            workbench.setModal(null)
          }}
        />
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
          <div
            className="workbench-prompt-backdrop"
            role="presentation"
            onMouseDown={(event) => event.target === event.currentTarget && workbench.setModal(null)}
          >
            <div className="workbench-prompt" role="dialog" aria-modal="true" aria-label="Save selection set">
              <h3>Save this selection</h3>
              <p>
                {state.selection.length} part{state.selection.length === 1 ? '' : 's'} will be recorded by id.
              </p>
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
                <button type="button" onClick={() => workbench.setModal(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="prompt-primary"
                  disabled={!savingSelection.trim()}
                  onClick={() => {
                    workbench.saveSelectionSet(savingSelection.trim())
                    workbench.setModal(null)
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        <ModalSlot />

        {!online && !offlineDismissed && <OfflineState onDismiss={() => setOfflineDismissed(true)} />}

        <ToastStatus toast={workbench.toast} onDismiss={() => workbench.setToast(null)} />
      </main>
    </ExtensionRegistryProvider>
  )
}

export { LAYOUT_PRESETS }

/**
 * A live region that exists before its message does, and a timeout that stops
 * while somebody is reading or operating the notice.
 */
function ToastStatus({ toast, onDismiss }: { toast: WorkbenchNotice | null; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (!toast || paused) return
    const timeout = window.setTimeout(onDismiss, 3600)
    return () => window.clearTimeout(timeout)
  }, [onDismiss, paused, toast])

  return (
    <div
      className="toast-region"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false)
      }}
    >
      {toast && (
        <div className={`toast ${toast.kind}`}>
          <span>
            {toast.kind === 'success' ? (
              <Check size={15} />
            ) : toast.kind === 'error' ? (
              <X size={15} />
            ) : (
              <CircleDot size={15} />
            )}
          </span>
          <div>
            <strong>{toast.title}</strong>
            <p>{toast.detail}</p>
          </div>
          <button onClick={onDismiss} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
