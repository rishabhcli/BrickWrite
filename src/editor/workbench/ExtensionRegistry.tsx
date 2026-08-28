import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { CameraView, EditorTool, RenderMode } from '../CadViewport'
import type { PlacementRequest } from '../../cad/placement'
import type { SharedMutationId } from '../../cad/capabilities'
import type { CadOperation, EngineSnapshot } from '../../cad/types'

/**
 * The workbench extension registry.
 *
 * Four other workstreams — agent chat, refinement review, cloud projects and
 * share — need to put surfaces inside this editor without editing it. A shared
 * file that everyone edits is a merge conflict with extra steps, so instead the
 * shell publishes a fixed set of named slots and everything else registers into
 * them at runtime.
 *
 * The contract is deliberately narrow: a contribution is an id, a slot, a
 * priority and a render function that receives the workbench API. It cannot
 * reach into layout, it cannot reorder its neighbours, and it is removed the
 * moment its owner unmounts.
 */

/**
 * Where a contribution can mount.
 *
 *   toolbar      the tool rail, after the built-in groups
 *   panel-left   the left dock, as an additional stacked section
 *   panel-right  the right dock, as an additional stacked section
 *   inspector    inside the inspector's Object tab, below the built-in sections
 *   status       the bottom status bar, right of the built-in readouts
 *   modal        full-screen dialogs; only the active modal renders
 *   overlay      absolutely positioned surfaces over the viewport
 */
export type WorkbenchSlotId =
  | 'toolbar'
  | 'panel-left'
  | 'panel-right'
  | 'inspector'
  | 'status'
  | 'modal'
  | 'overlay'

export const WORKBENCH_SLOTS: readonly WorkbenchSlotId[] = [
  'toolbar',
  'panel-left',
  'panel-right',
  'inspector',
  'status',
  'modal',
  'overlay',
]

export interface WorkbenchNotice {
  kind: 'success' | 'error' | 'info'
  title: string
  detail: string
}

/** Everything a contribution may do to the editor, and nothing more. */
export interface WorkbenchApi {
  /** Live kernel snapshot. Re-rendered whenever the engine emits. */
  readonly snapshot: EngineSnapshot
  readonly selection: readonly string[]
  readonly tool: EditorTool
  readonly activeColor: number
  readonly renderMode: RenderMode
  readonly cameraView: CameraView
  /** The catalog part armed for click-to-place, or null. */
  readonly placement: PlacementRequest | null
  /** False when the browser reports the network is unreachable. */
  readonly online: boolean
  /** Ids currently hidden from the viewport. The document is unchanged. */
  readonly hiddenPartIds: ReadonlySet<string>

  select(partIds: readonly string[]): void
  setTool(tool: EditorTool): void
  setActiveColor(colorCode: number): void
  setRenderMode(mode: RenderMode): void
  setCameraView(view: CameraView): void
  /** Frames the camera on the current selection, or the whole model. */
  frameSelection(): void
  /** Arms a catalog identity for click-to-place. False when it has no geometry. */
  armPart(definitionId: string): boolean
  /** Runs a shared capability through the same planner the agent uses. */
  runCapability(capability: SharedMutationId, args?: Record<string, unknown>): boolean
  /** Commits raw operations as one transaction. */
  execute(label: string, operations: CadOperation[]): boolean
  notify(notice: WorkbenchNotice): void
  /** Opens a registered `modal` contribution by id, or closes the active one. */
  openModal(contributionId: string | null): void
  /** Id of the modal contribution currently showing, or null. */
  readonly activeModal: string | null
}

export interface WorkbenchContribution {
  /** Stable and unique within its slot. Used as the React key and for modals. */
  readonly id: string
  readonly slot: WorkbenchSlotId
  /**
   * Lower sorts earlier. Built-in surfaces occupy 0–99; contributions default
   * to 100, so an extension lands after the shell's own content unless it
   * deliberately asks to come first.
   */
  readonly priority?: number
  /** Shown where the slot renders a header — the docks and the inspector. */
  readonly title?: string
  readonly icon?: ReactNode
  /**
   * Re-evaluated on every render. Returning false unmounts the contribution's
   * subtree, so a surface that is only meaningful for a selection does not have
   * to render an empty shell.
   */
  readonly when?: (api: WorkbenchApi) => boolean
  readonly render: (api: WorkbenchApi) => ReactNode
}

