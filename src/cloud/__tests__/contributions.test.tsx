// `tsconfig.app.json` type-checks `.test.tsx`; the matcher augmentation is
// imported here as well as in the shared setup file, and is idempotent.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExtensionRegistryProvider,
  ModalSlot,
  Slot,
  createExtensionRegistry,
  type WorkbenchApi,
} from '../../editor/workbench'
import { cadEngine } from '../../cad/engine'
import { resetBrowserCloudRuntime } from '../browserRuntime'
import { CloudProjectsContribution } from '../contributions'

/**
 * The registration contract, and the default path through it.
 *
 * Two things are checked. First, that the four surfaces land in the slots
 * `docs/integration/cloud-projects.md` says they land in, and are withdrawn
 * when the composition root unmounts them — a contribution that outlived its
 * owner would keep a dead panel on screen.
 *
 * Second, this is the only test that runs the surfaces against the *real*
 * browser runtime rather than a harness: no `VITE_CONVEX_URL` is set in this
 * repository, so it exercises exactly what a developer sees on checkout.
 */

afterEach(() => {
  cleanup()
  resetBrowserCloudRuntime()
})

const workbenchApi = (activeModal: string | null = null): WorkbenchApi =>
  ({
    snapshot: cadEngine.getSnapshot(),
    selection: [],
    tool: 'select',
    activeColor: 72,
    renderMode: 'beauty',
    cameraView: 'iso',
    placement: null,
    online: true,
    hiddenPartIds: new Set<string>(),
    activeModal,
    select: () => {},
    setTool: () => {},
    setActiveColor: () => {},
    setRenderMode: () => {},
    setCameraView: () => {},
    frameSelection: () => {},
    armPart: () => false,
    runCapability: () => false,
    execute: () => false,
    notify: () => {},
    openModal: () => {},
  }) as unknown as WorkbenchApi

describe('cloud workbench contributions', () => {
  it('registers one surface into each of its three slots, at contribution priority', async () => {
    const registry = createExtensionRegistry()
    await act(async () => {
      render(
        <ExtensionRegistryProvider registry={registry} api={workbenchApi()}>
          <CloudProjectsContribution />
        </ExtensionRegistryProvider>,
      )
    })

    expect(registry.list('status').map((entry) => entry.id)).toEqual(['cloud.sync-status'])
    expect(registry.list('panel-left').map((entry) => entry.id)).toEqual([
      'cloud.projects',
      'cloud.members',
      'cloud.presence',
    ])
    expect(registry.list('modal').map((entry) => entry.id)).toEqual(['cloud.version-history'])
    expect(registry.list('panel-left')[0].title).toBe('Projects')
    expect(registry.list('panel-left')[0].priority).toBe(120)
    expect(registry.list('panel-left')[1].title).toBe('Share')
    expect(registry.list('panel-left')[1].id).toBe('cloud.members')
    expect(registry.list('panel-left')[2].title).toBe('Here now')
    expect(registry.list('panel-left')[2].id).toBe('cloud.presence')
    // Nothing leaks into a slot this workstream does not own.
    for (const slot of ['toolbar', 'panel-right', 'inspector', 'overlay'] as const) {
      expect(registry.list(slot)).toHaveLength(0)
    }
  })

  it('withdraws every registration when the composition root unmounts', async () => {
    const registry = createExtensionRegistry()
    let view: ReturnType<typeof render>
    await act(async () => {
      view = render(
        <ExtensionRegistryProvider registry={registry} api={workbenchApi()}>
          <CloudProjectsContribution />
        </ExtensionRegistryProvider>,
      )
    })
    expect(registry.all()).toHaveLength(5)

    await act(async () => {
      view!.unmount()
    })
    expect(registry.all()).toHaveLength(0)
    for (const slot of ['status', 'panel-left', 'modal'] as const) {
      expect(registry.list(slot)).toHaveLength(0)
    }
  })

  it('renders the honest unconfigured surfaces on a checkout with no VITE_CONVEX_URL', async () => {
    const registry = createExtensionRegistry()
    await act(async () => {
      render(
        <ExtensionRegistryProvider registry={registry} api={workbenchApi('cloud.version-history')}>
          <CloudProjectsContribution />
          <Slot id="panel-left" />
          <Slot id="status" />
          <ModalSlot />
        </ExtensionRegistryProvider>,
      )
    })

    expect(screen.getByTestId('cloud-sync-status')).toHaveAttribute('data-status', 'unconfigured')
    expect(screen.getByTestId('cloud-projects-panel')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-members-panel')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-presence-panel')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-version-history')).toBeInTheDocument()
    // The reason is stated on every surface, not just one of them.
    const text = document.body.textContent ?? ''
    expect(text).toContain('VITE_CONVEX_URL')
    expect(text).toContain('Local only')
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Version history')
  })

  it('renders only the modal the shell has opened', async () => {
    const registry = createExtensionRegistry()
    await act(async () => {
      render(
        <ExtensionRegistryProvider registry={registry} api={workbenchApi(null)}>
          <CloudProjectsContribution />
          <ModalSlot />
        </ExtensionRegistryProvider>,
      )
    })
    expect(screen.queryByTestId('cloud-version-history')).toBeNull()
    expect(registry.list('modal')).toHaveLength(1)
  })
})
