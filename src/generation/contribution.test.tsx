import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankDocument } from '../cad/sample'
import { createExtensionRegistry, ExtensionRegistryProvider } from '../editor/workbench'
import type { WorkbenchApi } from '../editor/workbench'
import { GeneratePanel } from './GeneratePanel'
import { GeneratePanelContribution } from './contribution'
import { disposeGenerationHost, getGenerationSession } from './host'

/**
 * `?intent=describe` is written by the landing page and was read by nobody.
 *
 * The workbench shell owns the query parameter and consumes it; this panel
 * listens for the event the shell announces. Testing the event rather than the
 * URL is deliberate — it is the contract, and it is the half this file owns.
 */

const api = {
  snapshot: { document: createBlankDocument('Describe intent'), selection: [] },
  selection: [] as readonly string[],
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
  openModal: vi.fn(),
} as unknown as WorkbenchApi

const mount = (children: React.ReactNode) =>
  render(
    <ExtensionRegistryProvider registry={createExtensionRegistry()} api={api}>
      {children}
    </ExtensionRegistryProvider>,
  )

afterEach(() => {
  cleanup()
  disposeGenerationHost()
})

describe('intent=describe', () => {
  it('focuses the prompt when the shell announces the intent', async () => {
    const session = getGenerationSession({ tickMs: 0 })
    mount(
      <>
        <GeneratePanelContribution options={{ tickMs: 0 }} />
        <GeneratePanel api={api} session={session} />
      </>,
    )

    window.dispatchEvent(new CustomEvent('brickwright:intent-describe'))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
  })

  it('leaves the prompt alone when the builder arrived any other way', async () => {
    const session = getGenerationSession({ tickMs: 0 })
    mount(
      <>
        <GeneratePanelContribution options={{ tickMs: 0 }} />
        <GeneratePanel api={api} session={session} />
      </>,
    )

    // No event, no steal: a builder who opened the editor to keep working does
    // not want the caret jumping into a text box.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByRole('textbox')).not.toHaveFocus()
  })
})
