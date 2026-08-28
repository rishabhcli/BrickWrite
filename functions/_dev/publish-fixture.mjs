#!/usr/bin/env node
/**
 * Publishes a real model to a running share dev server.
 *
 * This is the seed the acceptance gates are proved against, and every byte of
 * it is real: the committed compiled catalog is installed into the kernel from
 * disk, the showcase rover is assembled from actual LDraw parts at exact LDU
 * transforms, the document is validated, and the social cards are rendered by
 * `src/cad/raster.ts` — the offline software rasteriser — from the snapshot at
 * the exact revision being published.
 *
 * Nothing here fabricates a publication, an author or a statistic. The author
 * is whatever `--author` says, and is omitted when it says nothing.
 *
 *   node functions/_dev/publish-fixture.mjs --server http://127.0.0.1:5199
 */
import { readFile } from 'node:fs/promises'
import { createServer as createViteServer } from 'vite'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const server = flag('server', 'http://127.0.0.1:5199').replace(/\/+$/, '')
const publishToken = process.env.SHARE_PUBLISH_TOKEN ?? 'dev-publish-token'
const visibility = flag('visibility', 'public')
const author = flag('author', '')
const title = flag('title', 'Survey Rover')

const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })

try {
  const [{ catalog }, meshModule, sampleModule, publishModule, cardsModule, presetsModule, canonicalModule, validationModule] =
    await Promise.all([
      vite.ssrLoadModule('/src/cad/catalog.ts'),
      vite.ssrLoadModule('/src/cad/mesh.ts'),
      vite.ssrLoadModule('/src/cad/sample.ts'),
      vite.ssrLoadModule('/src/features/share/publish.ts'),
      vite.ssrLoadModule('/src/features/share/render/cards.ts'),
      vite.ssrLoadModule('/src/features/share/render/presets.ts'),
      vite.ssrLoadModule('/src/features/share/canonical.ts'),
      vite.ssrLoadModule('/src/cad/validation.ts'),
    ])

  // -- install the committed catalog from disk -------------------------------
  const pointer = JSON.parse(await readFile('public/catalog/latest.json', 'utf8'))
  const manifest = JSON.parse(await readFile(`public/${pointer.manifest.path}`, 'utf8'))
  const load = async (entry) => JSON.parse(await readFile(`public/${entry.path}`, 'utf8'))
  const [parts, search, colors, aliases] = await Promise.all([
    load(manifest.files.parts),
    load(manifest.files.search),
    load(manifest.files.colors),
    load(manifest.files.aliases),
  ])
  catalog.install({ manifest, parts, search, colors, aliases })
  process.stdout.write(`catalog ${catalog.version}: ${catalog.placeableCount} placeable parts\n`)

  // -- the model -------------------------------------------------------------
  const document = sampleModule.createShowcaseDocument()
  process.stdout.write(`document: ${Object.keys(document.parts).length} parts, revision ${document.revision}\n`)

  // -- geometry, decoded straight from the committed .bwmesh assets ----------
  const meshes = new Map()
  for (const part of Object.values(document.parts)) {
    if (meshes.has(part.definitionId)) continue
    const definition = catalog.get(part.definitionId)
    const asset = definition?.geometryAsset
    if (!asset) {
      meshes.set(part.definitionId, null)
      continue
    }
    const buffer = await readFile(`public/${asset.file}`)
    const decoded = meshModule.decodeMesh(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    )
    meshes.set(part.definitionId, {
      positions: decoded.positions,
      indices: decoded.indices,
      slices: decoded.slices,
    })
  }
  const geometry = (definitionId) => meshes.get(definitionId) ?? null
  process.stdout.write(`geometry: ${[...meshes.values()].filter(Boolean).length} definitions decoded\n`)

  // -- validation, for an honest badge --------------------------------------
  const validation = validationModule.validateDocument(document)
  process.stdout.write(
    `validation: healthy=${validation.healthy} collisions=${validation.collisions.length} components=${validation.componentCount}\n`,
  )

  // -- cards, rendered offline from the exact snapshot -----------------------
  const { serializePublishedDocument } = await vite.ssrLoadModule('/src/features/share/serialize.ts')
  const published = serializePublishedDocument(document)
  const palette = (code) => {
    const { rgbFromHex } = rasterModule
    return rgbFromHex(catalog.color(code).hex)
  }
  const rasterModule = await vite.ssrLoadModule('/src/cad/raster.ts')

  const settings = presetsModule.STUDIO_PRESETS.studio
  const input = {
    document: published,
    geometry,
    palette,
    settings,
    attribution: author || null,
  }

  const cards = []
  const uploads = {}
  const presets = has('fast') ? ['opengraph', 'twitter', 'square'] : presetsModule.CARD_PRESET_IDS
  for (const preset of presets) {
    const started = Date.now()
    const rendered = cardsModule.renderCard(input, preset)
    const sha256 = await canonicalModule.sha256Hex(rendered.bytes)
    cards.push({
      preset,
      width: rendered.width,
      height: rendered.height,
      contentType: 'image/png',
      sha256,
      byteLength: rendered.bytes.byteLength,
      frames: 1,
      alt: `${title} rendered at revision ${document.revision}`,
    })
    uploads[preset] = Buffer.from(rendered.bytes).toString('base64')
    process.stdout.write(
      `card ${preset}: ${rendered.width}x${rendered.height} ${rendered.bytes.byteLength} bytes coverage=${rendered.coverage.toFixed(3)} in ${Date.now() - started}ms\n`,
    )
  }

  if (!has('fast')) {
    for (const [name, render] of [
      ['turntable', () => cardsModule.renderTurntable(input, { width: 420, height: 420, frames: 16, delayMs: 70 })],
      ['build-sequence', () => cardsModule.renderBuildSequence(input, { width: 420, height: 420, delayMs: 520 })],
    ]) {
      const started = Date.now()
      const rendered = render()
      const sha256 = await canonicalModule.sha256Hex(rendered.bytes)
      cards.push({
        preset: name,
        width: rendered.width,
        height: rendered.height,
        contentType: 'image/png',
        sha256,
        byteLength: rendered.bytes.byteLength,
        frames: rendered.frames,
        alt: `${title}: ${name === 'turntable' ? 'a full rotation' : 'the build sequence'}`,
      })
      uploads[name] = Buffer.from(rendered.bytes).toString('base64')
      process.stdout.write(
        `animation ${name}: ${rendered.frames} frames, ${rendered.bytes.byteLength} bytes in ${Date.now() - started}ms\n`,
      )
    }
  }

  // -- the publication -------------------------------------------------------
  const publication = await publishModule.createPublication({
    document,
    validation,
    visibility,
    capabilities: { view: true, comment: false, fork: true, download: true, embed: true },
    title,
    description: flag(
      'description',
      'A brick-built survey rover assembled from real LDraw parts at exact LDU transforms, with every vertical position derived from the part’s own compiled connectors.',
    ),
    tags: ['rover', 'technic', 'showcase'],
    author: author ? { displayName: author, handle: null, url: null } : null,
    cards,
  })

  const response = await fetch(`${server}/publications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${publishToken}` },
    body: JSON.stringify({ publication, cards: uploads }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`publish failed: ${response.status} ${JSON.stringify(result)}`)

  process.stdout.write(`\npublished ${result.slug}\n`)
  process.stdout.write(`revision   ${publication.revision}\n`)
  process.stdout.write(`hash       ${publication.contentHash}\n`)
  process.stdout.write(`url        ${server}/share/${result.slug}\n`)
  // Machine-readable last line, so a script can capture the slug.
  process.stdout.write(`SLUG=${result.slug}\n`)
} finally {
  await vite.close()
}
