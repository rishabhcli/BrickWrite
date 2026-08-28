import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEMOS, loadPreview } from './index'

afterEach(() => vi.unstubAllGlobals())

describe('demo preview loading', () => {
  it('does not let one StrictMode cleanup poison the shared preview fetch', async () => {
    const demo = DEMOS[0]
    const bytes = await readFile(path.join(process.cwd(), 'public', demo.assets.preview.url.replace(/^\//, '')))
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)

    const firstController = new AbortController()
    const first = loadPreview(demo, 'published', firstController.signal)
    firstController.abort()

    const second = loadPreview(demo, 'published', new AbortController().signal)
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toMatchObject({ catalogVersion: demo.catalogVersion })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
