import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { session } from '../cad/session'
import { ProjectMenu } from './ProjectMenu'

vi.mock('../cad/session', () => ({
  session: {
    listProjects: vi.fn(async () => [
      {
        projectId: 'open',
        name: 'Survey rover',
        revision: 4,
        partCount: 3,
        savedAt: '2026-09-01T12:00:00.000Z',
      },
    ]),
    checkpoint: vi.fn(async () => {}),
    forkProject: vi.fn(async () => ({ ok: true })),
    createProject: vi.fn(async () => ({ ok: true })),
    openProject: vi.fn(async () => ({ ok: true })),
    deleteProject: vi.fn(async () => ({ ok: true })),
  },
}))

afterEach(cleanup)

const status = { durable: true, restore: null, error: null }

describe('project menu', () => {
  it('is a labelled popover dialog that traps focus and restores it on Escape', async () => {
    render(
      <ProjectMenu
        documentName="Survey rover"
        documentId="open"
        revision={4}
        sessionStatus={status}
        onNotice={() => {}}
      />,
    )

    const opener = screen.getByRole('button', { name: /Survey rover/ })
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog')
    expect(opener.getAttribute('aria-expanded')).toBe('false')

    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'PROJECTS' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('.eyebrow')?.id)
    expect(opener.getAttribute('aria-controls')).toBe(dialog.id)
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'))
    const first = controls[0]!
    const last = controls[controls.length - 1]!

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('dismisses on an outside pointer without a dimmed backdrop', async () => {
    render(
      <div>
        <ProjectMenu
          documentName="Survey rover"
          documentId="open"
          revision={4}
          sessionStatus={status}
          onNotice={() => {}}
        />
        <button type="button">Outside</button>
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Survey rover/ }))
    await screen.findByRole('dialog', { name: 'PROJECTS' })
    expect(document.querySelector('.project-backdrop')).toBeNull()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('reports a failed checkpoint instead of claiming a save', async () => {
    vi.mocked(session.checkpoint).mockRejectedValueOnce(
      new Error('The project could not be checkpointed (QuotaExceededError). Nothing new was written.'),
    )
    const notices: Array<{ kind: string; title: string; detail: string }> = []
    render(
      <ProjectMenu
        documentName="Survey rover"
        documentId="open"
        revision={4}
        sessionStatus={status}
        onNotice={(notice) => notices.push(notice)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Survey rover/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Checkpoint now/ }))
    await waitFor(() => expect(notices[0]?.kind).toBe('error'))
    expect(notices[0]?.title).toBe('Checkpoint')
    expect(notices[0]?.detail).toMatch(/QuotaExceededError/)
  })
})
