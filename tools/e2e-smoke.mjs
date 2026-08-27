#!/usr/bin/env node
/**
 * Browser acceptance run.
 *
 * Drives a real Chromium/WebGL session through the whole vertical slice:
 * compiled catalog load, real LDraw geometry in the viewport, dynamic WebMCP
 * tool surface, agent perception capture, non-mutating preflight, atomic
 * acceptance, manual placement, shared undo and LDraw export.
 *
 * Assertions are relational rather than hardcoded counts, so the run stays
 * meaningful when the showcase model or catalog revision changes.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.BRICKWRIGHT_E2E_URL ?? 'http://127.0.0.1:4174'
let server

async function available() {
  try { return (await fetch(url)).ok } catch { return false }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await available()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  if (!(await available())) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], { stdio: 'ignore' })
    await waitForServer()
  }
  await mkdir('artifacts', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (cause) => errors.push(cause.message))

  await page.goto(url, { waitUntil: 'networkidle' })
  // The catalog must load before the editor mounts at all.
  await page.locator('canvas').waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean(window.brickwright), null, { timeout: 30_000 })

  const initial = await page.evaluate(async () => ({
    document: window.brickwright.getDocument(),
    tools: [...window.brickwright.tools.keys()],
    workspace: (await window.brickwright.invoke('workspace_get', {}))?.structuredContent,
    coverage: (await window.brickwright.invoke('action_read', { action: 'catalog_coverage' }))?.structuredContent,
    validation: (await window.brickwright.invoke('validate_model', {}))?.structuredContent,
  }))

  const startRevision = initial.document.revision
  const startParts = Object.keys(initial.document.parts).length

  // -- compiled catalog is real, and its two tiers are distinct --------------
  assert(initial.workspace.catalog.identities > 20000, `Expected the full LDraw identity index, saw ${initial.workspace.catalog.identities}`)
  assert(initial.workspace.catalog.placeable > 300, `Expected a substantial geometry pack, saw ${initial.workspace.catalog.placeable}`)
  assert(initial.workspace.catalog.placeable < initial.workspace.catalog.identities, 'Placeable set should be a strict subset of catalog identities')
  assert(initial.workspace.catalog.colors > 300, `Expected the full LDraw colour table, saw ${initial.workspace.catalog.colors}`)
  assert(initial.coverage.coverage.withAuthoritativeConnections > 10000, 'Expected authoritative LDCad connection coverage across the library')
  assert(initial.coverage.coverage.unresolvedReferences.length === 0, 'Geometry compiler left unresolved LDraw references')

  // -- the opening document is a valid, connected, real-part assembly --------
  assert(startParts > 20, `Expected a substantial showcase, saw ${startParts} parts`)
  assert(initial.validation.collisions.length === 0, `Showcase has ${initial.validation.collisions.length} collisions`)
  assert(initial.validation.componentCount === 1, `Showcase is in ${initial.validation.componentCount} pieces`)
  assert(initial.validation.connectionCount > 50, `Expected many mated connectors, saw ${initial.validation.connectionCount}`)
  assert(
    initial.validation.unverifiedCollisions === 0,
    `Showcase has ${initial.validation.unverifiedCollisions} collision verdicts reached from bounding boxes alone`,
  )

  // -- real geometry actually reached the GPU --------------------------------
  const geometry = await page.evaluate(() => ({
    meshes: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('.bwmesh')).length,
  }))
  assert(geometry.meshes > 5, `Expected compiled .bwmesh assets to be fetched, saw ${geometry.meshes}`)

  // -- dynamic WebMCP surface ------------------------------------------------
  assert(initial.tools.includes('render_capture'), 'render_capture was not registered')
  assert(initial.tools.includes('build_preflight'), 'proposal tools were not registered in Propose mode')
  assert(!initial.tools.includes('build_apply'), 'build_apply leaked into Propose mode')

  const capture = await page.evaluate(() => window.brickwright.invoke('render_capture', { view: 'isometric', mode: 'beauty' }))
  assert(capture.content.some((item) => item.type === 'image' && item.data.length > 10_000), 'render_capture did not return viewport pixels')

  await page.locator('.autonomy-switch').getByRole('button', { name: 'build' }).click()
  assert(await page.evaluate(() => window.brickwright.tools.has('build_apply')), 'Build mode did not register write tools')
  await page.locator('.autonomy-switch').getByRole('button', { name: 'propose' }).click()
  assert(!(await page.evaluate(() => window.brickwright.tools.has('build_apply'))), 'Leaving Build mode did not revoke write tools')

  // -- preflight is non-mutating; acceptance is atomic ----------------------
  await page.getByRole('button', { name: /ghost .* proposal|cargo rack/i }).click()
  await page.locator('.proposal-overlay').waitFor()
  assert((await page.evaluate(() => window.brickwright.getDocument().revision)) === startRevision, 'Preflight mutated the document')
  await page.locator('.proposal-overlay').getByRole('button', { name: /Accept/i }).click()
  const afterProposal = await page.evaluate(() => ({ revision: window.brickwright.getDocument().revision, parts: Object.keys(window.brickwright.getDocument().parts).length }))
  assert(afterProposal.revision === startRevision + 1, `Proposal did not commit as one transaction (r${afterProposal.revision})`)
  assert(afterProposal.parts === startParts + 2, `Proposal committed ${afterProposal.parts - startParts} parts, expected 2`)

  // -- an agent-unplaceable identity is refused with a teaching error -------
  // The subject is discovered from the catalog rather than hardcoded, so the
  // assertion stays valid as the geometry pack changes.
  const unplaceable = await page.evaluate(async () => {
    const search = await window.brickwright.invoke('catalog_search', { text: 'plate', includeHelpers: false, limit: 200 })
    return search.structuredContent.results.find((record) => !record.placeable)?.id ?? null
  })
  assert(unplaceable, 'Expected the catalog to contain a searchable identity without compiled geometry')
  const refused = await page.evaluate((definitionId) => {
    const document = window.brickwright.getDocument()
    return window.brickwright.invoke('build_preflight', {
      expectedRevision: document.revision,
      label: 'Place a part with no compiled geometry',
      operations: [{ op: 'add', definitionId, color: 15, position: [0, -200, 0] }],
    })
  }, unplaceable)
  assert(
    refused.structuredContent?.error?.code === 'GEOMETRY_UNAVAILABLE',
    `Expected GEOMETRY_UNAVAILABLE for ${unplaceable}, saw ${JSON.stringify(refused.structuredContent).slice(0, 240)}`,
  )

  // -- manual placement uses the same bus, and undo stays monotonic ---------
  await page.locator('.part-card').first().locator('.part-add').click()
  const afterAdd = await page.evaluate(() => ({ revision: window.brickwright.getDocument().revision, parts: Object.keys(window.brickwright.getDocument().parts).length }))
  assert(afterAdd.revision === afterProposal.revision + 1 && afterAdd.parts === afterProposal.parts + 1, 'Manual catalog placement did not use the shared command bus')

  await page.getByRole('button', { name: 'Undo' }).click()
  const afterUndo = await page.evaluate(() => ({ revision: window.brickwright.getDocument().revision, parts: Object.keys(window.brickwright.getDocument().parts).length }))
  assert(afterUndo.revision === afterAdd.revision + 1, 'Undo did not advance the revision monotonically')
  assert(afterUndo.parts === afterProposal.parts, 'Undo did not restore the previous part set')

  // -- stale agent writes are rejected by the kernel ------------------------
  const stale = await page.evaluate(() => window.brickwright.invoke('build_preflight', {
    expectedRevision: 1,
    label: 'Stale plan',
    operations: [{ op: 'add', definitionId: '3005', color: 4, position: [0, -400, 0] }],
  }))
  assert(stale.structuredContent?.error?.code === 'STALE_DOCUMENT', `Expected STALE_DOCUMENT, saw ${JSON.stringify(stale.structuredContent).slice(0, 160)}`)

  // -- the collision kernel confirms against triangles, not just boxes -------
  // A 45°-rotated brick's axis-aligned box is far larger than the brick, so a
  // box-only test reports a solid overlap where the geometry has none. Both
  // parts are already in the model, so their meshes are resident and the
  // verdict is a real triangle confirmation rather than an unverified guess.
  const rotatedProbe = await page.evaluate(async () => {
    const model = window.brickwright.getDocument()
    const cos45 = Math.cos(Math.PI / 4)
    const result = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Rotated neighbour probe',
      operations: [
        {
          op: 'add',
          definitionId: '3001',
          color: 15,
          position: [0, -400, 0],
          basis: [cos45, 0, cos45, 0, 1, 0, -cos45, 0, cos45],
        },
        { op: 'add', definitionId: '3070b', color: 25, position: [40, -400, 40] },
      ],
    })
    return result?.structuredContent
  })
  assert(rotatedProbe?.validation, `Rotated probe preflight failed: ${JSON.stringify(rotatedProbe).slice(0, 240)}`)
  assert(
    rotatedProbe.validation.collisions.length === 0 && rotatedProbe.validation.unverifiedCollisions === 0,
    `Triangle confirmation should clear the rotated box overlap, saw ` +
      `${rotatedProbe.validation.collisions.length} collisions ` +
      `(${rotatedProbe.validation.unverifiedCollisions} unverified)`,
  )
  // Discard the probe so it cannot affect the export assertions below.
  await page.locator('.proposal-overlay button').last().click()
  await page.locator('.proposal-overlay').waitFor({ state: 'detached' })

  // -- export round-trips the exact document -------------------------------
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /EXPORT LDR/i }).click()
  const download = await downloadPromise
  const exported = await readFile(await download.path(), 'utf8')
  const type1 = exported.split('\n').filter((line) => line.startsWith('1 ')).length
  assert(type1 === afterUndo.parts, `LDraw export wrote ${type1} type-1 lines for ${afterUndo.parts} parts`)
  assert(/^1 \d+ -?[\d.]+ -?[\d.]+ -?[\d.]+ /m.test(exported), 'Export does not contain well-formed type-1 lines')

  await page.getByRole('button', { name: /VALIDATE/ }).click()
  await page.screenshot({ path: 'artifacts/e2e-final.png', fullPage: true })

  // -- the project survives a reload ---------------------------------------
  // Every committed transaction is appended to IndexedDB, so reopening the page
  // must restore the operator's work rather than the opening showcase.
  const beforeReload = await page.evaluate(() => {
    const model = window.brickwright.getDocument()
    return { revision: model.revision, parts: Object.keys(model.parts).length, name: model.name }
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('canvas').waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean(window.brickwright), null, { timeout: 30_000 })
  const afterReload = await page.evaluate(() => {
    const model = window.brickwright.getDocument()
    return { revision: model.revision, parts: Object.keys(model.parts).length, name: model.name }
  })
  assert(
    afterReload.revision === beforeReload.revision && afterReload.parts === beforeReload.parts,
    `Reload did not restore the project: had r${beforeReload.revision}/${beforeReload.parts} parts, ` +
      `got r${afterReload.revision}/${afterReload.parts}`,
  )
  const saveState = await page.locator('.save-state span').innerText()
  assert(saveState.trim() === 'Saved', `Expected a durable save indicator, saw "${saveState.trim()}"`)
  assert(errors.length === 0, `Browser errors after reload: ${errors.join('; ')}`)
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`)

  console.log(JSON.stringify({
    status: 'passed',
    catalog: initial.workspace.catalog,
    coverage: {
      identities: initial.coverage.coverage.catalogIdentities,
      authoritativeConnections: initial.coverage.coverage.withAuthoritativeConnections,
      connectors: initial.coverage.coverage.connectorTotal,
      compiledMeshes: initial.coverage.coverage.geometryCompiled,
      triangles: initial.coverage.coverage.triangleTotal,
    },
    showcase: {
      revision: startRevision,
      parts: startParts,
      connections: initial.validation.connectionCount,
      collisions: initial.validation.collisions.length,
      unverifiedCollisions: initial.validation.unverifiedCollisions,
    },
    rotatedBoxProbe: 'triangle confirmation cleared the box overlap',
    meshAssetsFetched: geometry.meshes,
    refusedUnplaceableIdentity: unplaceable,
    afterProposal,
    afterAdd,
    afterUndo,
    exportType1Lines: type1,
    reloadRestored: afterReload,
    screenshot: 'artifacts/e2e-final.png',
  }, null, 2))
  await browser.close()
} finally {
  server?.kill('SIGTERM')
}
