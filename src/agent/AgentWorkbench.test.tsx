// `tsconfig.app.json` type-checks `.test.tsx` (its exclude list only names
// `.test.ts`), so the jest-dom matcher augmentation is imported here as well
// as in the shared setup file. The import is idempotent at runtime.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createShowcaseDocument } from '../cad/sample'
import { scriptedTransport, type ScriptedLeg } from './__fixtures__/scriptedTransport'
import { AgentWorkbench } from './AgentWorkbench'
import { AgentSession } from './session'

const mount = (script: ScriptedLeg[]) => {
  const transport = scriptedTransport(script)
  const session = new AgentSession({ transport, maxToolTurns: 4 })
  const view = render(<AgentWorkbench session={session} />)
  return { session, transport, view }
}

const composer = () => screen.getByLabelText('Ask the design partner') as HTMLTextAreaElement

const type = (text: string) => fireEvent.change(composer(), { target: { value: text } })

const send = async (text: string) => {
  type(text)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  })
}

describe('AgentWorkbench', () => {
  beforeEach(() => {
    cadEngine.replaceDocument(createShowcaseDocument())
    cadEngine.setAutonomy('propose')
    cadEngine.setSelection([])
  })
  afterEach(() => {
    cleanup()
    cadEngine.replaceDocument(createShowcaseDocument())
  })

  it('renders an honest empty state that explains what it can do', () => {
    mount([])
    expect(screen.getByRole('region', { name: 'Design partner' })).toBeInTheDocument()
    expect(screen.getByText('Nothing has been asked yet.')).toBeInTheDocument()
    expect(screen.getByText('@selection')).toBeInTheDocument()
    // No fabricated activity before anything has happened.
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeInTheDocument()
  })

  it('shows the document revision it is grounded on', () => {
    mount([])
    expect(screen.getByLabelText('Document revision 1')).toHaveTextContent('r1')
  })

  it('streams a reply into the transcript as it arrives', async () => {
    const { session } = mount([{ text: ['The rover has ', '33 parts ', 'across four assemblies.'] }])
    await send('What am I looking at?')

    await waitFor(() => {
      expect(screen.getByText(/33 parts across four assemblies/)).toBeInTheDocument()
    })
    expect(screen.getByText('What am I looking at?')).toBeInTheDocument()
    expect(session.getState().status).toBe('idle')
  })

  it('shows a pending state only while a stream is genuinely open', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session } = mount([{ text: ['Reading', ' the model'], hold: () => gate }])

    type('Look at it')
    const pending = act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await waitFor(() => expect(session.getState().status).toBe('streaming'))
    expect(screen.getAllByRole('status').some((node) => /Replying|Waiting for the model/.test(node.textContent ?? ''))).toBe(true)

    release()
    await pending
    await waitFor(() => expect(session.getState().status).toBe('idle'))
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument()
  })

  it('cancels a turn in flight and says so, rather than spinning forever', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session } = mount([{ text: ['Working', ' on it'], hold: () => gate }])

    type('Rebuild the deck')
    const pending = act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await waitFor(() => expect(session.getState().status).toBe('streaming'))

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    await act(async () => {
      fireEvent.click(cancel)
    })
    release()
    await pending

    await waitFor(() => expect(session.getState().status).toBe('cancelled'))
    expect(screen.getByText('Cancelled by the operator')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('shows a failure as an alert with the reason and a way forward', async () => {
    mount([{ error: { code: 'RATE_LIMITED', message: 'The model API is rate limiting this key.', retryable: true } }])
    await send('Anything at all')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('RATE_LIMITED')).toBeInTheDocument()
    expect(within(alert).getByText(/rate limiting this key/)).toBeInTheDocument()
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(within(alert).getByRole('button', { name: 'Replan' })).toBeInTheDocument()
    // A failure is never dressed up as ongoing work.
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument()
  })

  it('reviews a proposed wave, and accepting it moves the document', async () => {
    const { session } = mount([
      { toolCalls: [{ name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Rover Mk II' } } }] },
      { text: ['One wave ready for review.'] },
    ])
    await send('Rename the project')

    const review = await screen.findByRole('region', { name: 'Proposed changes' })
    expect(within(review).getByText(/Rename project/)).toBeInTheDocument()
    expect(within(review).getByText(/planned at r1/)).toBeInTheDocument()
    expect(cadEngine.getSnapshot().document.revision).toBe(1)

    await act(async () => {
      fireEvent.click(within(review).getByRole('button', { name: 'Accept' }))
    })
    expect(cadEngine.getSnapshot().document.name).toBe('Rover Mk II')
    expect(cadEngine.getSnapshot().document.revision).toBe(2)
    expect(session.getState().waves[0].status).toBe('applied')
  })

  it('rejects a wave without touching the document', async () => {
    mount([
      { toolCalls: [{ name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Nope' } } }] },
      { text: ['Ready.'] },
    ])
    await send('Rename the project')

    const review = await screen.findByRole('region', { name: 'Proposed changes' })
    await act(async () => {
      fireEvent.click(within(review).getByRole('button', { name: 'Reject' }))
    })
    expect(cadEngine.getSnapshot().document.name).toBe('Survey rover')
    expect(cadEngine.getSnapshot().document.revision).toBe(1)
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('offers accept-all only when more than one wave is waiting', async () => {
    mount([
      {
        toolCalls: [
          { name: 'preflight_capability', input: { capability: 'rename_document', args: { name: 'Two waves' } } },
          { name: 'preflight_capability', input: { capability: 'set_piece_budget', args: { maxParts: 500 } } },
        ],
      },
      { text: ['Two waves.'] },
    ])
    await send('Rename it and raise the budget')

    const accept = await screen.findByRole('button', { name: /Accept all 2 waves in order/ })
    await act(async () => {
      fireEvent.click(accept)
    })
    expect(cadEngine.getSnapshot().document.revision).toBe(3)
  })

  it('shows which tools ran, and which of them failed', async () => {
    mount([
      {
        toolCalls: [
          { name: 'scene_overview', input: {} },
          { name: 'preflight_capability', input: { capability: 'create_subassembly', args: { name: 'Ghost', partIds: ['part_nope'] } } },
        ],
      },
      { text: ['One of those failed.'] },
    ])
    await send('Do two things')

    const tools = await screen.findByRole('list', { name: 'Tools used' })
    expect(within(tools).getByText(/scene_overview · ok/)).toBeInTheDocument()
    expect(within(tools).getByText(/preflight_capability · failed/)).toBeInTheDocument()
  })

  it('resolves reference chips as they are typed, and marks the ones that do not exist', async () => {
    cadEngine.setSelection(['part_0001'])
    mount([])
    type('Raise @selection and delete @part:part_9999')

    const chips = screen.getAllByRole('list', { name: 'References in this message' })
    const composerChips = chips[chips.length - 1]
    expect(within(composerChips).getByText(/Selection · 1 part/)).toBeInTheDocument()
    const unresolved = composerChips.querySelector('li[data-resolved="false"]')
    expect(unresolved).not.toBeNull()
    // The reason travels with the chip for a screen-reader user, not only as colour.
    expect(unresolved!.textContent).toContain('part_9999')
    expect(unresolved!.textContent).toContain('No part part_9999 exists at revision 1.')
  })

  it('switches autonomy mode through the kernel', async () => {
    mount([])
    const group = screen.getByRole('radiogroup', { name: 'Autonomy mode' })
    const inspect = within(group).getByRole('radio', { name: 'Inspect' })
    expect(within(group).getByRole('radio', { name: 'Propose' })).toBeChecked()

    await act(async () => {
      fireEvent.click(inspect)
    })
    expect(cadEngine.getSnapshot().autonomy).toBe('inspect')
    expect(inspect).toBeChecked()
  })

  it('records the activity trace with revisions and outcomes', async () => {
    mount([{ toolCalls: [{ name: 'scene_overview', input: {} }] }, { text: ['Done.'] }])
    await send('Look at it')

    const trace = await screen.findByRole('list', { name: 'Activity trace' })
    expect(within(trace).getByText(/tool · scene_overview/)).toBeInTheDocument()
    expect(within(trace).getByText(/message · Operator message/)).toBeInTheDocument()
    // The ledger never narrates.
    expect(trace.textContent ?? '').not.toMatch(/thinking|reasoning|thought/i)
  })
})

describe('AgentWorkbench accessibility', () => {
  beforeEach(() => {
    cadEngine.replaceDocument(createShowcaseDocument())
    cadEngine.setAutonomy('propose')
  })
  afterEach(cleanup)

  it('collapses and expands from the keyboard, restoring focus each way', async () => {
    mount([])
    const toggle = screen.getByRole('button', { name: /Design partner/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    composer().focus()
    expect(document.activeElement).toBe(composer())

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(toggle)

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Focus returns to what the operator was doing, not to the top of the panel.
    expect(document.activeElement).toBe(composer())
  })

  it('hides the panel content from assistive technology when collapsed', async () => {
    mount([])
    const toggle = screen.getByRole('button', { name: /Design partner/ })
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(panel).not.toBeNull()
    expect(panel).not.toHaveAttribute('hidden')

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(panel).toHaveAttribute('hidden')
  })

  it('labels every control and announces status politely', () => {
    mount([])
    expect(screen.getByRole('region', { name: 'Design partner' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Autonomy mode' })).toBeInTheDocument()
    expect(screen.getByLabelText('Ask the design partner')).toBeInTheDocument()
    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(log).toHaveAttribute('aria-live', 'polite')
    const status = screen.getAllByRole('status')
    expect(status.length).toBeGreaterThan(0)
    expect(status[0]).toHaveAttribute('aria-live', 'polite')
    for (const button of screen.getAllByRole('button')) {
      expect((button.textContent ?? '').trim().length).toBeGreaterThan(0)
    }
  })

  it('sends with the keyboard and cancels with Escape', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session } = mount([{ text: ['Working', ' still'], hold: () => gate }])

    type('Keyboard send')
    const pending = act(async () => {
      fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })
    })
    await waitFor(() => expect(session.getState().status).toBe('streaming'))

    fireEvent.keyDown(composer(), { key: 'Escape' })
    release()
    await pending
    await waitFor(() => expect(session.getState().status).toBe('cancelled'))
  })

  it('honours a reduced-motion preference when the platform reports one', () => {
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    })
    try {
      mount([])
      expect(screen.getByRole('region', { name: 'Design partner' })).toHaveAttribute('data-reduced-motion', 'true')
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original })
      else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia')
    }
  })
})
