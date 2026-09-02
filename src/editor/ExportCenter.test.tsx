import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cadEngine } from '../cad/engine'
import { createEmptyDocument } from '../cad/sample'
import { session } from '../cad/session'
import { ExportCenter } from './ExportCenter'

const downloadText = vi.hoisted(() => vi.fn())

vi.mock('../cad/ldraw', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cad/ldraw')>()
  return { ...actual, downloadText }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  downloadText.mockReset()
})

beforeEach(() => {
  cadEngine.replaceDocument(createEmptyDocument())
})

describe('export panel', () => {
  it('is a labelled popover dialog that traps focus and restores it to the opener', async () => {
    const view = render(<ExportCenter state={cadEngine.getSnapshot()} onImport={async () => {}} onNotice={() => {}} />)
    const opener = screen.getByRole('button', { name: 'More export options' })
    expect(opener.getAttribute('aria-haspopup')).toBe('dialog')
    expect(opener.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('.export-backdrop')).toBeNull()

    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: 'Export' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('strong')?.id)
    expect(opener.getAttribute('aria-controls')).toBe(dialog.id)
    expect(opener.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])')).filter(
      (node) => !node.hidden,
    )
    const first = controls[0]!
    const last = controls[controls.length - 1]!
    expect(last.tagName).not.toBe('INPUT')

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('names every format and reports a failed download instead of swallowing it', async () => {
    const notices: Array<{ kind: string; title: string; detail: string }> = []
    render(
      <ExportCenter
        state={cadEngine.getSnapshot()}
        onImport={async () => {}}
        onNotice={(notice) => notices.push(notice)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More export options' }))
    await screen.findByRole('dialog', { name: 'Export' })

    expect(screen.getByRole('button', { name: /Flat LDraw/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Assembly MPD/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Parts manifest/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /BrickLink wanted list/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Project archive/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Flat LDraw/ }))
    expect(downloadText).toHaveBeenCalledWith(expect.stringMatching(/\.ldr$/), expect.any(String))

    downloadText.mockImplementationOnce(() => {
      throw new Error('The browser blocked the download.')
    })
    fireEvent.click(screen.getByRole('button', { name: /Assembly MPD/ }))
    expect(notices).toEqual([
      { kind: 'error', title: 'Assembly MPD not exported', detail: 'The browser blocked the download.' },
    ])
  })

  it('surfaces a thrown archive import instead of failing silently', async () => {
    const notices: Array<{ kind: string; title: string }> = []
    vi.spyOn(session, 'importArchive').mockRejectedValue(new Error('The JSON was truncated.'))
    render(
      <ExportCenter
        state={cadEngine.getSnapshot()}
        onImport={async () => {}}
        onNotice={(notice) => notices.push(notice)}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More export options' }))
    const picker = document.querySelector('input[accept=".json,application/json"]') as HTMLInputElement
    const file = new File(['{'], 'broken.brickwright.json', { type: 'application/json' })
    fireEvent.change(picker, { target: { files: [file] } })
    await waitFor(() => expect(notices[0]?.title).toBe('Archive not imported'))
    expect(notices[0]?.kind).toBe('error')
  })
})
