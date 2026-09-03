import { cleanup, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import {
  createExtensionRegistry,
  ExtensionRegistryProvider,
  ModalSlot,
  Slot,
  useRegisterContribution,
  useSlotOccupied,
  useWorkbenchApi,
  WORKBENCH_SLOTS,
  type WorkbenchApi,
} from './ExtensionRegistry'

/**
 * The registry is a published contract: four other workstreams mount into it
 * without editing any file this one owns. These tests pin the guarantees that
 * contract makes — ordering, clean unmount, loud collisions, exclusive modals
 * and isolation from a throwing extension.
 */

// Vitest runs without global injection, so Testing Library's own auto-cleanup
// hook never registers. Without this, one test's DOM leaks into the next.
afterEach(cleanup)

const api = (overrides: Partial<WorkbenchApi> = {}): WorkbenchApi => ({
  snapshot: { selection: [] } as unknown as WorkbenchApi['snapshot'],
  selection: [],
  tool: 'select',
  activeColor: 15,
  renderMode: 'beauty',
  cameraView: 'isometric',
  placement: null,
  online: true,
  hiddenPartIds: new Set<string>(),
  activeModal: null,
  select: () => {},
  setTool: () => {},
  setActiveColor: () => {},
  setRenderMode: () => {},
  setCameraView: () => {},
  frameSelection: () => {},
  armPart: () => true,
  runCapability: () => true,
  execute: () => true,
  notify: () => {},
  openModal: () => {},
  ...overrides,
})

function Host({ children, value = api() }: { children: React.ReactNode; value?: WorkbenchApi }) {
  const [registry] = useState(() => createExtensionRegistry())
  return (
    <ExtensionRegistryProvider registry={registry} api={value}>
      {children}
    </ExtensionRegistryProvider>
  )
}

function Register(props: { id: string; slot: 'panel-right' | 'toolbar' | 'modal'; priority?: number; label?: string; when?: (api: WorkbenchApi) => boolean }) {
  useRegisterContribution({
    id: props.id,
    slot: props.slot,
    priority: props.priority,
    title: props.label,
    when: props.when,
    render: () => <span data-testid={`c-${props.id}`}>{props.label ?? props.id}</span>,
  })
  return null
}

describe('slot vocabulary', () => {
  it('publishes exactly the six slots the shell actually mounts', () => {
    // `inspector` was published and never rendered, so anything registering
    // into it disappeared silently. `status` is mounted in the top bar.
    expect([...WORKBENCH_SLOTS]).toEqual(['toolbar', 'panel-left', 'panel-right', 'status', 'modal', 'overlay'])
  })
})

describe('ordering', () => {
  it('sorts by priority, then by registration order', () => {
    const { container } = render(
      <Host>
        <Register id="third" slot="panel-right" priority={200} label="third" />
        <Register id="first" slot="panel-right" priority={10} label="first" />
        <Register id="secondA" slot="panel-right" priority={100} label="secondA" />
        <Register id="secondB" slot="panel-right" priority={100} label="secondB" />
        <Slot id="panel-right" />
      </Host>,
    )
    const rendered = [...container.querySelectorAll('[data-testid^="c-"]')].map((node) => node.textContent)
    expect(rendered).toEqual(['first', 'secondA', 'secondB', 'third'])
  })

  it('defaults contributions to priority 100, after the shell’s own surfaces', () => {
    const { container } = render(
      <Host>
        <Register id="builtin" slot="toolbar" priority={20} label="builtin" />
        <Register id="extension" slot="toolbar" label="extension" />
        <Slot id="toolbar" />
      </Host>,
    )
    const rendered = [...container.querySelectorAll('[data-testid^="c-"]')].map((node) => node.textContent)
    expect(rendered).toEqual(['builtin', 'extension'])
  })
})

describe('lifecycle', () => {
  it('withdraws a contribution when its owner unmounts', () => {
    function Toggle() {
      const [mounted, setMounted] = useState(true)
      return (
        <>
          {mounted && <Register id="temporary" slot="panel-right" label="temporary" />}
          <button onClick={() => setMounted(false)}>drop</button>
          <Slot id="panel-right" />
        </>
      )
    }
    render(<Host><Toggle /></Host>)
    expect(screen.queryByTestId('c-temporary')).not.toBeNull()
    act(() => { screen.getByText('drop').click() })
    expect(screen.queryByTestId('c-temporary')).toBeNull()
  })

  it('reports a duplicate id loudly and shows the newer registration', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <Host>
        <Register id="clash" slot="panel-right" label="original" />
        <Register id="clash" slot="panel-right" label="replacement" />
        <Slot id="panel-right" />
      </Host>,
    )
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0][0])).toContain('clash')
    expect(container.querySelectorAll('[data-testid="c-clash"]').length).toBe(1)
    expect(screen.getByTestId('c-clash').textContent).toBe('replacement')
    error.mockRestore()
  })

  it('lets the same id live in two different slots', () => {
    const { container } = render(
      <Host>
        <Register id="shared" slot="panel-right" label="right" />
        <Register id="shared" slot="toolbar" label="bar" />
        <Slot id="panel-right" />
        <Slot id="toolbar" />
      </Host>,
    )
    expect(container.querySelectorAll('[data-testid="c-shared"]').length).toBe(2)
  })
})

