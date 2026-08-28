import { DEMO_MANIFEST } from './manifest.generated'
import type { DemoEntry, DemoPreview } from './types'

export type {
  DemoAsset,
  DemoAssets,
  DemoBillLine,
  DemoBrief,
  DemoCamera,
  DemoEntry,
  DemoManifest,
  DemoPreview,
  DemoPreviewColor,
  DemoPreviewDefinition,
  DemoPreviewPart,
  DemoPreviewStep,
  DemoPreviewSubassembly,
  DemoProvenance,
  DemoRefinementDelta,
  DemoStaticsSummary,
  DemoValidationSummary,
} from './types'
export { DEMO_MANIFEST } from './manifest.generated'

/**
 * The published demos.
 *
 * Metadata only: a few kilobytes of counts, copy and asset descriptors. The
 * documents and the preview geometry are fetched on demand, because a visitor
 * who never opens a demo should not pay for six of them, and the landing route
 * is not allowed to download the catalog at all.
 */
export const DEMOS: readonly DemoEntry[] = DEMO_MANIFEST.demos

export const getDemo = (id: string): DemoEntry | undefined => DEMOS.find((demo) => demo.id === id)

/** The demo the landing hero is built from. */
export const heroDemo = (): DemoEntry => DEMOS.find((demo) => demo.hero) ?? DEMOS[0]

/**
 * Fetch that verifies what it got.
 *
 * Every demo asset is content-addressed in the manifest, and the whole point of
 * publishing an immutable snapshot is undermined if the runtime will accept
 * whatever a cache or a proxy hands back. `crypto.subtle` is unavailable over
 * plain HTTP on some origins, so a missing digest implementation degrades to an
 * unverified read and says so rather than failing the page.
 */
async function fetchVerified(url: string, sha256: string, signal?: AbortSignal): Promise<{ text: string; verified: boolean }> {
  const response = await fetch(url, { signal, cache: 'force-cache' })
  if (!response.ok) throw new Error(`${url} → ${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return { text: new TextDecoder().decode(buffer), verified: false }
  const digest = await subtle.digest('SHA-256', buffer)
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== sha256) {
    throw new Error(`${url} does not match the manifest digest (expected ${sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…).`)
  }
  return { text: new TextDecoder().decode(buffer), verified: true }
}

const previewCache = new Map<string, Promise<DemoPreview>>()

/**
 * Lets one caller leave a shared immutable fetch without cancelling everybody.
 *
 * React StrictMode deliberately mounts, cleans up and mounts effects again. If
 * the cache owns the first effect's AbortSignal, that cleanup poisons the
 * promise the second mount immediately reuses and the explorer reports an
 * abort instead of a model. The content-addressed fetch may finish and remain
 * cached; only this caller's wait is cancelled.
 */
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

/** Envelope geometry for a demo, or for the candidate that preceded it. */
export function loadPreview(demo: DemoEntry, variant: 'published' | 'rough' = 'published', signal?: AbortSignal): Promise<DemoPreview> {
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

/**
 * The canonical `ModelDocument` snapshot, as text.
 *
 * Returned unparsed so a caller that is only going to hand it to the editor or
 * to a fork never pays to materialise a 140-part object graph, and so the
 * verified bytes and the thing that gets forked are the same bytes.
 */
export function loadDocumentText(demo: DemoEntry, variant: 'published' | 'rough' = 'published', signal?: AbortSignal): Promise<string> {
  const asset = variant === 'rough' ? demo.assets.rough : demo.assets.document
  return fetchVerified(asset.url, asset.sha256, signal).then(({ text }) => text)
}

/** Total bytes a visitor downloads to open one demo in the explorer. */
export const previewWeightBytes = (demo: DemoEntry): number => demo.assets.preview.bytes
