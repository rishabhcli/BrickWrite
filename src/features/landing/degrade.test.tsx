import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { getDemoSummary } from '../../demos/summary'
import type { DemoPreview, DemoSummary } from '../../demos/types'
import { Hero } from './Hero'
import { installCanvasStub, installMatchMedia } from './testing'

/**
 * What the hero does when a published asset stops matching the manifest.
 *
 * This is a real deployed condition, not a hypothetical: the manifest digests
 * are compiled into the bundle, the bytes are served separately, and the two
 * can fall out of step — a stale build directory still being served, a CDN
 * object cached across a rebuild, or simply a demo regenerated before the
 * manifest was. `fetchVerified` is right to refuse those bytes. The question
 * this file pins down is what the visitor gets when it does, and the answer is
 * the demo's own thumbnail rather than a digest comparison printed over an
 * empty stage.
 *
 * The fixture is synthesised rather than read from `public/demos`, and its
 * digests are computed here from the bytes this file serves. An earlier version
 * loaded the real published assets, which made the "nothing drifted" case fail
 * the moment anyone regenerated a demo — the suite went red for the condition
 * it exists to tolerate. Drift is the subject of this test, so it must be
 * something the test creates, never something it inherits.
 *
 * The suite also lives in its own file on purpose: `loadPreview` memoises by
 * URL for the life of the module, and Vitest gives each file a fresh registry.
 */

const PUBLISHED = '/test-demos/published-preview.json'
const ROUGH = '/test-demos/rough-preview.json'

function preview(id: string): DemoPreview {
  return {
    id,
    name: id,
    revision: 1,
    catalogVersion: 'test',
    boundsLdu: { min: [0, 0, 0], max: [1, 1, 1] },
    definitions: [],
    colors: [],
    subassemblies: [],
    steps: [],
    studLayouts: [],
    partIds: [],
    parts: [],
  }
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const digestOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const PUBLISHED_BYTES = bytesOf(preview('published'))
const ROUGH_BYTES = bytesOf(preview('rough'))
/** Well-formed JSON that is simply not the bytes the manifest measured. */
const DRIFTED_BYTES = bytesOf(preview('regenerated-since-this-bundle-was-built'))

/** A real summary, re-pointed at assets whose digests this file owns. */
function subject(): DemoSummary {
  const real = getDemoSummary('blue-whale-monument')
  if (!real) throw new Error('blue-whale-monument is missing from the summary manifest')
  return {
    ...real,
    assets: {
      ...real.assets,
      preview: {
        url: PUBLISHED,
        bytes: PUBLISHED_BYTES.byteLength,
        sha256: digestOf(PUBLISHED_BYTES),
        contentType: 'application/json',
      },
      roughPreview: {
        url: ROUGH,
        bytes: ROUGH_BYTES.byteLength,
        sha256: digestOf(ROUGH_BYTES),
        contentType: 'application/json',
      },
    },
  }
}

/** Serves the declared bytes, except for the URLs this test names as drifted. */
function installFetch(drifted: string[]): () => void {
  const original = globalThis.fetch
  const bodies = new Map([
    [PUBLISHED, PUBLISHED_BYTES],
    [ROUGH, ROUGH_BYTES],
  ])
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const route = url.replace(/^https?:\/\/[^/]+/, '')
    const body = drifted.includes(route) ? DRIFTED_BYTES : bodies.get(route)
    if (!body) return new Response('not found', { status: 404, statusText: 'Not Found' })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const DIGEST = /does not match the manifest digest/

let restore: (() => void)[] = []
let demo: DemoSummary

beforeEach(() => {
  demo = subject()
  restore = [installMatchMedia(false), installCanvasStub()]
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const undo of restore.reverse()) undo()
})

describe('a hero whose preview bytes no longer match the manifest', () => {
  it('falls back to the verified thumbnail instead of printing the digest comparison', async () => {
    restore.push(installFetch([PUBLISHED, ROUGH]))

    render(<Hero demo={demo} initialStage="validated" autoPlay={false} />)

    const still = await screen.findByRole('img', { name: new RegExp(demo.title) })
    expect(still).toHaveAttribute('src', demo.assets.thumbnail.url)
    expect(screen.getByRole('status')).toHaveTextContent(/Open it to explore the full model/)
    expect(screen.queryByText(DIGEST)).toBeNull()
    // Orbiting is exactly what is unavailable, so the hint must not promise it.
    expect(screen.queryByText(/Drag to orbit/i)).toBeNull()
  })

  it('still draws the stage when only one of the two variants drifted', async () => {
    // The published preview is the one this stage wants; the rough one verifies
    // and carries it. A visitor loses a beat of the story, not the model.
    restore.push(installFetch([PUBLISHED]))

    const { container } = render(<Hero demo={demo} initialStage="validated" autoPlay={false} />)

    await waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(DIGEST)).toBeNull()
    expect(container.querySelector('.bw-stage-still')).toBeNull()
    expect(screen.getByText(/Drag to orbit/i)).toBeInTheDocument()
  })

  it('draws the stage from the declared bytes when nothing drifted', async () => {
    restore.push(installFetch([]))

    const { container } = render(<Hero demo={demo} initialStage="validated" autoPlay={false} />)

    await waitFor(() => expect(container.querySelector('.bw-stage-caption')).toBeTruthy())
    expect(screen.queryByText(DIGEST)).toBeNull()
    expect(container.querySelector('.bw-stage-still')).toBeNull()
    expect(console.warn).not.toHaveBeenCalled()
  })
})
