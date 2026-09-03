import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createExtensionRegistry,
  ExtensionRegistryProvider,
  ModalSlot,
  Slot,
  type ExtensionRegistry,
  type WorkbenchApi,
} from '../editor/workbench'
import { refinementFixture } from './__fixtures__'
import { RefinePanelContribution } from './contribution'

/**
 * The mounting contract.
 *
 * `src/App.tsx` lists `RefinePanelContribution` and nothing else; these tests
 * pin what that one line buys — three surfaces in three named slots — and that
 * unmounting the editor withdraws all three rather than leaving a dead
 * registration behind that the next mount would collide with.
 */

afterEach(cleanup)

const apiFor = (registry: ExtensionRegistry, activeModal: string | null): WorkbenchApi => {
  void registry
  const document = refinementFixture('seam-wall').document
  return {
    snapshot: { document, selection: [] } as unknown as WorkbenchApi['snapshot'],
    selection: [],
    tool: 'select',
    activeColor: 15,
    renderMode: 'beauty',
    cameraView: 'isometric',
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
    armPart: () => true,
    runCapability: () => true,
    execute: () => true,
    notify: () => {},
    openModal: () => {},
  }
}

function Host({
  registry,
  mounted,
  activeModal = null,
}: {
  registry: ExtensionRegistry
  mounted: boolean
  activeModal?: string | null
}) {
  return (
    <ExtensionRegistryProvider registry={registry} api={apiFor(registry, activeModal)}>
      {mounted && <RefinePanelContribution />}
      <Slot id="panel-right" wrap={({ title, content }) => <section aria-label={`dock ${title}`}>{content}</section>} />
      <Slot id="overlay" />
      <ModalSlot />
    </ExtensionRegistryProvider>
  )
}

describe('RefinePanelContribution', () => {
  it('registers the panel, the overlay and the dialog into their documented slots', () => {
    const registry = createExtensionRegistry()
    render(<Host registry={registry} mounted />)

    expect(registry.list('panel-right').map((entry) => entry.id)).toContain('refinement.panel')
    expect(registry.list('overlay').map((entry) => entry.id)).toContain('refinement.overlay')
    expect(registry.list('modal').map((entry) => entry.id)).toContain('refinement.objectives')

    const panel = registry.list('panel-right').find((entry) => entry.id === 'refinement.panel')!
    expect(panel.title).toBe('Refine')
    // Contributions land after the shell's own 0–99 surfaces.
    expect(panel.priority).toBeGreaterThanOrEqual(100)

    // Nothing leaks into a slot this workstream did not ask for.
    for (const slot of ['toolbar', 'panel-left', 'status'] as const) {
      expect(registry.list(slot)).toHaveLength(0)
    }
  })

  it('actually draws the panel through the dock slot', () => {
    const registry = createExtensionRegistry()
    render(<Host registry={registry} mounted />)
    expect(screen.getByRole('region', { name: 'dock Refine' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Refine' })).toBeInTheDocument()
    expect(screen.getByText('Pick a region to refine')).toBeInTheDocument()
  })

  it('keeps the dialog out of the tree until the shell opens it', () => {
    const registry = createExtensionRegistry()
    const view = render(<Host registry={registry} mounted />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(<Host registry={registry} mounted activeModal="refinement.objectives" />)
    expect(screen.getByRole('dialog', { name: /Objectives/ })).toBeInTheDocument()
  })

  it('withdraws every registration on unmount', () => {
    const registry = createExtensionRegistry()
    const view = render(<Host registry={registry} mounted />)
    expect(registry.all()).toHaveLength(3)

    view.rerender(<Host registry={registry} mounted={false} />)
    expect(registry.all()).toHaveLength(0)
    expect(registry.list('panel-right')).toHaveLength(0)
    expect(registry.list('overlay')).toHaveLength(0)
    expect(registry.list('modal')).toHaveLength(0)
    expect(screen.queryByRole('region', { name: 'Refine' })).not.toBeInTheDocument()
  })

  it('re-registers cleanly when the editor remounts', () => {
    const registry = createExtensionRegistry()
    const view = render(<Host registry={registry} mounted />)
    view.rerender(<Host registry={registry} mounted={false} />)
    view.rerender(<Host registry={registry} mounted />)
    expect(registry.all().map((entry) => entry.id).sort()).toEqual([
      'refinement.objectives',
      'refinement.overlay',
      'refinement.panel',
    ])
  })
})