interface RegisteredContribution extends WorkbenchContribution {
  /** Registration sequence, so equal priorities keep insertion order. */
  readonly sequence: number
}

export interface ExtensionRegistry {
  register(contribution: WorkbenchContribution): () => void
  /** Contributions for one slot, ordered by priority then registration. */
  list(slot: WorkbenchSlotId): readonly RegisteredContribution[]
  /** Every registered contribution, ordered the same way. */
  all(): readonly RegisteredContribution[]
  subscribe(listener: () => void): () => void
  /** Stable per-slot snapshot identity, for useSyncExternalStore. */
  version(): number
}

const orderOf = (a: RegisteredContribution, b: RegisteredContribution) =>
  (a.priority ?? 100) - (b.priority ?? 100) || a.sequence - b.sequence

export function createExtensionRegistry(): ExtensionRegistry {
  const entries = new Map<string, RegisteredContribution>()
  const listeners = new Set<() => void>()
  const cache = new Map<WorkbenchSlotId | '*', readonly RegisteredContribution[]>()
  let sequence = 0
  let version = 0

  const emit = () => {
    version += 1
    cache.clear()
    for (const listener of listeners) listener()
  }

  const key = (slot: WorkbenchSlotId, id: string) => `${slot}::${id}`

  return {
    register(contribution) {
      const entryKey = key(contribution.slot, contribution.id)
      const existing = entries.get(entryKey)
      if (existing) {
        // Silent shadowing is the worst outcome here: the second team's panel
        // simply never appears and nothing says why. Last-in wins so the app
        // keeps working, and the collision is reported loudly.
        console.error(
          `[workbench] Two contributions claim "${contribution.id}" in slot "${contribution.slot}". `
          + 'The most recent registration is showing; give one of them a unique id.',
        )
      }
      const entry: RegisteredContribution = { ...contribution, sequence: sequence++ }
      entries.set(entryKey, entry)
      emit()
      return () => {
        // Only withdraw if this registration is still the one on file, so a
        // replaced contribution's cleanup cannot delete its successor.
        if (entries.get(entryKey) === entry) {
          entries.delete(entryKey)
          emit()
        }
      }
    },
    list(slot) {
      const cached = cache.get(slot)
      if (cached) return cached
      const ordered = [...entries.values()].filter((entry) => entry.slot === slot).sort(orderOf)
      cache.set(slot, ordered)
      return ordered
    },
    all() {
      const cached = cache.get('*')
      if (cached) return cached
      const ordered = [...entries.values()].sort(orderOf)
      cache.set('*', ordered)
      return ordered
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    version: () => version,
  }
}

const RegistryContext = createContext<ExtensionRegistry | null>(null)
const ApiContext = createContext<WorkbenchApi | null>(null)

export function ExtensionRegistryProvider({
  registry,
  api,
  children,
}: {
  registry: ExtensionRegistry
  api: WorkbenchApi
  children: ReactNode
}) {
  return (
    <RegistryContext.Provider value={registry}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </RegistryContext.Provider>
  )
}

export function useExtensionRegistry(): ExtensionRegistry {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error('useExtensionRegistry must be used inside <ExtensionRegistryProvider>')
  return registry
}

/**
 * The workbench API, for code rendered inside the shell.
 *
 * Contributions receive the same object as an argument, so this hook exists for
 * components a contribution renders further down its own tree.
 */
export function useWorkbenchApi(): WorkbenchApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error('useWorkbenchApi must be used inside <ExtensionRegistryProvider>')
  return api
}

