import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { catalog, type CatalogPayload } from '../../../cad/catalog'
import { decodeMesh } from '../../../cad/mesh'
import { rgbFromHex } from '../../../cad/raster'
import { createShowcaseDocument } from '../../../cad/sample'
import { sha256Hex } from '../canonical'
import { boxGeometry, noGeometry, privateDocument } from '../__fixtures__/model'
import { serializePublishedDocument } from '../serialize'
import { renderBuildSequence, renderCard, renderFrame, renderTurntable } from './cards'
import { readChunkTypes, readPngHeader } from './png'
import { CARD_GEOMETRY, CARD_PRESET_IDS, cloneSettings, normaliseSettings, STUDIO_PRESETS } from './presets'
import type { ShareMesh } from './scene'

/**
 * Card rendering, proved against the real model.
 *
 * The committed catalog and the committed `.bwmesh` geometry are loaded from
 * disk, the showcase rover is assembled from actual LDraw parts, and the cards
 * are rendered by the same offline rasteriser that produces the printed
 * booklet. No browser, no canvas, no WebGL — which is exactly why the output
 * can be asserted at all.
 *
 * The visual-regression artifacts land in `artifacts/share/`, alongside the
 * acceptance run's screenshots.
 */

const ARTIFACTS = 'artifacts/share'

/** Installs the committed catalog, replacing the small test fixture. */
async function installRealCatalog(): Promise<boolean> {
  try {
    const pointer = JSON.parse(await readFile('public/catalog/latest.json', 'utf8')) as {
      manifest: { path: string }
    }
    const manifest = JSON.parse(await readFile(`public/${pointer.manifest.path}`, 'utf8')) as CatalogPayload['manifest']
    const load = async (entry: { path: string }) => JSON.parse(await readFile(`public/${entry.path}`, 'utf8'))
    catalog.install({
      manifest,
      parts: await load(manifest.files.parts),
      search: await load(manifest.files.search),
      colors: await load(manifest.files.colors),
      aliases: await load(manifest.files.aliases),
    })
    return true
  } catch {
    return false
  }
}

async function realGeometry(definitionIds: Iterable<string>) {
  const meshes = new Map<string, ShareMesh | null>()
  for (const definitionId of definitionIds) {
    if (meshes.has(definitionId)) continue
    const asset = catalog.get(definitionId)?.geometryAsset
    if (!asset) {
      meshes.set(definitionId, null)
      continue
    }
    const buffer = await readFile(`public/${asset.file}`)
    const decoded = decodeMesh(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    )
    meshes.set(definitionId, { positions: decoded.positions, indices: decoded.indices, slices: decoded.slices })
  }
  return (definitionId: string) => meshes.get(definitionId) ?? null
}

const palette = (code: number) => rgbFromHex(catalog.color(code).hex)

const installed = await installRealCatalog()
const showcase = installed ? createShowcaseDocument() : null
const published = showcase ? serializePublishedDocument(showcase) : null
const geometry = showcase ? await realGeometry(Object.values(showcase.parts).map((part) => part.definitionId)) : null

const realInput = () => ({
  document: published!,
  geometry: geometry!,
  palette,
  settings: STUDIO_PRESETS.studio,
  attribution: 'BRICKWRIGHT TEST',
})

// The committed catalog is a prerequisite for the whole application, so its
// absence is a hard failure here rather than a silent skip.
it('has the committed catalog and geometry available', () => {
  expect(installed, 'public/catalog is missing; run npm run bootstrap').toBe(true)
  expect(published!.parts.length).toBeGreaterThan(20)
})

