import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from '../cad/catalog'
import { computeBuildOrder, verifyBuildOrder } from '../cad/instructions'
import { deriveConnectionEdges } from '../cad/snapping'
import { analyseStatics } from '../cad/statics'
import type { ModelDocument } from '../cad/types'
import { validateDocument } from '../cad/validation'
import { DEMO_MANIFEST, DEMOS } from './index'

/**
 * The shipped demos, re-checked against the kernel.
 *
 * `tools/build-demos.mjs` refuses to publish a demo that fails collision,
 * connectivity, stability, catalog or build-order validation. This asserts the
 * same properties over the files that were actually committed, so a manifest
 * edited by hand, an asset replaced out of band or a kernel change that would
 * now reject a published build fails the suite rather than shipping.
 *
 * Everything here except the collision verdict is *re-derived*: the connection
 * graph, the build order and the statics report are computed again from the
 * shipped document. Collision confirmation needs compiled meshes, which are
 * ~48 MB of binary assets and belong to the build gate rather than to a unit
 * test; what is asserted here is that the published report claims zero, that it
 * claims zero *verified* rather than zero *unknown*, and that the document the
 * report describes is the document on disk.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T

/** Installs the full compiled catalog; the shared fixture is a 40-part slice. */
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

const publicPath = (url: string) => path.join('public', url.replace(/^\//, ''))

describe('the shipped demo manifest', () => {
  // The collection used to pad itself out with seven demos, six of which were
  // thirty-part abstract shapes. They were removed: a showcase is judged by the
  // weakest thing in it, not by how many entries it has. What is asserted now is
  // that everything shipped is a real set, not that some count was reached.
  //
  // "Large-scale" is a build gate, not a badge. Programme still matters — every
  // model must come apart and carry a real sequence — but nothing below four
  // digits is allowed to dilute the front-door collection again.
  it('ships only demos substantial enough to stand as examples', () => {
    expect(DEMOS.length).toBeGreaterThanOrEqual(1)
    for (const demo of DEMOS) {
      const document = readJson<ModelDocument>(publicPath(demo.assets.document.url))
      const partCount = Object.keys(document.parts).length
      const assemblies = Object.values(document.subassemblies).filter((item) => item.partIds.length)

      expect(partCount, `${demo.id} part count`).toBeGreaterThanOrEqual(1_000)
      // It comes apart. A model that is one undifferentiated bag is a render,
      // not a set somebody could build.
      expect(assemblies.length, `${demo.id} separable assemblies`).toBeGreaterThan(2)
      // It has a build order with real stages, not one step holding everything.
      expect(document.steps.length, `${demo.id} build steps`).toBeGreaterThan(3)
      expect(demo.discipline.length).toBeGreaterThan(0)
    }
  })

  it('shows more than one discipline, so the collection is not one idea repeated', () => {
    // The operator's complaint was never that the demos were small — the hero
    // is 11,473 parts. It was that they were all the same *kind* of thing:
    // modular architecture stacks with no mechanism in them.
    const disciplines = new Set(DEMOS.map((demo) => demo.discipline))
    expect(disciplines.size).toBeGreaterThan(1)
  })

  it('covers landmarks, buildings, large animals and playful creative work', () => {
    const categories = new Set(DEMOS.map((demo) => demo.category))
    expect(categories).toEqual(new Set(['landmarks', 'architecture', 'animals', 'creative', 'vehicles']))
    expect(DEMOS.filter((demo) => demo.category === 'animals')).toHaveLength(2)
    expect(DEMOS.some((demo) => /survey rover/i.test(demo.title))).toBe(false)
  })

  it('names exactly one hero demo, and it carries a brief', () => {
    const heroes = DEMOS.filter((demo) => demo.hero)
    expect(heroes).toHaveLength(1)
    expect(heroes[0].brief?.prompt.length ?? 0).toBeGreaterThan(20)
  })

  it('makes the hero a five-digit-piece campus with independently counted characters and site work', () => {
    const hero = DEMOS.find((demo) => demo.hero)!
    const document = readJson<ModelDocument>(publicPath(hero.assets.document.url))
    const showcase = hero.showcase

    expect(hero.id).toBe('illinois-main-quad')
    expect(hero.validation.partCount).toBeGreaterThanOrEqual(10_000)
    expect(showcase).toEqual({ landmarkCount: 7, characterCount: 21, siteFinishParts: 9_600 })
    expect(Object.values(document.parts).filter((part) => part.definitionId === '90398')).toHaveLength(
      showcase!.characterCount,
    )
    expect(document.subassemblies.finish.partIds).toHaveLength(showcase!.siteFinishParts)
  })

  it('is built against the catalog this build carries', () => {
    expect(DEMO_MANIFEST.catalogVersion).toBe(catalog.version)
    for (const demo of DEMOS) {
      expect(demo.catalogVersion).toBe(catalog.version)
      expect(demo.provenance.catalogVersion).toBe(catalog.version)
    }
  })

  /**
   * Every part the showcase stands on is still in the pack.
   *
   * The runtime pack is 900 of 22,941 modelled identities, selected by how often
   * a part appears in official set inventories, with a hand-maintained
   * `packExtra` list as the only override. That ranking has already failed once:
   * recompiling against a refreshed LDraw library reshuffled it and the showcase
   * rover's windscreen fell out of the pack, which was fixed by pinning that one
   * part by hand.
   *
   * Nothing was watching. The version check above passes whether or not the pack
   * still carries what the demos reference, because it compares a version string
   * — and the demo builder, which *would* catch it, does not run in CI. So a
   * reshuffle that dropped a structurally important part would ship as a
   * showcase full of `GEOMETRY_UNAVAILABLE` holes and be discovered by a visitor.
   *
   * This is the watcher: it names the missing identity and how many placements
   * depend on it, so the fix — pin it in `packExtra` and recompile — is obvious
   * from the failure alone.
   */
  it('still carries every part the shipped demos are built from', () => {
    const missing = new Map<string, { instances: number; demos: Set<string>; known: boolean }>()
    for (const demo of DEMOS) {
      const document = readJson<ModelDocument>(publicPath(demo.assets.document.url))
      for (const part of Object.values(document.parts)) {
        if (catalog.get(part.definitionId)) continue
        const entry = missing.get(part.definitionId) ?? {
          instances: 0,
          demos: new Set<string>(),
          // Distinguishes "dropped from the pack" from "not in the catalog at
          // all": the first is a ranking accident and a one-line pin, the second
          // means the document references something LDraw does not model.
          known: Boolean(catalog.describe(part.definitionId)),
        }
        entry.instances += 1
        entry.demos.add(demo.id)
        missing.set(part.definitionId, entry)
      }
    }
    const report = [...missing.entries()]
      .sort((a, b) => b[1].instances - a[1].instances)
      .map(
        ([id, entry]) =>
          `${id}: ${entry.instances} placement${entry.instances === 1 ? '' : 's'} in ${[...entry.demos].join(', ')}` +
          ` — ${entry.known ? 'modelled by LDraw but not in this pack; pin it in packExtra' : 'not in the catalog at all'}`,
      )
    expect(report, `Parts the demos need are missing from the compiled pack:\n  ${report.join('\n  ')}`).toEqual([])
  })

  it('records the gates it applied', () => {
    expect(DEMO_MANIFEST.gates.length).toBeGreaterThanOrEqual(5)
    expect(DEMO_MANIFEST.gates.join(' ')).toMatch(/collision/i)
    expect(DEMO_MANIFEST.gates.join(' ')).toMatch(/build order/i)
  })
})

describe.each(DEMOS.map((demo) => [demo.id, demo] as const))('%s', (_id, demo) => {
  const document = readJson<ModelDocument>(publicPath(demo.assets.document.url))

  it('ships every asset it advertises, at the bytes and digest it declares', () => {
    for (const asset of Object.values(demo.assets)) {
      const bytes = readFileSync(path.join(ROOT, publicPath(asset.url)))
      expect(bytes.byteLength, `${asset.url} length`).toBe(asset.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), `${asset.url} digest`).toBe(asset.sha256)
    }
  })

  it('is a versioned ModelDocument that matches its published report', () => {
    expect(document.schemaVersion).toBe(2)
    expect(document.id).toBe(demo.documentId)
    expect(document.catalogVersion).toBe(catalog.version)
    expect(Object.keys(document.parts)).toHaveLength(demo.validation.partCount)
    expect(document.steps).toHaveLength(demo.validation.steps)
    expect(document.revision).toBe(demo.validation.revision)
  })

  it('references only parts this catalog can place', () => {
    for (const part of Object.values(document.parts)) {
      const definition = catalog.get(part.definitionId)
      expect(definition, `${part.id} → ${part.definitionId}`).toBeTruthy()
      expect(definition!.canonicalId).toBe(part.definitionId)
      expect(definition!.geometryAsset, `${part.definitionId} geometry`).toBeTruthy()
    }
  })

  it('is one connected component over a freshly derived connection graph', () => {
    // Derived from the parts, not read from the document, so a hand-edited
    // edge table cannot make a loose model look connected.
    const derived = deriveConnectionEdges(document, document.revision, 'import-inferred')
    expect(Object.keys(derived)).toHaveLength(demo.validation.connectionCount)

    const report = validateDocument({ ...document, connections: derived })
    expect(report.componentCount).toBe(1)
    expect(report.disconnectedPartIds).toHaveLength(0)
    expect(report.connectionCount).toBe(demo.validation.connectionCount)
  })

  it('publishes a build sequence that still satisfies its own guarantee', () => {
    const verified = verifyBuildOrder(document, document.steps)
    expect(verified.violations).toEqual([])
    expect(verified.valid).toBe(true)

    const sequenced = document.steps.flatMap((step) => step.partIds)
    expect(new Set(sequenced).size).toBe(Object.keys(document.parts).length)

    // Regenerating the order must not discover an unsupported island either.
    const regenerated = computeBuildOrder(document)
    expect(regenerated.unsupportedPartIds).toEqual([])
  })

  it('stands up, with its mass measured rather than estimated', () => {
    const statics = analyseStatics(document)
    expect(statics.coverage).toBe(1)
    expect(statics.mass.unmeasuredParts).toBe(0)
    expect(statics.support).toBeTruthy()
    expect(statics.support!.stable).toBe(true)
    expect(statics.support!.marginLdu).toBeCloseTo(demo.validation.statics.tippingMarginLdu ?? 0, 1)
    expect(statics.overloaded.filter((issue) => issue.severity === 'over-capacity')).toEqual([])
    // Parts carried in tension are permitted only where the demo says why.
    expect(statics.unsupportedPartIds.length).toBeLessThanOrEqual(demo.tensionAllowance)
    if (demo.tensionAllowance > 0) expect(demo.tensionReason).toBeTruthy()
  })

  it('published a clean, verified collision verdict', () => {
    expect(demo.validation.collisionCount).toBe(0)
    expect(demo.validation.unverifiedCollisions).toBe(0)
    expect(demo.validation.healthy).toBe(true)
    expect(demo.validation.buildOrderVerified).toBe(true)
  })

  it('is measurably better than the candidate it replaced', () => {
    const delta = demo.delta
    const improved =
      delta.componentsAfter < delta.componentsBefore ||
      delta.loosePartsAfter < delta.loosePartsBefore ||
      delta.unsupportedAfter < delta.unsupportedBefore ||
      delta.collisionsAfter < delta.collisionsBefore
    expect(improved, 'the first candidate must fail something the published model passes').toBe(true)

    const rough = readJson<ModelDocument>(publicPath(demo.assets.rough.url))
    expect(rough.schemaVersion).toBe(2)
    expect(rough.id).toBe(demo.roughDocumentId)
    expect(Object.keys(rough.parts)).toHaveLength(demo.roughValidation.partCount)
  })

  it('carries a camera preset and a bill that adds up', () => {
    expect(Number.isFinite(demo.camera.yaw)).toBe(true)
    expect(Math.abs(demo.camera.pitch)).toBeLessThan(85)
    expect(demo.camera.zoom).toBeGreaterThan(0)

    const counted = new Map<string, number>()
    for (const part of Object.values(document.parts)) {
      counted.set(part.definitionId, (counted.get(part.definitionId) ?? 0) + 1)
    }
    expect(demo.distinctParts).toBe(counted.size)
    for (const line of demo.bill) expect(counted.get(line.definitionId)).toBe(line.count)
  })
})

describe('the published envelope previews', () => {
  it.each(DEMOS.map((demo) => [demo.id, demo] as const))('%s matches its document', (_id, demo) => {
    const preview = readJson<{
      partIds: string[]
      parts: number[][]
      steps: unknown[]
      catalogVersion: string
      definitions: Array<{ id: string }>
    }>(publicPath(demo.assets.preview.url))
    const document = readJson<ModelDocument>(publicPath(demo.assets.document.url))

    expect(preview.catalogVersion).toBe(catalog.version)
    // The stable JSON serializer sorts object keys, while the preview arrays
    // deliberately retain build order so each id stays aligned with its box.
    // Compare membership rather than imposing the object's serialized order.
    expect([...preview.partIds].sort()).toEqual(Object.keys(document.parts).sort())
    expect(preview.parts).toHaveLength(demo.validation.partCount)
    expect(preview.steps).toHaveLength(demo.validation.steps)
    for (const definition of preview.definitions) expect(catalog.get(definition.id)).toBeTruthy()
    // Every box has to be a real, non-degenerate extent, or the view would draw
    // a part that occupies nothing.
    for (const part of preview.parts) {
      expect(part).toHaveLength(11)
      expect(part[3]).toBeGreaterThan(part[0])
      expect(part[4]).toBeGreaterThan(part[1])
      expect(part[5]).toBeGreaterThan(part[2])
    }
  })
})
