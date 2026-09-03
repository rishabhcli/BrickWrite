import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StudPlate } from './StudPlate'
import { installMatchMedia } from './testing'

/**
 * The plate is decoration that answers a person, so what matters is that the
 * answering survives every state the page can put it in — including the two
 * where the rest of the motion is switched off. A visitor who asked for
 * stillness still gets to place a brick; they just do not get the fall.
 *
 * jsdom has no layout, so `getBoundingClientRect` is all zeroes and the
 * pointer path cannot resolve a cell. That is exactly why the keyboard path
 * exists, and it is the one these tests drive.
 */

const bricks = (root: HTMLElement) => root.querySelectorAll('.bw-plate-brick').length
const readout = () => screen.getByText(/bricks down/i).textContent ?? ''
const counted = () => Number(readout().match(/(\d+)\s*bricks down/i)?.[1] ?? -1)

let restore: () => void

beforeEach(() => {
  restore = installMatchMedia(false)
})

afterEach(() => {
  cleanup()
  restore()
})

describe('the plate', () => {
  it('assembles itself, and the readout counts what is actually drawn', async () => {
    const { container } = render(<StudPlate paused={false} />)
    // It starts empty and fills in on a timer, so the first course takes a beat.
    expect(counted()).toBe(0)
    await waitFor(() => expect(counted()).toBeGreaterThan(1), { timeout: 3000 })
    expect(counted()).toBe(bricks(container as unknown as HTMLElement))
  })

  it('arrives finished rather than mid-assembly when motion is switched off', () => {
    const { container } = render(<StudPlate paused />)
    // A still plate is a built plate: skipping the show must not skip the whale.
    expect(bricks(container as unknown as HTMLElement)).toBeGreaterThan(30)
    expect(counted()).toBe(bricks(container as unknown as HTMLElement))
  })

  it('drops a brick from the keyboard, marks it as the visitor’s, and announces it', () => {
    const { container } = render(<StudPlate paused />)
    const before = bricks(container as unknown as HTMLElement)
    const field = screen.getByRole('group', { name: /Arrow keys choose a column/i })

    fireEvent.keyDown(field, { key: 'Enter' })

    expect(bricks(container as unknown as HTMLElement)).toBe(before + 1)
    expect(counted()).toBe(before + 1)
    expect(container.querySelectorAll('.bw-plate-brick[data-mine="true"]')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent(/Brick placed at column \d+, \d+\. \d+ high\./)
    expect(screen.getByText(/placed by you/i)).toBeInTheDocument()
  })

  it('stacks a column instead of overwriting it', () => {
    const { container } = render(<StudPlate paused />)
    const field = screen.getByRole('group', { name: /Arrow keys choose a column/i })
    const before = bricks(container as unknown as HTMLElement)

    fireEvent.keyDown(field, { key: 'Enter' })
    const first = screen.getByRole('status').textContent
    fireEvent.keyDown(field, { key: 'Enter' })
    const second = screen.getByRole('status').textContent

    expect(bricks(container as unknown as HTMLElement)).toBe(before + 2)
    // Same column, one layer higher — not two bricks in the same hole.
    expect(first?.replace(/\d+ high/, '')).toBe(second?.replace(/\d+ high/, ''))
    expect(Number(second?.match(/(\d+) high/)?.[1])).toBe(Number(first?.match(/(\d+) high/)?.[1]) + 1)
  })

  it('takes back only the visitor’s bricks, and offers nothing to take back before that', () => {
    const { container } = render(<StudPlate paused />)
    const built = bricks(container as unknown as HTMLElement)
    const clear = screen.getByRole('button', { name: /Take mine back off/i })
    expect(clear).toBeDisabled()

    const field = screen.getByRole('group', { name: /Arrow keys choose a column/i })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'ArrowRight' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(bricks(container as unknown as HTMLElement)).toBe(built + 2)
    expect(clear).toBeEnabled()

    fireEvent.click(clear)
    expect(bricks(container as unknown as HTMLElement)).toBe(built)
    expect(container.querySelectorAll('.bw-plate-brick[data-mine="true"]')).toHaveLength(0)
    expect(clear).toBeDisabled()
  })

  it('keeps every brick inside the plate however far the keys are pushed', () => {
    const { container } = render(<StudPlate paused />)
    const field = screen.getByRole('group', { name: /Arrow keys choose a column/i })
    for (let step = 0; step < 14; step += 1) fireEvent.keyDown(field, { key: 'ArrowLeft' })
    for (let step = 0; step < 14; step += 1) fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(screen.getByRole('status')).toHaveTextContent(/column 1, 1\./)
    expect(container.querySelectorAll('.bw-plate-brick[data-mine="true"]')).toHaveLength(1)
  })
})

describe('with reduced motion requested', () => {
  beforeEach(() => {
    restore = installMatchMedia(true)
  })

  it('hands over the finished plate and still lets a visitor build on it', () => {
    const { container } = render(<StudPlate paused={false} />)
    const built = bricks(container as unknown as HTMLElement)
    expect(built).toBeGreaterThan(30)

    fireEvent.keyDown(screen.getByRole('group', { name: /Arrow keys choose a column/i }), { key: 'Enter' })
    expect(bricks(container as unknown as HTMLElement)).toBe(built + 1)
  })
})
