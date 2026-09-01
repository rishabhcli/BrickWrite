import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMOS, getDemo } from '../../demos'
import {
  resetLandingAnalytics,
  setKnownDemoIds,
  setLandingAnalyticsSink,
  type RecordedLandingEvent,
} from '../landing/analytics'
import { installBrowserDoubles } from '../landing/testing'
import { ExplorePage } from './ExplorePage'
import { forkDemo, registerCloudProjectAdapter, type CloudForkInput } from './fork'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const digestOf = (demoId: string) =>
  createHash('sha256')
    .update(readFileSync(path.join(ROOT, 'public/demos', demoId, 'document.json')))
    .digest('hex')

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
    window.history.replaceState(null, '', '/explore?demo=meridian-tower&step=3')
    render(<ExplorePage />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Meridian Tower')
    const slider = screen.getByLabelText(/Build step/) as HTMLInputElement
    expect(slider.value).toBe('3')
    expect(slider.max).toBe(String(getDemo('meridian-tower')!.validation.steps))
  })

  it('says so when a link names a demo that was never published', () => {
    window.history.replaceState(null, '', '/explore?demo=not-a-real-demo')
    render(<ExplorePage />)
    expect(screen.getByRole('status').textContent).toMatch(/no published demo called/i)
  })

  it('follows the back button between demos', async () => {
    window.history.replaceState(null, '', '/explore?demo=meridian-tower')
    render(<ExplorePage />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Meridian Tower')

    await act(async () => {
      window.history.pushState(null, '', '/explore?demo=illinois-main-quad')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Illinois Main Quad campus')

    await act(async () => {
      window.history.back()
      // jsdom applies history moves synchronously but does not always emit the
      // event, so the assertion drives it rather than racing it.
      window.history.replaceState(null, '', '/explore?demo=meridian-tower')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Meridian Tower')
  })

  it('scrubs the build sequence into the URL, so the frame is linkable', async () => {
    window.history.replaceState(null, '', '/explore?demo=meridian-tower')
    render(<ExplorePage />)
    const slider = screen.getByLabelText(/Build step/) as HTMLInputElement
    await act(async () => {
      fireEvent.change(slider, { target: { value: '4' } })
    })
    expect(window.location.search).toBe('?demo=meridian-tower&step=4')
    expect(events.map((entry) => entry.event.name)).toContain('demo.step_scrubbed')
  })

  it('shows the report the kernel produced, not a summary of it', () => {
    window.history.replaceState(null, '', '/explore?demo=meridian-tower')
    render(<ExplorePage />)
    const demo = getDemo('meridian-tower')!
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
    window.history.replaceState(null, '', '/explore?demo=meridian-tower')
    render(<ExplorePage />)
    const group = screen.getByRole('group', { name: 'View' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['Model', 'Exploded', 'First candidate'])
    await act(async () => {
      fireEvent.click(buttons[2])
    })
    expect(screen.getByText(/Showing the first candidate/)).toBeInTheDocument()
    expect(events.map((entry) => entry.event.name)).toContain('demo.view_changed')
  })

  it('describes the model view to a screen reader and lists the sequence as text', () => {
    window.history.replaceState(null, '', '/explore?demo=meridian-tower')
    render(<ExplorePage />)
    const sequence = screen.getByRole('region', { name: /Build sequence, as text/ })
    expect(within(sequence).getAllByRole('listitem').length).toBeGreaterThan(0)
  })
})

describe('forking a demo', () => {
  it('copies the published snapshot into a local project and leaves the demo untouched', async () => {
    const demo = getDemo('meridian-tower')!
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
    const demo = getDemo('illinois-main-quad')!
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
      createProject: async () => {
        throw new Error('must not be called')
      },
    })
    const outcome = await forkDemo(getDemo('meridian-tower')!)
    expect(outcome.ok && outcome.destination).toBe('local')
  })

  it('reports an adapter failure instead of silently writing somewhere else', async () => {
    registerCloudProjectAdapter({
      id: 'test-adapter',
      isSignedIn: () => true,
      createProject: async () => {
        throw new Error('quota exceeded')
      },
    })
    const outcome = await forkDemo(getDemo('illinois-main-quad')!)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.destination).toBe('cloud')
    expect(outcome.message).toMatch(/quota exceeded/)
  })

  it('refuses a snapshot whose bytes do not match the published digest', async () => {
    const demo = getDemo('meridian-tower')!
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

  it('forks and opens the editor from one click', async () => {
    // The copy was always the point of the press. It used to stop and render a
    // second button whose only job was to say "now open it", which made editing
    // a demo a four-click errand from the landing page.
    window.history.replaceState(null, '', '/explore?demo=meridian-tower')
    render(<ExplorePage />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Edit this build/ }))
    })
    // jsdom does not perform `location.assign`, so the navigation itself is not
    // observable here; what is, is that the second step no longer exists and
    // that opening the editor was recorded as part of this one press.
    await waitFor(() => expect(events.map((entry) => entry.event.name)).toContain('demo.fork_completed'))
    expect(screen.queryByRole('link', { name: /Open it in the editor/ })).toBeNull()
    const names = events.map((entry) => entry.event.name)
    expect(names).toContain('demo.fork_started')
    expect(names).toContain('demo.fork_completed')
    expect(names).toContain('editor.opened')
  })
})

describe('the collection the explorer offers', () => {
  it('opens as a large-build library with category filters and editable handoffs', () => {
    render(<ExplorePage />)
    expect(screen.getByRole('heading', { level: 1, name: /Don’t start from zero/ })).toBeInTheDocument()
    expect(screen.getByText(`${DEMOS.length} kernel-verified starting points`)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Preview & edit/ })).toHaveLength(DEMOS.length)
    for (const demo of DEMOS) expect(demo.validation.partCount).toBeGreaterThanOrEqual(1_000)

    fireEvent.click(screen.getByRole('button', { name: 'Animals' }))
    expect(screen.getAllByRole('article')).toHaveLength(DEMOS.filter((demo) => demo.category === 'animals').length)
    expect(screen.getByText('Blue Whale Monument')).toBeInTheDocument()
    expect(screen.getByText('Copper Canyon Mammoth')).toBeInTheDocument()
  })

  it('lists every published demo, so a new set does not need the page changing', () => {
    render(<ExplorePage />)
    // The page reads the generated manifest rather than a hand-kept list. This
    // is what makes adding a demo a `tools/build-demos.mjs` change and nothing
    // else — three sets were added without touching this component, and this is
    // the assertion that would have caught it if they had not appeared.
    for (const demo of DEMOS) {
      expect(screen.getAllByText(demo.title).length, `${demo.id} is offered`).toBeGreaterThan(0)
    }
  })

  it('offers more than one discipline', () => {
    // The complaint that produced the newer sets was never that the demos were
    // small — the hero is 11,473 parts. It was that they were all modular
    // architecture. A collection that drifts back to one discipline has lost
    // the thing these sets were added for.
    const disciplines = new Set(DEMOS.map((demo) => demo.discipline))
    expect(disciplines.size).toBeGreaterThan(1)
  })

  it('opens each published demo by deep link', async () => {
    for (const demo of DEMOS) {
      cleanup()
      window.history.replaceState(null, '', `/explore?demo=${demo.id}`)
      render(<ExplorePage />)
      expect(screen.getByRole('heading', { level: 1 }).textContent, `${demo.id} heading`).toBe(demo.title)
    }
  })
})