describe('guards and occupancy', () => {
  it('unmounts a contribution whose `when` guard turns false', () => {
    render(
      <Host value={api({ selection: [] })}>
        <Register id="needs-selection" slot="panel-right" when={(current) => current.selection.length > 0} />
        <Slot id="panel-right" />
      </Host>,
    )
    expect(screen.queryByTestId('c-needs-selection')).toBeNull()
  })

  it('renders a guarded contribution once its condition holds', () => {
    render(
      <Host value={api({ selection: ['part_1'] })}>
        <Register id="needs-selection" slot="panel-right" when={(current) => current.selection.length > 0} />
        <Slot id="panel-right" />
      </Host>,
    )
    expect(screen.queryByTestId('c-needs-selection')).not.toBeNull()
  })

  it('reports slot occupancy so a container can hide itself', () => {
    function Probe() {
      return <span data-testid="occupied">{String(useSlotOccupied('panel-left'))}</span>
    }
    render(<Host><Probe /></Host>)
    expect(screen.getByTestId('occupied').textContent).toBe('false')
  })

  it('renders a slot fallback when nothing is registered', () => {
    render(<Host><Slot id="status" fallback={<span data-testid="fallback">empty</span>} /></Host>)
    expect(screen.getByTestId('fallback').textContent).toBe('empty')
  })
})

describe('modals', () => {
  it('renders only the modal the shell has opened', () => {
    render(
      <Host value={api({ activeModal: 'second' })}>
        <Register id="first" slot="modal" label="first" />
        <Register id="second" slot="modal" label="second" />
        <ModalSlot />
      </Host>,
    )
    expect(screen.queryByTestId('c-first')).toBeNull()
    expect(screen.queryByTestId('c-second')).not.toBeNull()
  })

  it('renders nothing when no modal is open', () => {
    render(
      <Host>
        <Register id="first" slot="modal" label="first" />
        <ModalSlot />
      </Host>,
    )
    expect(screen.queryByTestId('c-first')).toBeNull()
  })
})

describe('isolation', () => {
  it('contains a throwing extension instead of losing the editor', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Exploding() {
      useRegisterContribution({
        id: 'broken',
        slot: 'panel-right',
        render: () => {
          throw new Error('third-party panel blew up')
        },
      })
      return null
    }
    render(
      <Host>
        <Exploding />
        <Register id="healthy" slot="panel-right" label="healthy" />
        <Slot id="panel-right" />
      </Host>,
    )
    expect(screen.getByRole('alert').textContent).toContain('broken')
    expect(screen.queryByTestId('c-healthy')).not.toBeNull()
    error.mockRestore()
  })
})

describe('api access', () => {
  it('is reachable from anywhere below the provider', () => {
    function Deep() {
      const current = useWorkbenchApi()
      return <span data-testid="tool">{current.tool}</span>
    }
    render(<Host value={api({ tool: 'connect' })}><Deep /></Host>)
    expect(screen.getByTestId('tool').textContent).toBe('connect')
  })

  it('throws a named error when used outside the provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Orphan() {
      useWorkbenchApi()
      return null
    }
    expect(() => render(<Orphan />)).toThrow(/ExtensionRegistryProvider/)
    error.mockRestore()
  })
})
