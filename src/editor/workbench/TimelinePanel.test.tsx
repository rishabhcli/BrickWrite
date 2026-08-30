import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cadEngine } from '../../cad/engine'
import { createShowcaseDocument } from '../../cad/sample'
import { TimelinePanel } from './TimelinePanel'
import { resetPreferences } from './persistence'
import { useWorkbench, type Workbench } from './useWorkbench'

afterEach(cleanup)

beforeEach(() => {
  resetPreferences()
  cadEngine.replaceDocument(createShowcaseDocument())
})

function FeedbackHarness({ initialView = 'feedback' }: { initialView?: 'steps' | 'feedback' }) {
  const workbench = useWorkbench()
  return <ConnectedTimeline workbench={workbench} initialView={initialView} />
}

function ConnectedTimeline({ workbench, initialView }: { workbench: Workbench; initialView: 'steps' | 'feedback' }) {
  return (
    <TimelinePanel
      state={workbench.state}
      playbackStep={workbench.playbackStep}
      view={initialView}
      onPlayStep={workbench.setPlaybackStep}
      onSequence={workbench.regenerateBuildOrder}
      onAccept={workbench.acceptProposal}
      onReject={workbench.rejectProposal}
      onSelectIds={(ids) => cadEngine.setSelection(ids)}
      onAddNote={(text) => workbench.runSharedMutation('add_builder_note', { text })}
      onRespondNote={(noteId, response, resolved) =>
        workbench.runSharedMutation('respond_to_note', { noteId, response, resolved })
      }
    />
  )
}

describe('shared feedback inbox', () => {
  it('opens every anchored handoff and selects its exact model scope', () => {
    render(<FeedbackHarness />)
    const note = cadEngine.getDocument().notes[0]

    fireEvent.click(screen.getByRole('button', { name: /Cockpit geometry is final/i }))

    expect(cadEngine.getSnapshot().selection).toEqual(note.anchorPartIds)
    expect(screen.getByRole('textbox', { name: 'Handoff response' })).toBeVisible()
  })

  it('adds a human handoff through the shared planner and command bus', () => {
    const partId = Object.keys(cadEngine.getDocument().parts)[0]
    act(() => cadEngine.setSelection([partId]))
    const before = cadEngine.getDocument().revision
    render(<FeedbackHarness />)

    fireEvent.click(screen.getAllByRole('button', { name: /NEW/ })[0])
    fireEvent.change(screen.getByRole('textbox', { name: 'New builder note' }), {
      target: { value: 'Keep this axle clear for the next articulation pass.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /ADD NOTE/ }))

    const added = cadEngine.getDocument().notes.at(-1)
    expect(cadEngine.getDocument().revision).toBe(before + 1)
    expect(added).toMatchObject({
      author: 'human',
      status: 'open',
      text: 'Keep this axle clear for the next articulation pass.',
      anchorPartIds: [partId],
    })
    expect(cadEngine.getSnapshot().transactions.at(-1)?.label).toBe('Add spatial builder note')
  })

  it('records a response and resolution as one reversible transaction', () => {
    const noteId = cadEngine.getDocument().notes[0].id
    const before = cadEngine.getDocument().revision
    render(<FeedbackHarness />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Handoff response' }), {
      target: { value: 'Confirmed. The cockpit remains protected and the hull routes around it.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /RESOLVE/ }))

    expect(cadEngine.getDocument().revision).toBe(before + 1)
    expect(cadEngine.getDocument().notes.find((note) => note.id === noteId)).toMatchObject({
      status: 'resolved',
      response: 'Confirmed. The cockpit remains protected and the hull routes around it.',
    })
    expect(cadEngine.getSnapshot().transactions.at(-1)?.operations).toEqual([
      {
        type: 'note.respond',
        noteId,
        response: 'Confirmed. The cockpit remains protected and the hull routes around it.',
        resolved: true,
      },
    ])
  })
})
