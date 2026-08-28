# Workstream 5 — Workbench UI

The editor shell: docks, palette, transform controls, selection, command palette,
Connect, and the extension registry the other workstreams mount into.

Everything below lives under `src/editor/workbench/`, with `src/App.tsx` reduced
to a composition root.

---

## 1. Extension registry — the contract

`src/editor/workbench/ExtensionRegistry.tsx`

Other workstreams add surfaces to the editor **without editing any file this
workstream owns**. The shell publishes named slots; you register into them.

### Slots

| Slot | Where it draws | Shape expected |
|---|---|---|
| `toolbar` | tool rail, after the built-in groups | small icon buttons, ~32 px |
| `panel-left` | left dock, as a stacked collapsible section | full-width panel content |
| `panel-right` | right dock, as a stacked collapsible section | full-width panel content |
| `inspector` | inside the inspector Object tab, below the built-in sections | `<section className="property-section">` |
| `status` | bottom status bar, right of the built-in readouts | one short inline readout |
| `modal` | full-screen dialog; only the modal opened via `api.openModal(id)` renders | own backdrop + `role="dialog"` |
| `overlay` | absolutely positioned over the viewport | positioned element |

Ordering inside a slot is `priority` ascending, then registration order.
Built-in surfaces occupy priority `0–99`; contributions default to `100`.

### Registering

```tsx
import { useRegisterContribution, type WorkbenchApi } from '../editor/workbench'

export function AgentChatContribution() {
  useRegisterContribution({
    id: 'agent.chat',            // unique within the slot
    slot: 'panel-right',
    priority: 120,
    title: 'Assistant',          // shown in the dock section header
    icon: <Sparkles size={13} />,
    when: (api) => api.snapshot.autonomy !== 'inspect',   // optional guard
    render: (api: WorkbenchApi) => <AgentChatPanel api={api} />,
  })
  return null
}
```

Mount `<AgentChatContribution />` anywhere inside the workbench tree — the
simplest place is a slot contribution of your own, or via the `contributions`
prop on `<Workbench>` (see §1.4). The registration is withdrawn automatically
when your component unmounts. There is also a declarative form:

```tsx
<Contribution id="share.button" slot="toolbar" priority={110} render={() => <ShareButton />} />
```

### `WorkbenchApi`

The single object passed to `render` and `when`, also available via
`useWorkbenchApi()` anywhere below the provider:

```ts
interface WorkbenchApi {
  readonly snapshot: EngineSnapshot          // live kernel state
  readonly selection: readonly string[]
  readonly tool: EditorTool                  // 'select' | 'move' | 'rotate' | 'connect'
  readonly activeColor: number               // LDraw colour code
  readonly renderMode: RenderMode
  readonly cameraView: CameraView
  readonly placement: PlacementRequest | null
  readonly online: boolean
  readonly hiddenPartIds: ReadonlySet<string>
  readonly activeModal: string | null

  select(partIds: readonly string[]): void
  setTool(tool: EditorTool): void
  setActiveColor(colorCode: number): void
  setRenderMode(mode: RenderMode): void
  setCameraView(view: CameraView): void
  frameSelection(): void
  armPart(definitionId: string): boolean               // false if no compiled geometry
  runCapability(id: SharedMutationId, args?): boolean   // same planner the agent uses
  execute(label: string, operations: CadOperation[]): boolean
  notify(notice: { kind: 'success'|'error'|'info'; title: string; detail: string }): void
  openModal(contributionId: string | null): void
}
```

Rules the registry enforces so you do not have to:

- **Clean unmount.** `useRegisterContribution` withdraws on unmount; a replaced
  registration's cleanup cannot delete its successor.
- **Duplicate ids.** Last registration wins and a `console.error` names the
  collision, rather than one panel silently never appearing.
- **Error isolation.** Each contribution renders inside an error boundary. A
  throw shows a named in-place failure; it does not discard the operator's
  unsaved model.
- **Exclusive modals.** Only `api.activeModal` renders from the `modal` slot.

### 1.4 Mounting contributions

`<Workbench contributions={[AgentChatContribution, ShareContribution]} />` — each
entry is a zero-prop component rendered inside the provider. This is the
integration point `src/App.tsx` uses; other workstreams export their
contribution component from their own `index.ts` and the integrator lists it.

---

## 2. Feature-parity checklist

_(filled in below once the decomposition lands — see §2 in the completed doc)_

## 3. Shortcut map

_(see §3)_
