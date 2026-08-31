import type { DemoAsset, DemoEntry, DemoPreview } from './types'

type PreviewDemo = { assets: Pick<DemoEntry['assets'], 'preview' | 'roughPreview'> }
type DocumentDemo = { assets: Pick<DemoEntry['assets'], 'document' | 'rough'> }

async function fetchVerified(
  url: string,
  sha256: string,
  signal?: AbortSignal,
): Promise<{ text: string; verified: boolean }> {
  const response = await fetch(url, { signal, cache: 'force-cache' })
  if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return { text: new TextDecoder().decode(buffer), verified: false }
  const digest = await subtle.digest('SHA-256', buffer)
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== sha256) {
    throw new Error(
      `${url} does not match the manifest digest (expected ${sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…).`,
    )
  }
  return { text: new TextDecoder().decode(buffer), verified: true }
}

const previewCache = new Map<string, Promise<DemoPreview>>()

function waitForPreview(load: Promise<DemoPreview>, signal?: AbortSignal): Promise<DemoPreview> {
  if (!signal) return load
  if (signal.aborted) return Promise.reject(new DOMException('The preview request was aborted.', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new DOMException('The preview request was aborted.', 'AbortError'))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    load.then(
      (preview) => {
        cleanup()
        resolve(preview)
      },
      (cause) => {
        cleanup()
        reject(cause)
      },
    )
  })
}

/** Fetches only immutable preview bytes; importing this module does not import the full manifest. */
export function loadPreview(
  demo: PreviewDemo,
  variant: 'published' | 'rough' = 'published',
  signal?: AbortSignal,
): Promise<DemoPreview> {
  const asset = variant === 'rough' ? demo.assets.roughPreview : demo.assets.preview
  const key = asset.url
  const existing = previewCache.get(key)
  if (existing) return waitForPreview(existing, signal)
  const load = fetchVerified(asset.url, asset.sha256)
    .then(({ text }) => JSON.parse(text) as DemoPreview)
    .catch((cause: unknown) => {
      previewCache.delete(key)
      throw cause
    })
  previewCache.set(key, load)
  return waitForPreview(load, signal)
}

/** Fetches a canonical document snapshot as verified text. */
export function loadDocumentText(
  demo: DocumentDemo,
  variant: 'published' | 'rough' = 'published',
  signal?: AbortSignal,
): Promise<string> {
  const asset = variant === 'rough' ? demo.assets.rough : demo.assets.document
  return fetchVerified(asset.url, asset.sha256, signal).then(({ text }) => text)
}

/** Total bytes a visitor downloads to open one demo in the explorer. */
export const previewWeightBytes = (demo: { assets: { preview: DemoAsset } }): number => demo.assets.preview.bytes
