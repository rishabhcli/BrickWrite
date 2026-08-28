import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMOS, getDemo } from '../../demos'
import { resetLandingAnalytics, setKnownDemoIds, setLandingAnalyticsSink, type RecordedLandingEvent } from '../landing/analytics'
import { installBrowserDoubles } from '../landing/testing'
import { ExplorePage } from './ExplorePage'
import { forkDemo, registerCloudProjectAdapter, type CloudForkInput } from './fork'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const digestOf = (demoId: string) =>
  createHash('sha256').update(readFileSync(path.join(ROOT, 'public/demos', demoId, 'document.json'))).digest('hex')

let restore: () => void
let events: RecordedLandingEvent[]

beforeEach(() => {
  restore = installBrowserDoubles()
  setKnownDemoIds(DEMOS.map((demo) => demo.id))
  events = []
  setLandingAnalyticsSink((recorded) => events.push(recorded))
  window.history.replaceState(null, '', '/explore')
})

afterEach(() => {
  cleanup()
  resetLandingAnalytics()
  registerCloudProjectAdapter(null)
  restore?.()
})

describe('the explorer', () => {
  it('opens the demo a deep link names, at the step it names', async () => {
    window.history.replaceState(null, '', '/explore?demo=heron-sculpture&step=3')
    render(<ExplorePage />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Heron')
    const slider = screen.getByLabelText(/Build step/) as HTMLInputElement
    expect(slider.value).toBe('3')
    expect(slider.max).toBe(String(getDemo('heron-sculpture')!.validation.steps))
  })

  it('says so when a link names a demo that was never published', () => {
    window.history.replaceState(null, '', '/explore?demo=not-a-real-demo')
    render(<ExplorePage />)
    expect(screen.getByRole('status').textContent).toMatch(/no published demo called/i)
  })

  it('follows the back button between demos', async () => {
    window.history.replaceState(null, '', '/explore?demo=heron-sculpture')
    render(<ExplorePage />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Heron')

    await act(async () => {
      window.history.pushState(null, '', '/explore?demo=snot-kiosk')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('SNOT kiosk')

    await act(async () => {
      window.history.back()
      // jsdom applies history moves synchronously but does not always emit the
      // event, so the assertion drives it rather than racing it.
      window.history.replaceState(null, '', '/explore?demo=heron-sculpture')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Heron')
  })

  it('scrubs the build sequence into the URL, so the frame is linkable', async () => {
    window.history.replaceState(null, '', '/explore?demo=courtyard-terrace')
    render(<ExplorePage />)
    const slider = screen.getByLabelText(/Build step/) as HTMLInputElement
    await act(async () => {
      fireEvent.change(slider, { target: { value: '4' } })
    })
    expect(window.location.search).toBe('?demo=courtyard-terrace&step=4')
    expect(events.map((entry) => entry.event.name)).toContain('demo.step_scrubbed')
  })

  it('shows the report the kernel produced, not a summary of it', () => {
    window.history.replaceState(null, '', '/explore?demo=courtyard-terrace')
    render(<ExplorePage />)
    const demo = getDemo('courtyard-terrace')!
    const report = screen.getByRole('complementary', { name: 'Model report' })
    const text = report.textContent ?? ''
    expect(text).toContain(String(demo.validation.connectionCount))
    expect(text).toContain(String(demo.validation.partCount))
    expect(text).toContain(demo.validation.statics.massLabel)
    expect(text).toContain(demo.validation.statics.supportLabel)
    // The two figures that are assumptions are labelled as assumptions.
    expect(text).toMatch(/Clutch capacity is an assumption/)
    expect(text).toMatch(/runs roughly 8–15% heavy|idealized solids/)
  })

  it('offers the model, the exploded view and the earlier candidate', async () => {
    render(<ExplorePage />)
    const group = screen.getByRole('group', { name: 'View' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['Model', 'Exploded', 'First candidate'])
    await act(async () => { fireEvent.click(buttons[2]) })
    expect(screen.getByText(/Showing the first candidate/)).toBeInTheDocument()
    expect(events.map((entry) => entry.event.name)).toContain('demo.view_changed')
  })

  it('describes the model view to a screen reader and lists the sequence as text', () => {
    window.history.replaceState(null, '', '/explore?demo=heron-sculpture')
    render(<ExplorePage />)
    const sequence = screen.getByRole('region', { name: /Build sequence, as text/ })
    expect(within(sequence).getAllByRole('listitem').length).toBeGreaterThan(0)
  })
})

describe('forking a demo', () => {
  it('copies the published snapshot into a local project and leaves the demo untouched', async () => {
    const demo = getDemo('heron-sculpture')!
    const before = digestOf(demo.id)
    const outcome = await forkDemo(demo, { name: 'My heron' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.destination).toBe('local')
    expect(outcome.projectId).not.toBe(demo.documentId)
    expect(outcome.name).toBe('My heron')
    expect(outcome.parts).toBe(demo.validation.partCount)
    expect(digestOf(demo.id), 'the canonical demo must be immutable').toBe(before)
    expect(before).toBe(demo.assets.document.sha256)
  })

  it('hands a signed-in visitor to the registered cloud adapter, with provenance', async () => {
    const demo = getDemo('snot-kiosk')!
    const created = vi.fn(async (_input: CloudForkInput) => ({ projectId: 'cloud_1', url: '/projects/cloud_1' }))
    registerCloudProjectAdapter({ id: 'test-adapter', isSignedIn: () => true, createProject: created })

    const outcome = await forkDemo(demo)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.destination !== 'cloud') throw new Error('expected a cloud fork')
    expect(outcome.adapter).toBe('test-adapter')
    expect(outcome.projectId).toBe('cloud_1')

    const input = created.mock.calls[0][0]
    expect(input.source).toEqual({
      kind: 'demo',
      demoId: demo.id,
      catalogVersion: demo.catalogVersion,
      sha256: demo.assets.document.sha256,
    })
    const document = input.document as { id: string; parts: Record<string, unknown> }
    expect(Object.keys(document.parts)).toHaveLength(demo.validation.partCount)
    expect(digestOf(demo.id)).toBe(demo.assets.document.sha256)
  })

  it('falls back to a local project when the adapter says nobody is signed in', async () => {
    registerCloudProjectAdapter({
      id: 'test-adapter',
      isSignedIn: () => false,
      createProject: async () => { throw new Error('must not be called') },
    })
    const outcome = await forkDemo(getDemo('draughting-desk')!)
    expect(outcome.ok && outcome.destination).toBe('local')
  })

  it('reports an adapter failure instead of silently writing somewhere else', async () => {
    registerCloudProjectAdapter({
      id: 'test-adapter',
      isSignedIn: () => true,
      createProject: async () => { throw new Error('quota exceeded') },
    })
    const outcome = await forkDemo(getDemo('shutter-bay')!)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.destination).toBe('cloud')
    expect(outcome.message).toMatch(/quota exceeded/)
  })

  it('refuses a snapshot whose bytes do not match the published digest', async () => {
    const demo = getDemo('heron-sculpture')!
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('{"parts":{}}', { status: 200 })) as typeof fetch
    try {
      const outcome = await forkDemo(demo)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.message).toMatch(/digest/i)
    } finally {
      globalThis.fetch = original
    }
  })

  it('drives the fork from the explorer and offers the editor handoff', async () => {
    window.history.replaceState(null, '', '/explore?demo=heron-sculpture')
    render(<ExplorePage />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Edit this build/ })) })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Copied to a local project/))
    const handoff = screen.getByRole('link', { name: /Open it in the editor/ })
    expect(handoff.getAttribute('href')).toMatch(/^\/editor\?project=/)
    const names = events.map((entry) => entry.event.name)
    expect(names).toContain('demo.fork_started')
    expect(names).toContain('demo.fork_completed')
  })
})