describe('social crops', () => {
  it('renders every documented crop at its exact documented size', async () => {
    await mkdir(ARTIFACTS, { recursive: true })
    const manifest: Array<Record<string, unknown>> = []

    for (const preset of CARD_PRESET_IDS) {
      const rendered = renderCard(realInput(), preset)
      const header = readPngHeader(rendered.bytes)
      const expected = CARD_GEOMETRY[preset]

      expect({ width: header.width, height: header.height }).toEqual({
        width: expected.width,
        height: expected.height,
      })
      expect({ bitDepth: header.bitDepth, colourType: header.colourType }).toEqual({ bitDepth: 8, colourType: 6 })
      expect(readChunkTypes(rendered.bytes)).toEqual(['IHDR', 'IDAT', 'IEND'])
      // The model has to actually be in the frame, and it has to not fill it —
      // a card that is all model has lost its framing.
      expect(rendered.coverage, `${preset} coverage`).toBeGreaterThan(0.05)
      expect(rendered.coverage, `${preset} coverage`).toBeLessThan(0.75)
      expect(rendered.missingDefinitionIds).toEqual([])

      await writeFile(`${ARTIFACTS}/card-${preset}.png`, rendered.bytes)
      manifest.push({
        preset,
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.bytes.byteLength,
        coverage: Number(rendered.coverage.toFixed(4)),
        sha256: await sha256Hex(rendered.bytes),
      })
    }

    // 1:1, 4:5, 1.91:1 and the OpenGraph reference size, measured rather than
    // asserted from the table they came from.
    const ratio = (id: (typeof CARD_PRESET_IDS)[number]) => CARD_GEOMETRY[id].width / CARD_GEOMETRY[id].height
    expect(ratio('square')).toBeCloseTo(1, 5)
    expect(ratio('portrait')).toBeCloseTo(0.8, 5)
    expect(ratio('landscape')).toBeCloseTo(1.91, 2)
    expect(CARD_GEOMETRY.opengraph).toMatchObject({ width: 1200, height: 630 })
    expect(CARD_GEOMETRY.twitter).toMatchObject({ width: 1200, height: 600 })

    await writeFile(`${ARTIFACTS}/cards.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  }, 120_000)

  it('renders a genuinely transparent export', () => {
    const rendered = renderCard(realInput(), 'transparent')
    const header = readPngHeader(rendered.bytes)
    expect(header.colourType).toBe(6)

    const frame = renderFrame(
      { ...realInput(), settings: { ...cloneSettings(STUDIO_PRESETS.cutout) } },
      240,
      240,
    )
    const alphaAt = (x: number, y: number) => frame.image.rgba[(y * 240 + x) * 4 + 3]
    // Every corner is fully transparent — there is no baked background.
    expect([alphaAt(0, 0), alphaAt(239, 0), alphaAt(0, 239), alphaAt(239, 239)]).toEqual([0, 0, 0, 0])
    // And the middle is not, or nothing was drawn.
    let opaque = 0
    for (let pixel = 3; pixel < frame.image.rgba.length; pixel += 4) {
      if (frame.image.rgba[pixel] === 255) opaque += 1
    }
    expect(opaque).toBeGreaterThan(1000)
  }, 60_000)

  it('composites an opaque background where one is configured', () => {
    const frame = renderFrame(
      { ...realInput(), settings: { ...cloneSettings(STUDIO_PRESETS.paper) } },
      160,
      160,
    )
    for (let pixel = 3; pixel < frame.image.rgba.length; pixel += 4) {
      expect(frame.image.rgba[pixel]).toBe(255)
    }
    // The paper preset is near-white, so the corner must be light.
    expect(frame.image.rgba[0]).toBeGreaterThan(200)
  }, 60_000)
})

describe('determinism', () => {
  it('produces byte-identical output for the same revision and preset', async () => {
    for (const preset of ['opengraph', 'square', 'transparent'] as const) {
      const first = renderCard(realInput(), preset)
      const second = renderCard(realInput(), preset)
      expect(first.bytes, `${preset} is not deterministic`).toEqual(second.bytes)
      expect(await sha256Hex(first.bytes)).toBe(await sha256Hex(second.bytes))
    }
  }, 120_000)

  it('produces byte-identical output from an independently rebuilt snapshot', async () => {
    // The same revision, serialised again from a freshly assembled document.
    // If anything in the pipeline depended on object identity, insertion order
    // or a clock, these two would differ.
    const rebuilt = serializePublishedDocument(createShowcaseDocument())
    const a = renderCard(realInput(), 'opengraph')
    const b = renderCard({ ...realInput(), document: rebuilt }, 'opengraph')
    expect(await sha256Hex(a.bytes)).toBe(await sha256Hex(b.bytes))
  }, 120_000)

  it('changes the bytes when the preset changes, so the hash is a real cache key', async () => {
    const studio = await sha256Hex(renderCard(realInput(), 'opengraph').bytes)
    const blueprint = await sha256Hex(
      renderCard({ ...realInput(), settings: STUDIO_PRESETS.blueprint }, 'opengraph').bytes,
    )
    expect(blueprint).not.toBe(studio)
  }, 120_000)

  it('changes the bytes when the camera moves', async () => {
    const base = STUDIO_PRESETS.studio
    const turned = { ...cloneSettings(base), camera: { yaw: 35, pitch: 8, roll: 0 } }
    const a = await sha256Hex(renderCard(realInput(), 'square').bytes)
    const b = await sha256Hex(renderCard({ ...realInput(), settings: turned }, 'square').bytes)
    expect(a).not.toBe(b)
  }, 120_000)
})

describe('animations', () => {
  it('renders a turntable as a real APNG', async () => {
    await mkdir(ARTIFACTS, { recursive: true })
    const rendered = renderTurntable(realInput(), { width: 320, height: 320, frames: 12, delayMs: 70 })
    expect(rendered.frames).toBe(12)
    const types = readChunkTypes(rendered.bytes)
    expect(types[0]).toBe('IHDR')
    expect(types[1]).toBe('acTL')
    expect(types.filter((type) => type === 'fcTL')).toHaveLength(12)
    expect(types.filter((type) => type === 'fdAT')).toHaveLength(11)
    await writeFile(`${ARTIFACTS}/turntable.png`, rendered.bytes)
  }, 120_000)

  it('renders one build-sequence frame per step, plus a hold', async () => {
    await mkdir(ARTIFACTS, { recursive: true })
    const rendered = renderBuildSequence(realInput(), { width: 320, height: 320, delayMs: 400 })
    expect(rendered.frames).toBe(published!.steps.length + 1)
    await writeFile(`${ARTIFACTS}/build-sequence.png`, rendered.bytes)
  }, 120_000)

  it('is deterministic across runs', () => {
    const options = { width: 96, height: 96, frames: 4, delayMs: 70 }
    expect(renderTurntable(realInput(), options).bytes).toEqual(renderTurntable(realInput(), options).bytes)
  }, 120_000)
})

describe('degraded inputs', () => {
  const boxInput = {
    document: serializePublishedDocument(privateDocument(3)),
    geometry: boxGeometry,
    palette,
    settings: STUDIO_PRESETS.contact,
    attribution: null,
  }

  it('reports the definitions it could not draw rather than drawing nothing quietly', () => {
    const frame = renderFrame({ ...boxInput, geometry: noGeometry }, 64, 64)
    expect(frame.missingDefinitionIds).toEqual(['3001', '3020'])
    expect(frame.coverage).toBe(0)
    // Still a valid image: the background is composited, so the caller gets a
    // card that says "nothing here" rather than a crash.
    expect(frame.image.rgba).toHaveLength(64 * 64 * 4)
  })

  it('clamps hostile settings instead of rendering them', () => {
    const normalised = normaliseSettings({
      ...cloneSettings(STUDIO_PRESETS.studio),
      camera: { yaw: Number.NaN, pitch: 5000, roll: -720 },
      framing: { padding: 99, zoom: 10_000, offsetX: -50, offsetY: Number.POSITIVE_INFINITY },
      tone: { exposure: 1e9, contrast: -4, shadowLift: 12 },
      supersample: 64 as unknown as 1,
      watermark: { text: 'x'.repeat(500), position: 'bottom-right', opacity: 40, scale: 900, color: 'not-a-colour' },
    })
    expect(normalised.camera).toEqual({ yaw: 0, pitch: 85, roll: 0 })
    // Infinity is not "too far", it is "not a number": the pan re-centres.
    expect(normalised.framing).toEqual({ padding: 0.4, zoom: 4, offsetX: -0.5, offsetY: 0 })
    expect(normalised.tone).toEqual({ exposure: 3, contrast: 0.2, shadowLift: 0.6 })
    expect(normalised.supersample).toBe(2)
    expect(normalised.watermark).toMatchObject({ opacity: 1, scale: 12, color: '#738085' })
    expect(normalised.watermark!.text).toHaveLength(48)
  })

  it('draws a watermark that survives a transparent background', () => {
    const frame = renderFrame(
      {
        ...boxInput,
        settings: {
          ...cloneSettings(STUDIO_PRESETS.cutout),
          watermark: { text: 'BRICKWRIGHT', position: 'bottom-right', opacity: 1, scale: 3, color: '#ffffff' },
        },
      },
      200,
      120,
    )
    // The mark is painted into otherwise-empty pixels, so the bottom-right
    // corner region must contain opaque samples.
    let opaqueInCorner = 0
    for (let y = 90; y < 120; y += 1) {
      for (let x = 100; x < 200; x += 1) {
        if (frame.image.rgba[(y * 200 + x) * 4 + 3] > 200) opaqueInCorner += 1
      }
    }
    expect(opaqueInCorner).toBeGreaterThan(30)
  })
})