/** Live, ordered contributions for one slot, filtered by their `when` guard. */
export function useContributions(slot: WorkbenchSlotId): readonly RegisteredContribution[] {
  const registry = useExtensionRegistry()
  const api = useWorkbenchApi()
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry])
  const version = useSyncExternalStore(subscribe, registry.version, registry.version)
  return useMemo(
    () => registry.list(slot).filter((entry) => !entry.when || entry.when(api)),
    // `version` is the store's change token; `registry.list` is pure given it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, slot, version, api],
  )
}

/**
 * Registers a contribution for the lifetime of the calling component.
 *
 * The contribution object is captured in a ref, so a caller may pass a fresh
 * object literal every render without churning the registry — only the id,
 * slot and priority take part in the dependency comparison.
 */
export function useRegisterContribution(contribution: WorkbenchContribution): void {
  const registry = useExtensionRegistry()
  const latest = useRef(contribution)
  latest.current = contribution
  const { id, slot, priority, title } = contribution

  useEffect(() => {
    return registry.register({
      id,
      slot,
      priority,
      title,
      get icon() { return latest.current.icon },
      when: (api) => (latest.current.when ? latest.current.when(api) : true),
      render: (api) => latest.current.render(api),
    })
  }, [registry, id, slot, priority, title])
}

/** Declarative registration, for callers that would rather write JSX. */
export function Contribution(props: WorkbenchContribution): null {
  useRegisterContribution(props)
  return null
}

/**
 * Renders one slot.
 *
 * `wrap` lets a container decorate each contribution — the docks use it to draw
 * a titled section, the toolbar renders them bare.
 */
export function Slot({
  id,
  wrap,
  fallback,
}: {
  id: WorkbenchSlotId
  wrap?: (entry: { id: string; title?: string; icon?: ReactNode; content: ReactNode }) => ReactNode
  fallback?: ReactNode
}) {
  const contributions = useContributions(id)
  const api = useWorkbenchApi()
  if (!contributions.length) return <>{fallback ?? null}</>
  return (
    <>
      {contributions.map((entry) => (
        <ContributionBoundary
          key={`${entry.slot}:${entry.id}`}
          id={entry.id}
          render={() => {
            const content = entry.render(api)
            return wrap ? wrap({ id: entry.id, title: entry.title, icon: entry.icon, content }) : content
          }}
        />
      ))}
    </>
  )
}

/** True when a slot currently has something to draw. Containers hide if not. */
export function useSlotOccupied(id: WorkbenchSlotId): boolean {
  return useContributions(id).length > 0
}

/**
 * Renders only the modal contribution the shell has opened.
 *
 * Modals are exclusive by construction rather than by convention: two extension
 * dialogs stacked on top of each other is never what anybody wanted.
 */
export function ModalSlot() {
  const contributions = useContributions('modal')
  const api = useWorkbenchApi()
  const active = contributions.find((entry) => entry.id === api.activeModal)
  if (!active) return null
  return <ContributionBoundary id={active.id} render={() => active.render(api)} />
}

/**
 * Keeps one broken extension from taking the editor down with it.
 *
 * A CAD session holds unsaved work; an exception thrown while rendering a
 * third-party panel must not discard it. The failure is shown in place, named,
 * and everything else keeps running.
 */
class ContributionErrorBoundary extends Component<
  { id: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="workbench-extension-error" role="alert">
        <strong>{this.props.id} could not render</strong>
        <p>{this.state.error.message}</p>
      </div>
    )
  }
}

/**
 * The render call happens *inside* the boundary, not outside it.
 *
 * A boundary only catches what throws while rendering its own subtree, so
 * invoking `entry.render(api)` in the slot and passing the result down would
 * leave every extension exception uncaught — which is exactly the failure this
 * boundary exists to prevent.
 */
function ContributionBody({ render }: { render: () => ReactNode }) {
  return <>{render()}</>
}

function ContributionBoundary({ id, render }: { id: string; render: () => ReactNode }) {
  return (
    <ContributionErrorBoundary id={id}>
      <ContributionBody render={render} />
    </ContributionErrorBoundary>
  )
}

/**
 * Reports whether the browser believes it is online.
 *
 * Cloud projects, share and the agent all need this, and each of them polling
 * `navigator.onLine` separately would be three subscriptions for one fact.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}
