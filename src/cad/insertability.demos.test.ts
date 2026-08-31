import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from './catalog'
import { computeBuildOrder, findBlockedInsertions } from './instructions'
import type { ModelDocument } from './types'

/**
 * The insertion check must not cry wolf on models that are correct.
 *
 * It works on bounding boxes along six axes, so false positives are its expected
 * error — which is why it warns and never refuses. But a warning channel that
 * fires on a correctly ordered build is worse than no channel at all: it trains
 * the operator to ignore it, and then it is silent when it matters.
 *
 * The six shipped demos are 22,245 parts of models the build gates already
 * accept, sequenced by `computeBuildOrder` itself. Every one of them must come
 * back clean.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T

beforeAll(() => {
  const version = readJson<{ catalogVersion: string }>('public/catalog/latest.json').catalogVersion
  const base = `public/catalog/${version}`
  catalog.install({
    manifest: readJson(`${base}/manifest.json`),
    parts: readJson(`${base}/parts.json`),
    search: readJson(`${base}/search.json`),
    colors: readJson(`${base}/colors.json`),
    aliases: readJson(`${base}/aliases.json`),
  } as CatalogPayload)
})

const DEMOS = readJson<{ demos: Array<{ id: string; assets: { document: { url: string } } }> }>(
  'public/demos/manifest.json',
).demos

describe.each(DEMOS.map((demo) => [demo.id, demo] as const))('%s', (_id, demo) => {
  it('reports no blocked insertion in its own build order', { timeout: 120_000 }, () => {
    const document = readJson<ModelDocument>(path.join('public', demo.assets.document.url.replace(/^\//, '')))
    const order = computeBuildOrder(document, { checkInsertability: false })
    const blocked = findBlockedInsertions(document, order.steps)
    expect(
      blocked.map((entry) => `step ${entry.stepIndex}: ${entry.partId} blocked by ${entry.blockedBy.join(', ')}`),
    ).toEqual([])
  })
})
