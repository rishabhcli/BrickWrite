import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Test doubles for the two browser capabilities these surfaces depend on and
 * jsdom does not provide.
 *
 * `fetch` is backed by the *real* published assets on disk rather than by
 * fixtures, so a test that loads a preview is loading the bytes a visitor
 * would — including their digests, which the loader verifies.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..')

export function installPublicFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const file = path.join(ROOT, 'public', url.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, ''))
    try {
      const bytes = readFileSync(file)
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/json' } })
    } catch {
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

export function installMatchMedia(matches: boolean): () => void {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = original
  }
}

/** jsdom has no 2D context; the renderer treats that as "nothing to draw". */
export function installCanvasStub(): () => void {
  const original = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof original
  return () => {
    HTMLCanvasElement.prototype.getContext = original
  }
}

export function installBrowserDoubles(options: { reducedMotion?: boolean } = {}) {
  const restore = [installPublicFetch(), installMatchMedia(options.reducedMotion ?? false), installCanvasStub()]
  return () => {
    for (const undo of restore.reverse()) undo()
  }
}
