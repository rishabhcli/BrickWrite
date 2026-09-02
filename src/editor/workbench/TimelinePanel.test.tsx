import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function FeedbackHarness({ initialView = 'feedback' }: { initialView?: 'steps' | 'feedback' | 'history' }) {
  const workbench = useWorkbench()
  return <ConnectedTimeline workbench={workbench} initialView={initialView} />
}

function ConnectedTimeline({
  workbench,
  initialView,
}: {
  workbench: Workbench
  initialView: 'steps' | 'feedback' | 'history'
}) {
  return (
    <TimelinePanel
      state={workbench.state}
      playbackStep={workbench.playbackStep}
      playbackPlaying={workbench.playbackPlaying}
      onPlayBuild={workbench.playBuild}
      onPausePlayback={workbench.pausePlayback}
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

function ReviewHarness({ activeProposalId }: { activeProposalId: string }) {
  const workbench = useWorkbench()
  return (
    <TimelinePanel
      state={workbench.state}
      playbackStep={workbench.playbackStep}
      view="review"
      activeProposalId={activeProposalId}
      onActiveProposal={() => undefined}
      onPlayStep={workbench.setPlaybackStep}
      onSequence={workbench.regenerateBuildOrder}
      onAccept={workbench.acceptProposal}
      onReject={workbench.rejectProposal}
      onSelectIds={(ids) => cadEngine.setSelection(ids)}
    />
  )
}

function createReviewProposal() {
  const snapshot = cadEngine.getSnapshot()
  const part = Object.values(snapshot.document.parts)[0]
  const result = cadEngine.preflight(
    'Review the cockpit finish',
    [{ type: 'part.recolor' as const, partId: part.id, color: part.color }],
    'agent',
    snapshot.document.revision,
  )
  if (!result.ok) throw new Error(result.error.message)
  return { proposal: result.value, part }
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
    const partId = Object.values(cadEngine.getDocument().parts).find((part) => !part.protected)!.id
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

describe('shared proposal review', () => {
  it('shows measured operation and validation evidence before commit', () => {
    const { proposal, part } = createReviewProposal()
    render(<ReviewHarness activeProposalId={proposal.id} />)

    expect(screen.getByRole('heading', { name: 'Change review' })).toBeVisible()
    expect(screen.getByText('READY TO COMMIT')).toBeVisible()
    expect(screen.getByText('Appearance and access')).toBeVisible()
    expect(screen.getByText('Kernel preflight is clear to commit.')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /INSPECT 1/ }))
    expect(cadEngine.getSnapshot().selection).toEqual([part.id])
  })

  it('accepts a reviewed ghost as one real human transaction', () => {
    const { proposal } = createReviewProposal()
    const before = cadEngine.getDocument().revision
    render(<ReviewHarness activeProposalId={proposal.id} />)

    fireEvent.click(screen.getByRole('button', { name: /ACCEPT/ }))

    expect(cadEngine.getDocument().revision).toBe(before + 1)
    expect(cadEngine.getSnapshot().proposals).toHaveLength(0)
    expect(cadEngine.getSnapshot().transactions.at(-1)).toMatchObject({
      author: 'human',
      label: 'Review the cockpit finish',
    })
  })

  it('disables acceptance when measured preflight evidence is blocked', () => {
    const { proposal } = createReviewProposal()
    const ids = Object.keys(proposal.previewDocument.parts)
    proposal.validation = {
      ...proposal.validation,
      healthy: false,
      collisions: [
        {
          id: 'review_collision',
          partA: ids[0],
          partB: ids[1],
          overlapLdu: [2, 2, 2],
          message: 'Blocked in review',
          certainty: 'exact',
        },
      ],
    }
    render(<ReviewHarness activeProposalId={proposal.id} />)

    expect(screen.getByText('COMMIT BLOCKED')).toBeVisible()
    expect(screen.getByText('1 collision in the preview.')).toBeVisible()
    expect((screen.getByRole('button', { name: /ACCEPT/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('build playback and edit history chrome', () => {
  afterEach(() => vi.useRealTimers())

  it('holds a clicked step instead of auto-playing the rest of the sequence', () => {
    vi.useFakeTimers()
    render(<FeedbackHarness initialView="steps" />)
    fireEvent.click(screen.getByTitle(/Hold the build at step 2:/i))
    expect(screen.getByText(/Step 2 \//)).toBeVisible()
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByText(/Step 2 \//)).toBeVisible()
    expect(screen.queryByText(/Step 6 \//)).toBeNull()
    vi.useRealTimers()
  })

  it('only auto-advances after Play, and can pause on the held step', () => {
    vi.useFakeTimers()
    render(<FeedbackHarness initialView="steps" />)
    fireEvent.click(screen.getByRole('button', { name: /PLAY/ }))
    expect(screen.getByText(/Step 1 \//)).toBeVisible()
    act(() => {
      vi.advanceTimersByTime(800)
    })
    expect(screen.getByText(/Step 2 \//)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /PAUSE/ }))
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByText(/Step 2 \//)).toBeVisible()
    vi.useRealTimers()
  })

  it('lists every shared transaction instead of silently dropping the oldest eight', () => {
    const partId = Object.values(cadEngine.getDocument().parts).find((part) => !part.protected)!.id
    const part = cadEngine.getDocument().parts[partId]
    for (let index = 0; index < 10; index += 1) {
      const result = cadEngine.execute(
        `History polish ${index}`,
        [{ type: 'part.recolor', partId, color: part.color }],
        'human',
        cadEngine.getDocument().revision,
      )
      if (!result.ok) throw new Error(result.error.message)
    }
    render(<FeedbackHarness initialView="history" />)
    expect(document.querySelectorAll('.transaction-card').length).toBeGreaterThanOrEqual(10)
    expect(screen.getByText(/\d+ edits · document r/)).toBeVisible()
  })

  it('disables a history card whose parts no longer exist', () => {
    const partId = Object.values(cadEngine.getDocument().parts).find((part) => !part.protected)!.id
    const result = cadEngine.execute(
      'Remove rover brick',
      [{ type: 'part.remove', partId }],
      'human',
      cadEngine.getDocument().revision,
    )
    if (!result.ok) throw new Error(result.error.message)
    render(<FeedbackHarness initialView="history" />)
    const card = screen.getByText('Remove rover brick').closest('button')
    expect(card).toBeDisabled()
  })
})
