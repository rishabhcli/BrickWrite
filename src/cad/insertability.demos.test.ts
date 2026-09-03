import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from './catalog'
import { findBlockedInsertions } from './instructions'
import type { ModelDocument } from './types'

/**
 * The insertion check must not cry wolf on models that are correct.
 *
 * It works on bounding boxes along six axes, so false positives are its expected
 * error — which is why it warns and never refuses. But a warning channel that
 * fires freely on a correctly ordered build is worse than no channel at all: it
 * trains the operator to ignore it, and then it is silent when it matters.
 *
 * Two things changed here when the collection was rebuilt as real models. The
 * check now runs against the order that actually **ships** — `document.steps`,
 * solved with `checkInsertability: true` — rather than against a naive order
 * recomputed with the check switched off. Following the shipped sequence is what
 * a person does, so that is the sequence worth defending.
 *
 * And the bar is a small budget rather than zero. A dense three-dimensional
 * sculpture genuinely has bricks whose six axis-aligned escape routes are all
 * occupied by the time they go in, and the bounding-box test cannot tell that
 * from a real obstruction. Across 112,000 parts in ten sets the count today is
 * 0, 0, 0, 0, 0, 2, 2, 3, 4 and 10 — noise, and it stays noise only while this
 * budget is tight enough to notice a regression.
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

/** Per demo, not per collection: one bad set cannot hide behind nine good ones. */
const BLOCKED_BUDGET = 12

describe.each(DEMOS.map((demo) => [demo.id, demo] as const))('%s', (_id, demo) => {
  it('keeps blocked insertions in its shipped build order to noise', { timeout: 120_000 }, () => {
    const document = readJson<ModelDocument>(path.join('public', demo.assets.document.url.replace(/^\//, '')))
    const blocked = findBlockedInsertions(document, document.steps)
    expect(
      blocked.map((entry) => `step ${entry.stepIndex}: ${entry.partId} blocked by ${entry.blockedBy.join(', ')}`)
        .length,
      blocked
        .slice(0, 8)
        .map((entry) => `step ${entry.stepIndex}: ${entry.partId} blocked by ${entry.blockedBy.join(', ')}`)
        .join('\n'),
    ).toBeLessThanOrEqual(BLOCKED_BUDGET)
  })

  it('sequences every part exactly once', { timeout: 120_000 }, () => {
    const document = readJson<ModelDocument>(path.join('public', demo.assets.document.url.replace(/^\//, '')))
    const sequenced = document.steps.flatMap((step) => step.partIds)
    expect(new Set(sequenced).size).toBe(Object.keys(document.parts).length)
    expect(sequenced).toHaveLength(Object.keys(document.parts).length)
  })
})
