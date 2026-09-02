import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { getDemo, forkDemo, openProject } = vi.hoisted(() => ({
  getDemo: vi.fn(),
  forkDemo: vi.fn(),
  openProject: vi.fn(),
}))

vi.mock('../../demos', () => ({
  DEMOS: [{ id: 'demo-a', title: 'Blue Whale', validation: { partCount: 1080 } }],
  getDemo,
}))

vi.mock('../../demos/fork', () => ({ forkDemo }))

vi.mock('../../cad/session', () => ({
  session: { openProject },
}))

const { EmptyBuildState } = await import('./states')

afterEach(() => {
  cleanup()
  getDemo.mockReset()
  forkDemo.mockReset()
  openProject.mockReset()
})

describe('empty viewport starters', () => {
  it('says so when forking a published build fails, instead of doing nothing', async () => {
    getDemo.mockReturnValue({ id: 'demo-a', title: 'Blue Whale' })
    forkDemo.mockResolvedValue({ ok: false, destination: 'local', message: 'IndexedDB quota exceeded.' })
    render(<EmptyBuildState onPickStarter={() => {}} />)
    const starter = await screen.findByRole('button', { name: /Blue Whale/ })
    fireEvent.click(starter)
    expect(await screen.findByRole('alert')).toHaveTextContent('IndexedDB quota exceeded.')
    expect(openProject).not.toHaveBeenCalled()
  })

  it('opens the forked project when the copy lands', async () => {
    getDemo.mockReturnValue({ id: 'demo-a', title: 'Blue Whale' })
    forkDemo.mockResolvedValue({
      ok: true,
      destination: 'local',
      projectId: 'proj_1',
      name: 'Blue Whale',
      parts: 1080,
      note: null,
    })
    render(<EmptyBuildState onPickStarter={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /Blue Whale/ }))
    await waitFor(() => expect(openProject).toHaveBeenCalledWith('proj_1'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
