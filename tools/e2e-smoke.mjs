#!/usr/bin/env node
/**
 * Browser acceptance run.
 *
 * Drives a real Chromium/WebGL session through the whole vertical slice:
 * compiled catalog load, real LDraw geometry in the viewport, dynamic WebMCP
 * tool surface, agent perception capture, non-mutating preflight, atomic
 * acceptance, manual placement, shared undo, interoperable exports and a
 * self-contained printable build guide.
 *
 * Assertions are relational rather than hardcoded counts, so the run stays
 * meaningful when the showcase model or catalog revision changes.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

  // -- first run explains itself, once ---------------------------------------
  // A dense CAD console that opens with no orientation is a usability defect,
  // and one that reopens every session is a different one. Both are asserted.
  const welcome = page.getByRole('dialog', { name: 'Build something real' })
  await welcome.waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Start building' }).click()
  await welcome.waitFor({ state: 'hidden' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => Boolean(window.brickwright), null, { timeout: 30_000 })
  assert(await welcome.count() === 0, 'The first-run guide reappeared after being dismissed')
  const welcomeReplayable = await page.evaluate(() => Boolean(window.localStorage.getItem('brickwright.welcome.v1')))
  assert(welcomeReplayable, 'Dismissing the first-run guide was not remembered')

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

  // -- the palette shows rendered previews, not decorative glyphs ------------
  const palette = await page.evaluate(async () => {
    const search = await window.brickwright.invoke('catalog_search', { text: 'brick', requireGeometry: true, limit: 12 })
    const inspected = await Promise.all(
      search.structuredContent.results.slice(0, 6).map((record) => window.brickwright.invoke('part_inspect', { id: record.id })),
    )
    const thumbnails = inspected.map((entry) => entry?.structuredContent?.definition?.thumbnail).filter(Boolean)
    // Fetch one to prove the asset the record points at is really served.
    const probe = thumbnails[0] ? await fetch(`/${thumbnails[0].file}`) : null
    return {
      results: search.structuredContent.results.length,
      withThumbnails: thumbnails.length,
      // One asset serves every colour, so distinct parts must have distinct hashes.
      distinctHashes: new Set(thumbnails.map((thumb) => thumb.hash)).size,
      probeOk: probe?.ok ?? false,
      probeType: probe?.headers.get('content-type') ?? null,
      renderedInDom: document.querySelectorAll('.part-thumb img').length,
    }
  })
  assert(palette.withThumbnails === 6, `Expected every placeable result to carry a thumbnail, saw ${palette.withThumbnails}`)
  assert(palette.distinctHashes === 6, `Thumbnails should be per-part, saw ${palette.distinctHashes} distinct hashes`)
  assert(palette.probeOk && /image\/png/.test(palette.probeType ?? ''), `Thumbnail asset not served as PNG: ${palette.probeType}`)
  assert(palette.renderedInDom > 10, `Expected the palette to render thumbnails, saw ${palette.renderedInDom}`)

  // -- the index covers the whole catalogue, and search can reach it --------
  // LDraw models what people build with; the wider catalogue records what
  // exists. Both have to be searchable, and a result has to say which it is,
  // because "we have never heard of that part" and "that part is real and this
  // build cannot place it" are different answers.
  const catalogue = await page.evaluate(async () => {
    const call = async (args) => (await window.brickwright.invoke('catalog_search', args))?.structuredContent
    const build = await call({ text: 'brick 2 x 4', tier: 'placeable', limit: 5 })
    const wide = await call({ text: 'minifig head', tier: 'all', limit: 5 })
    const paged = await call({ text: 'plate', tier: 'all', limit: 5, offset: 5 })
    const pagedAgain = await call({ text: 'plate', tier: 'all', limit: 5, offset: 5 })
    const exact = await call({ text: '3001', tier: 'all', limit: 3 })
    const missing = await call({ text: 'zzzz-not-a-real-part', tier: 'all', limit: 3 })
    return { build, wide, paged, pagedAgain, exact, missing }
  })
  assert(
    catalogue.build.index.totalIdentities > catalogue.build.index.modelledIdentities,
    'The index does not reach past the LDraw-modelled library',
  )
  assert(
    catalogue.build.index.cataloguedIdentities > 40_000,
    `Expected the wider LEGO catalogue in the index, saw ${catalogue.build.index.cataloguedIdentities}`,
  )
  assert(catalogue.exact.results[0]?.id === '3001', 'An exact part number did not rank first')
  assert(catalogue.build.results[0]?.id === '3001', 'A described part did not rank above its variants')
  assert(
    catalogue.build.results.every((entry) => entry.placeable),
    'The placeable tier returned something that cannot be placed',
  )
  assert(
    catalogue.wide.matched.cataloguedTierSearched,
    'Searching every tier did not load the wider catalogue index',
  )
  assert(
    catalogue.wide.matched.byTier.catalogued > 0 && catalogue.wide.matched.byTier.placeable > 0,
    `Expected matches in both tiers, saw ${JSON.stringify(catalogue.wide.matched.byTier)}`,
  )
  assert(
    catalogue.wide.results.some((entry) => entry.tier === 'placeable'),
    'A whole-catalogue search buried every buildable result',
  )
  assert(
    catalogue.paged.matched.total > catalogue.paged.page.returned,
    'Paging reported a total no larger than one page',
  )
  assert(
    JSON.stringify(catalogue.paged.results) === JSON.stringify(catalogue.pagedAgain.results),
    'Two identical paged searches returned different rows, so the ordering is not deterministic',
  )
  assert(catalogue.missing.matched.total === 0, 'A nonsense query matched something')

  // Ranking over eighty thousand identities has to stay inside a keystroke.
  const searchMs = await page.evaluate(async () => {
    const run = async (args) => {
      const started = performance.now()
      for (let attempt = 0; attempt < 5; attempt += 1) await window.brickwright.invoke('catalog_search', args)
      return Math.round((performance.now() - started) / 5)
    }
    return {
      wholeIndex: await run({ tier: 'all', limit: 60 }),
      describedPart: await run({ text: 'brick 2 x 4', tier: 'all', limit: 60 }),
      partNumber: await run({ text: '3001', tier: 'all', limit: 60 }),
    }
  })
  assert(
    searchMs.describedPart < 150,
    `A two-token search over the whole index took ${searchMs.describedPart} ms, which is past a keystroke`,
  )

  // The human sees the same index behind the same facets.
  await page.locator('[data-catalog-search]').fill('minifig head')
  await page.locator('.tier-row button', { hasText: 'EVERYTHING' }).click()
  await page.waitForFunction(() => !document.querySelector('.catalog-loading'), null, { timeout: 60_000 })
  const humanFacets = await page.locator('.tier-row button').allInnerTexts()
  const humanTotal = await page.locator('.catalog-meta span').first().innerText()
  assert(
    /of 8[0-9],\d{3} identities/.test(humanTotal),
    `The catalog panel does not report the whole index, it says "${humanTotal}"`,
  )
  assert(humanFacets.length === 4, `Expected four knowledge tiers in the panel, saw ${humanFacets.length}`)
  const humanRows = await page.locator('.part-card').count()
  assert(humanRows > 0, 'The panel found nothing for a query the agent matched thousands of times')
  await page.locator('.tier-row button', { hasText: 'BUILDABLE' }).click()
  await page.locator('[data-catalog-search]').fill('')
  await page.waitForTimeout(150)

  // -- keyboard command map is a real modal, not decorative chrome ----------
  const shortcutsButton = page.getByRole('button', { name: 'Keyboard shortcuts' })
  const activeToolBeforeModal = await page.locator('.primary-tools .tool-button[aria-pressed="true"]').textContent()
  await shortcutsButton.click()
  const shortcutDialog = page.getByRole('dialog', { name: 'Work at the speed of thought' })
  await shortcutDialog.waitFor()
  await page.keyboard.press('g')
  assert(
    (await page.locator('.primary-tools .tool-button[aria-pressed="true"]').textContent()) === activeToolBeforeModal,
    'A keyboard shortcut mutated the CAD tool while the command map was modal',
  )
  await page.keyboard.press('Escape')
  await shortcutDialog.waitFor({ state: 'hidden' })
  assert(await shortcutsButton.evaluate((node) => document.activeElement === node), 'Closing the command map did not restore focus')
  await page.keyboard.press('?')
  await shortcutDialog.waitFor()
  await page.keyboard.press('?')
  await shortcutDialog.waitFor({ state: 'hidden' })

  // -- the Command Deck is the human face of the WebMCP capability registry -
  const commandButton = page.getByRole('button', { name: 'Command deck' })
  const toolBeforeCommand = await page.locator('.primary-tools .tool-button[aria-pressed="true"]').textContent()
  await commandButton.click()
  const commandDialog = page.getByRole('dialog', { name: 'Command Deck' })
  await commandDialog.waitFor()
  // Parity is the Command Deck's entire claim, so it is checked against the
  // registry the agent actually queries rather than against a literal that has
  // to be remembered whenever a capability is added. `capabilities_search`
  // advertises `parity: { human: true, agent: true }` on every entry; this is
  // what makes that advertisement true rather than decorative.
  const agentMutations = await page.evaluate(async () => {
    const found = await window.brickwright.invoke('capabilities_search', { query: '' })
    return found.structuredContent.filter((entry) => entry.kind === 'mutate').map((entry) => entry.id)
  })
  const deckCommands = await commandDialog.locator('.command-list section > button').count()
  assert(
    deckCommands === agentMutations.length,
    `The human Command Deck exposes ${deckCommands} commands but the agent registry advertises ${agentMutations.length} mutations`,
  )
  assert(
    /HUMAN\s+SAME KERNEL\s+AGENT/.test((await commandDialog.locator('.operator-parity').innerText()).replace(/\s+/g, ' ')),
    'The Command Deck does not communicate its shared-kernel parity boundary',
  )
  assert(
    await commandDialog.getByPlaceholder('Find a command…').evaluate((node) => document.activeElement === node),
    'Opening the Command Deck did not move focus into command search',
  )
  await page.keyboard.press('g')
  assert(
    (await page.locator('.primary-tools .tool-button[aria-pressed="true"]').textContent()) === toolBeforeCommand,
    'A viewport shortcut leaked through the modal Command Deck',
  )
  await commandDialog.getByPlaceholder('Find a command…').fill('project')
  assert(
    (await commandDialog.locator('.command-list section > button').count()) === 1,
    'Command Deck search did not deterministically filter the shared registry',
  )
  await commandDialog.getByPlaceholder('Find a command…').fill('')
  await page.screenshot({ path: 'artifacts/e2e-command-deck.png', fullPage: true })
  await page.keyboard.press('Escape')
  await commandDialog.waitFor({ state: 'hidden' })
  assert(await commandButton.evaluate((node) => document.activeElement === node), 'Closing the Command Deck did not restore focus')

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

  // -- the tool contract is enforced, not merely advertised -----------------
  const contract = await page.evaluate(async () => {
    const workspace = (await window.brickwright.invoke('workspace_get', {}))?.structuredContent
    const model = window.brickwright.getDocument()
    // A malformed batch must be refused by the gateway with a schema error,
    // never coerced and handed to the kernel.
    const malformed = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Malformed batch',
      operations: [{ op: 'demolish', partId: 'nope' }],
    })
    // A sheared basis is a caller bug and is reported as one.
    const sheared = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Sheared basis',
      operations: [{ op: 'add', definitionId: '3005', color: 15, basis: [2, 0, 0, 0, 1, 0, 0, 0, 1] }],
    })
    // A plan pinned to a stale tool profile is refused rather than executed.
    const drifted = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Stale profile',
      expectedToolProfileHash: 'fnv1a:00000000',
      operations: [{ op: 'add', definitionId: '3005', color: 15, position: [0, -600, 0] }],
    })
    return {
      profile: workspace?.toolProfile,
      profileHash: workspace?.profileHash,
      malformed: malformed?.structuredContent?.error,
      sheared: sheared?.structuredContent?.error,
      drifted: drifted?.structuredContent?.error,
    }
  })
  assert(contract.profile === 'brickwright.tools/2', `Expected a versioned tool profile, saw ${contract.profile}`)
  assert(/^fnv1a:[0-9a-f]{8}$/.test(contract.profileHash ?? ''), `Expected a profile hash, saw ${contract.profileHash}`)
  assert(contract.malformed?.code === 'INVALID_INPUT', `Malformed batch was not refused: ${JSON.stringify(contract.malformed)}`)
  assert(contract.sheared?.code === 'INVALID_INPUT', `Sheared basis was not refused: ${JSON.stringify(contract.sheared)}`)
  assert(contract.drifted?.code === 'STALE_TOOL_PROFILE', `Stale profile was not refused: ${JSON.stringify(contract.drifted)}`)
  assert(contract.drifted?.retryable === true, 'A stale profile should be reported as retryable')

  // -- the transform gizmo is actually grabbable ----------------------------
  // It used to render inside the model root, which is scaled to 1/20, so the
  // handles were drawn at a twentieth of their intended size: present in the
  // scene graph, invisible and unhittable on screen. The check measures the
  // drawn handles rather than asserting that a component mounted.
  const canvasBox = await page.locator('canvas').boundingBox()
  const canvasCentre = { x: canvasBox.width / 2, y: canvasBox.height / 2 }
  await page.locator('canvas').click({ position: canvasCentre })
  await page.locator('.inspector-panel .selection-identity').waitFor({ timeout: 5_000 })
  await page.keyboard.press('g')
  await page.waitForFunction(() => Boolean(window.__brickwrightGizmo), null, { timeout: 5_000 })
  const beforePlaceParts = await page.evaluate(() => Object.keys(window.brickwright.getDocument().parts).length)
  const gizmoSize = await page.evaluate(() => window.__brickwrightGizmo())
  assert(gizmoSize.attached, 'The move tool did not attach a transform gizmo to the selection')
  assert(
    gizmoSize.screenPixels > 60,
    `The transform gizmo spans only ${Math.round(gizmoSize.screenPixels)} screen pixels, which is not grabbable`,
  )

  // Grabbing the gizmo must actually move the part, through the same command
  // bus as everything else: one transaction, one revision.
  const beforeDrag = await page.evaluate(() => ({ revision: window.brickwright.getDocument().revision }))
  const handle = { x: canvasBox.x + gizmoSize.centre[0], y: canvasBox.y + gizmoSize.centre[1] }
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x + 70, handle.y - 40, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction(
    (revision) => window.brickwright.getDocument().revision > revision,
    beforeDrag.revision,
    { timeout: 10_000 },
  )
  const afterDrag = await page.evaluate(() => {
    const model = window.brickwright.getDocument()
    return { revision: model.revision, parts: Object.keys(model.parts).length }
  })
  assert(afterDrag.revision === beforeDrag.revision + 1, 'Dragging the gizmo did not commit exactly one transaction')
  assert(afterDrag.parts === beforePlaceParts, 'Dragging the gizmo changed the part count')
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForFunction(
    (revision) => window.brickwright.getDocument().revision > revision,
    afterDrag.revision,
    { timeout: 10_000 },
  )

  await page.keyboard.press('v')

  // -- click-to-place drops a part where the operator is looking ------------
  const beforePlace = await page.evaluate(() => ({
    revision: window.brickwright.getDocument().revision,
    parts: Object.keys(window.brickwright.getDocument().parts).length,
  }))
  await page.locator('.part-card:not(.unplaceable) .part-card-main').first().click()
  await page.locator('.placement-hud').waitFor({ timeout: 5_000 })
  await page.locator('canvas').click({ position: canvasCentre })
  await page.waitForFunction(
    (revision) => window.brickwright.getDocument().revision > revision,
    beforePlace.revision,
    { timeout: 10_000 },
  )
  const afterPlace = await page.evaluate(() => ({
    revision: window.brickwright.getDocument().revision,
    parts: Object.keys(window.brickwright.getDocument().parts).length,
  }))
  assert(afterPlace.parts === beforePlace.parts + 1, 'Clicking in the viewport did not place exactly one part')
  assert(afterPlace.revision === beforePlace.revision + 1, 'Viewport placement did not commit as a single transaction')
  await page.keyboard.press('Escape')
  await page.locator('.placement-hud').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForFunction(
    (parts) => Object.keys(window.brickwright.getDocument().parts).length === parts,
    beforePlace.parts,
    { timeout: 10_000 },
  )

  // -- shift-drag selects a region, and does not pan the camera -------------
  await page.locator('canvas').click({ position: { x: 12, y: 12 } })
  const marqueeBox = await page.locator('canvas').boundingBox()
  await page.keyboard.down('Shift')
  await page.mouse.move(marqueeBox.x + marqueeBox.width * 0.25, marqueeBox.y + marqueeBox.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(marqueeBox.x + marqueeBox.width * 0.5, marqueeBox.y + marqueeBox.height * 0.5, { steps: 8 })
  const marqueeVisible = await page.locator('.marquee-box').count()
  await page.mouse.move(marqueeBox.x + marqueeBox.width * 0.75, marqueeBox.y + marqueeBox.height * 0.72, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  assert(marqueeVisible === 1, 'Shift-dragging did not draw a selection rectangle')
  const marqueeSelected = await page.locator('.viewport-title-block p').innerText()
  assert(
    /\d+ parts selected/.test(marqueeSelected),
    `Box selection did not select a region, viewport reports "${marqueeSelected}"`,
  )
  await page.locator('canvas').click({ position: { x: 12, y: 12 } })

  // -- the build sequence survives an edit ----------------------------------
  // The bottom band used to swap the sequence out for history the moment
  // anything was edited, so the steps vanished exactly when a builder needed
  // them. They are now separate views, and STEPS is reachable at any time.
  await page.locator('.timeline-switch button', { hasText: 'STEPS' }).click()
  const stepCards = await page.locator('.step-card').count()
  assert(
    stepCards === (await page.evaluate(() => window.brickwright.getDocument().steps.length)),
    `The build sequence shows ${stepCards} steps but the document has more`,
  )

  // -- manual placement uses the same bus, and undo stays monotonic ---------
  const beforeAdd = await page.evaluate(() => ({ revision: window.brickwright.getDocument().revision, parts: Object.keys(window.brickwright.getDocument().parts).length }))
  await page.locator('.part-card').first().locator('.part-add').click()
  await page.waitForFunction((revision) => window.brickwright.getDocument().revision > revision, beforeAdd.revision, { timeout: 10_000 })
  const afterAdd = await page.evaluate(() => ({ revision: window.brickwright.getDocument().revision, parts: Object.keys(window.brickwright.getDocument().parts).length }))
  assert(afterAdd.revision === beforeAdd.revision + 1 && afterAdd.parts === beforeAdd.parts + 1, 'Manual catalog placement did not use the shared command bus')

  await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForFunction((revision) => window.brickwright.getDocument().revision > revision, afterAdd.revision, { timeout: 10_000 })
  const afterUndo = await page.evaluate(() => ({ revision: window.brickwright.getDocument().revision, parts: Object.keys(window.brickwright.getDocument().parts).length }))
  assert(afterUndo.revision === afterAdd.revision + 1, 'Undo did not advance the revision monotonically')
  assert(afterUndo.parts === beforeAdd.parts, 'Undo did not restore the previous part set')

  // -- stale agent writes are rejected by the kernel ------------------------
  const stale = await page.evaluate(() => window.brickwright.invoke('build_preflight', {
    expectedRevision: 1,
    label: 'Stale plan',
    operations: [{ op: 'add', definitionId: '3005', color: 4, position: [0, -400, 0] }],
  }))
  assert(stale.structuredContent?.error?.code === 'STALE_DOCUMENT', `Expected STALE_DOCUMENT, saw ${JSON.stringify(stale.structuredContent).slice(0, 160)}`)

  // -- one named capability is operated by human and agent alike ------------
  // The human invokes it from the Command Deck; WebMCP discovers and invokes
  // the same registry id. Both land in the same monotonic transaction history,
  // and shared undo restores the exact prior document name.
  const beforeParity = await page.evaluate(() => ({
    revision: window.brickwright.getDocument().revision,
    name: window.brickwright.getDocument().name,
  }))
  await commandButton.click()
  await commandDialog.getByRole('button', { name: /Rename project/ }).click()
  await commandDialog.getByLabel('Project name').fill('Human + Agent Survey Rover')
  await commandDialog.getByRole('button', { name: 'RUN COMMAND' }).click()
  await page.waitForFunction(
    (revision) => window.brickwright.getDocument().revision === revision + 1,
    beforeParity.revision,
  )
  const humanParity = await page.evaluate(() => ({
    revision: window.brickwright.getDocument().revision,
    name: window.brickwright.getDocument().name,
  }))
  assert(humanParity.name === 'Human + Agent Survey Rover', 'The human Command Deck did not commit its shared capability')
  await page.keyboard.press('Escape')
  await commandDialog.waitFor({ state: 'hidden' })

  await page.locator('.autonomy-switch').getByRole('button', { name: 'build' }).click()
  const agentParity = await page.evaluate(async () => {
    const model = window.brickwright.getDocument()
    const help = await window.brickwright.invoke('capabilities_help', { capability: 'rename_document' })
    const result = await window.brickwright.invoke('action_mutate', {
      action: 'rename_document',
      expectedRevision: model.revision,
      args: { name: 'Agent + Human Survey Rover' },
    })
    return { help: help?.structuredContent, result: result?.structuredContent, name: window.brickwright.getDocument().name }
  })
  assert(agentParity.help?.call === 'action_mutate', 'WebMCP help did not route the shared capability through action_mutate')
  assert(agentParity.result?.author === 'agent', `Agent capability lost provenance: ${JSON.stringify(agentParity.result).slice(0, 200)}`)
  assert(agentParity.result?.sourceTool === 'action_mutate', 'Agent capability did not retain its source tool')
  assert(agentParity.result?.capability === 'rename_document', 'Agent result did not name the shared capability')
  assert(agentParity.name === 'Agent + Human Survey Rover', 'The agent did not commit the shared capability')

  const parityUndo = await page.evaluate(async () => {
    await window.brickwright.invoke('undo_edit', {})
    await window.brickwright.invoke('undo_edit', {})
    const model = window.brickwright.getDocument()
    return { name: model.name, revision: model.revision }
  })
  assert(parityUndo.name === beforeParity.name, 'Shared undo did not restore the pre-parity project name')
  assert(parityUndo.revision === beforeParity.revision + 4, 'Human/agent edits and their undos did not remain monotonic')
  await page.locator('.autonomy-switch').getByRole('button', { name: 'propose' }).click()

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

  // The delivery menu exposes the richer outputs without taking the direct LDR
  // action away from the toolbar.
  await page.getByRole('button', { name: 'More export options' }).click()
  const mpdPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /Assembly MPD/i }).click()
  const mpd = await readFile(await (await mpdPromise).path(), 'utf8')
  assert((mpd.match(/^0 FILE /gm) ?? []).length > 1, 'MPD export did not preserve subassembly file blocks')

  const guidePromise = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByRole('button', { name: /Printable build guide/i }).click()
  const guide = await readFile(await (await guidePromise).path(), 'utf8')
  const guideSteps = (guide.match(/<section class="page step">/g) ?? []).length
  const guideImages = (guide.match(/data:image\/png/g) ?? []).length
  const expectedGuideSteps = await page.evaluate(
    () => window.brickwright.getDocument().steps.filter((step) => step.partIds.length).length,
  )
  assert(guideSteps === expectedGuideSteps, `Build guide rendered ${guideSteps} steps for a ${expectedGuideSteps}-step document`)
  assert(guideImages > guideSteps, 'Build guide did not embed both assembly renders and part thumbnails')
  assert(!/<(?:script|link)[^>]+https?:/i.test(guide), 'Build guide depends on a remote script or stylesheet')
  assert(guide.includes('every part after the first step attaches'), 'Build guide omitted the build-order verification claim')
  await page.locator('.export-panel > header').getByRole('button', { name: 'Close deliverables' }).click()

  await page.getByRole('button', { name: /VALIDATE/ }).click()
  await page.screenshot({ path: 'artifacts/e2e-final.png', fullPage: true })

  // -- the build sequence is derived and verified, not authored -------------
  const sequence = await page.evaluate(async () => {
    const derived = (await window.brickwright.invoke('action_read', { action: 'compute_build_order' }))?.structuredContent
    return {
      steps: derived?.steps?.length,
      verified: derived?.verified,
      warnings: derived?.warnings?.map((warning) => warning.code) ?? [],
      totalParts: derived?.steps?.reduce((sum, step) => sum + step.partIds.length, 0),
      documentParts: Object.keys(window.brickwright.getDocument().parts).length,
    }
  })
  assert(sequence.verified === true, 'The derived build order failed its own reachability check')
  assert(sequence.steps > 2, `Expected a multi-step sequence, saw ${sequence.steps}`)
  assert(
    sequence.totalParts === sequence.documentParts,
    `Sequence covers ${sequence.totalParts} of ${sequence.documentParts} parts`,
  )
  assert(!sequence.warnings.includes('UNCONNECTED_PART'), 'The showcase should have no unconnected parts')

  // -- the model contains a real mechanism, and it can be driven ------------
  // The showcase carries a hinged rear hatch, so articulation is exercised on a
  // real assembly rather than a synthetic fixture.
  const articulation = await page.evaluate(async () => {
    const hatch = Object.values(window.brickwright.getDocument().parts).find((part) => part.definitionId === '3938')
    if (!hatch) return { error: 'showcase has no hinge top plate' }
    const joints = (await window.brickwright.invoke('action_read', { action: 'list_joints', args: { partIds: [hatch.id] } }))
      ?.structuredContent
    return { hatchId: hatch.id, joints }
  })
  assert(!articulation.error, `Articulation probe failed: ${articulation.error}`)
  assert(articulation.joints?.joints?.length === 1, `Expected one drivable joint, saw ${JSON.stringify(articulation.joints?.joints)}`)
  assert(articulation.joints.joints[0].family === 'hinge', 'Expected the drivable joint to be the hinge')

  await page.locator('.autonomy-switch').getByRole('button', { name: 'build' }).click()

  const driven = await page.evaluate(async (hatchId) => {
    const model = window.brickwright.getDocument()
    const before = model.parts[hatchId].transform.basis.join(',')
    const result = await window.brickwright.invoke('action_mutate', {
      action: 'articulate_joint',
      expectedRevision: model.revision,
      args: { partIds: [hatchId], edgeId: (await window.brickwright.invoke('action_read', { action: 'list_joints', args: { partIds: [hatchId] } })).structuredContent.joints[0].edgeId, rotateDegrees: 35 },
    })
    const after = window.brickwright.getDocument()
    return {
      committed: Boolean(result?.structuredContent?.resultRevision),
      error: result?.structuredContent?.error,
      changed: after.parts[hatchId].transform.basis.join(',') !== before,
      anchorUnchanged: Object.values(after.parts).some((part) => part.definitionId === '3937'),
    }
  }, articulation.hatchId)
  assert(driven.committed, `Driving the hinge failed: ${JSON.stringify(driven.error)}`)
  assert(driven.changed, 'Driving the hinge did not rotate the hatch')
  await page.evaluate(() => window.brickwright.invoke('undo_edit', {}))

  // -- hard constraints are kernel-enforced, and liftable -------------------
  // The showcase declares a 320-part budget and a 10 x 14 stud envelope, which
  // is exactly what the 400-part render probe below breaks. That makes this the
  // honest place to prove both halves of the gate in a real browser: the kernel
  // refuses the commit, and the escape hatch the refusal message points at
  // actually releases it.
  const constraintGate = await page.evaluate(async () => {
    // 400 LDU is 20 studs out, so it breaks the envelope while staying close
    // enough that the camera refit does not disturb the render sampling below.
    const commitOutsideEnvelope = async () => {
      const model = window.brickwright.getDocument()
      const preflight = await window.brickwright.invoke('build_preflight', {
        expectedRevision: model.revision,
        label: 'Outside the envelope',
        operations: [{ op: 'add', definitionId: '3024', color: 15, position: [400, 0, 0] }],
      })
      const proposalId = preflight?.structuredContent?.id
      if (!proposalId) return { code: preflight?.structuredContent?.error?.code ?? 'NO_PROPOSAL' }
      const applied = await window.brickwright.invoke('build_apply', { proposalId })
      return { code: applied?.structuredContent?.error?.code, revision: applied?.structuredContent?.resultRevision }
    }

    const refused = await commitOutsideEnvelope()
    const lifted = []
    for (const constraint of window.brickwright.getDocument().constraints) {
      const result = await window.brickwright.invoke('action_mutate', {
        action: 'remove_constraint',
        expectedRevision: window.brickwright.getDocument().revision,
        args: { constraintId: constraint.id },
      })
      lifted.push(result?.structuredContent?.error?.code ?? 'ok')
    }
    const released = await commitOutsideEnvelope()
    // Put the document back, so the render probe measures the same model the
    // rest of the run has been describing.
    if (released.revision) await window.brickwright.invoke('undo_edit', {})
    return { refused, lifted, released, remaining: window.brickwright.getDocument().constraints.length }
  })
  assert(
    constraintGate.refused.code === 'CONSTRAINT_VIOLATION',
    `A commit outside the hard envelope was not refused: ${JSON.stringify(constraintGate.refused)}`,
  )
  assert(
    constraintGate.lifted.every((entry) => entry === 'ok') && constraintGate.remaining === 0,
    `Removing the design constraints failed: ${JSON.stringify(constraintGate.lifted)}`,
  )
  assert(
    Number.isInteger(constraintGate.released.revision),
    `The commit was still refused after its constraint was lifted: ${JSON.stringify(constraintGate.released)}`,
  )

  // -- an agent builds a storey in one call, not one brick at a time --------
  // Authoring a large model per-part is slow and it is where quality is lost:
  // a wall placed brick-by-brick by a language model has stacked seams and
  // unbonded courses. The generators do the bricklaying and the kernel checks
  // the result, so what is asserted here is the *quality* of what came back.
  await page.locator('.autonomy-switch').getByRole('button', { name: 'build' }).click()
  const generated = await page.evaluate(async () => {
    const mutate = async (action, args) => {
      const r = await window.brickwright.invoke('action_mutate', {
        action,
        expectedRevision: window.brickwright.getDocument().revision,
        args,
      })
      return r?.structuredContent
    }
    const before = Object.keys(window.brickwright.getDocument().parts).length
    const beforeRevision = window.brickwright.getDocument().revision
    const storey = await mutate('build_enclosure', {
      widthStuds: 16,
      depthStuds: 12,
      courses: 4,
      floor: true,
      color: 4,
      originLdu: [600, 0, 600],
      openings: [{ atStud: 6, widthStuds: 4, fromCourse: 0, toCourse: 2 }],
    })
    const stacked = await mutate('stack_selection', { copies: 2 })
    const validation = (await window.brickwright.invoke('validate_model', {}))?.structuredContent
    return {
      before,
      beforeRevision,
      storey,
      stacked,
      after: Object.keys(window.brickwright.getDocument().parts).length,
      afterRevision: window.brickwright.getDocument().revision,
      collisions: validation.collisions.length,
      unverified: validation.unverifiedCollisions,
    }
  })
  assert(!generated.storey?.error, `Generating a storey failed: ${JSON.stringify(generated.storey?.error)}`)
  assert(!generated.stacked?.error, `Stacking storeys failed: ${JSON.stringify(generated.stacked?.error)}`)
  assert(
    generated.storey.report.parts > 60,
    `One call produced only ${generated.storey.report.parts} parts, which is not a storey`,
  )
  assert(generated.storey.report.runningBond === true, 'The generated storey is not in running bond')
  assert(
    generated.storey.report.unbondedCourses === 0 && generated.storey.report.warnings.length === 0,
    `The generator reported problems it did not fix: ${JSON.stringify(generated.storey.report.warnings)}`,
  )
  assert(
    generated.storey.report.bill.reduce((sum, entry) => sum + entry.count, 0) === generated.storey.report.parts,
    'The reported bill does not account for every part placed',
  )
  assert(
    generated.afterRevision === generated.beforeRevision + 2,
    `Two generator calls produced ${generated.afterRevision - generated.beforeRevision} transactions, not two`,
  )
  assert(
    generated.after - generated.before === generated.storey.report.parts * 3,
    `A storey plus two stacked copies added ${generated.after - generated.before} parts, not three storeys' worth`,
  )
  assert(
    generated.stacked.report.pitchLdu === generated.storey.report.courses * 24 + 8 * (generated.storey.report.floorLayers ?? 2),
    `The stack pitch of ${generated.stacked.report.pitchLdu} LDU does not match the storey it measured`,
  )
  assert(generated.collisions === 0, `The generated building collides with itself in ${generated.collisions} places`)
  assert(generated.unverified === 0, 'The generated building has collision verdicts reached from bounding boxes alone')

  // -- a whole building, and a module reused across the block ---------------
  // The composition layer is the one that makes a large model reachable at all:
  // storeys, windows, banding and a roof from one instruction, then the whole
  // thing captured and stamped rather than authored again.
  const block = await page.evaluate(async () => {
    const mutate = async (action, args) => {
      const r = await window.brickwright.invoke('action_mutate', {
        action,
        expectedRevision: window.brickwright.getDocument().revision,
        args,
      })
      return r?.structuredContent
    }
    const before = Object.keys(window.brickwright.getDocument().parts).length
    const raised = await mutate('build_structure', {
      widthStuds: 16,
      depthStuds: 14,
      storeys: 3,
      coursesPerStorey: 6,
      color: 4,
      bandColor: 15,
      windowsPerSide: 2,
      door: true,
      originLdu: [1600, 0, 1600],
    })
    const captured = await mutate('capture_module', { name: 'Corner block' })
    const stamped = await mutate('stamp_module', { module: 'Corner block', atLdu: [2000, 0, 1600], copies: 1, color: 14 })
    const validation = (await window.brickwright.invoke('validate_model', {}))?.structuredContent
    return {
      before,
      raised,
      captured,
      stamped,
      modules: (window.brickwright.getDocument().modules ?? []).map((entry) => entry.name),
      after: Object.keys(window.brickwright.getDocument().parts).length,
      collisions: validation.collisions.length,
      unverified: validation.unverifiedCollisions,
    }
  })
  assert(!block.raised?.error, `Raising a building failed: ${JSON.stringify(block.raised?.error)}`)
  assert(!block.captured?.error, `Capturing a module failed: ${JSON.stringify(block.captured?.error)}`)
  assert(!block.stamped?.error, `Stamping a module failed: ${JSON.stringify(block.stamped?.error)}`)
  assert(block.raised.report.parts > 200, `One instruction produced only ${block.raised.report.parts} parts`)
  assert(block.raised.report.runningBond === true, 'The generated building is not in running bond')
  assert(
    block.raised.report.windows > 3 && block.raised.report.doors === 1,
    `Expected windows and a door seated in the facade, saw ${JSON.stringify({ windows: block.raised.report.windows, doors: block.raised.report.doors })}`,
  )
  assert(block.raised.report.warnings.length === 0, `The building reported problems: ${JSON.stringify(block.raised.report.warnings)}`)
  assert(block.modules.includes('Corner block'), 'The captured module is not in the document')
  assert(
    block.stamped.report.parts === block.raised.report.parts,
    `A stamp placed ${block.stamped.report.parts} parts from a ${block.raised.report.parts}-part module`,
  )
  assert(
    block.after === block.before + block.raised.report.parts * 2,
    `The building and its stamp added ${block.after - block.before} parts, not two buildings' worth`,
  )
  assert(block.collisions === 0 && block.unverified === 0, `The stamped block collides in ${block.collisions} places`)

  // A large generated model still sequences into a verified instruction set.
  const generatedOrder = await page.evaluate(async () => {
    const started = performance.now()
    const derived = (await window.brickwright.invoke('action_read', { action: 'compute_build_order' }))?.structuredContent
    return { ms: Math.round(performance.now() - started), steps: derived?.steps?.length, verified: derived?.verified, warnings: derived?.warnings?.length ?? 0 }
  })
  assert(generatedOrder.verified === true, 'The generated building failed its own build-order reachability check')
  assert(generatedOrder.steps > 5, `A ${generated.after}-part model sequenced into only ${generatedOrder.steps} steps`)

  // Undo has to reverse a generated assembly as one move, like any other edit —
  // a building of three hundred parts is still one transaction.
  for (let step = 0; step < 5; step += 1) await page.getByRole('button', { name: 'Undo' }).click()
  await page.waitForFunction(
    (parts) => Object.keys(window.brickwright.getDocument().parts).length === parts,
    generated.before,
    { timeout: 20_000 },
  )

  // -- rendering cost tracks part/colour combinations, not brick count ------
  // A 400-part agent batch is committed far from the model, then the renderer's
  // own counters are read. Instanced batching means the draw calls should barely
  // move, because the batch introduces only a couple of new part/colour groups.
  const renderScale = await page.evaluate(async () => {
    // Each sample resets the counters, so this measures exactly the frames
    // between the two calls.
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    const sample = async () => {
      window.__brickwrightRenderStats?.()
      await frame()
      await frame()
      return window.__brickwrightRenderStats?.()
    }
    const before = await sample()

    const model = window.brickwright.getDocument()
    const operations = []
    for (let index = 0; index < 400; index += 1) {
      operations.push({
        op: 'add',
        definitionId: index % 2 === 0 ? '3024' : '3005',
        color: index % 2 === 0 ? 15 : 4,
        // Kept close to the model so the camera refit leaves it on screen and
        // the counters describe geometry that is genuinely being drawn.
        position: [(index % 20) * 20 - 200, -120 - Math.floor(index / 20) * 8, Math.floor(index / 20) * 20 - 200],
      })
    }
    const preflight = await window.brickwright.invoke('build_preflight', {
      expectedRevision: model.revision,
      label: 'Render scale batch',
      operations,
    })
    const proposalId = preflight?.structuredContent?.id
    if (!proposalId) return { error: JSON.stringify(preflight?.structuredContent).slice(0, 240) }
    const applied = await window.brickwright.invoke('build_apply', { proposalId })
    if (!applied?.structuredContent?.resultRevision) {
      return { error: JSON.stringify(applied?.structuredContent).slice(0, 240) }
    }
    // Let the camera rig settle on the new bounds before sampling.
    await frame()
    await frame()
    await frame()
    const after = await sample()
    return { before, after, parts: Object.keys(window.brickwright.getDocument().parts).length }
  })
  assert(!renderScale.error, `Render-scale batch failed: ${renderScale.error}`)
  assert(renderScale.parts > 400, `Expected the batch to commit, saw ${renderScale.parts} parts`)
  // Measured +14 for 400 parts. Without instancing and merged edges this was
  // +810, so a ceiling of 40 catches a regression on either without being
  // sensitive to shadow-pass or overlay changes.
  assert(
    renderScale.after.drawCalls - renderScale.before.drawCalls < 40,
    `400 extra parts added ${renderScale.after.drawCalls - renderScale.before.drawCalls} draw calls; ` +
      `instancing and merged edges should keep this near-flat`,
  )
  // The counters must describe geometry that is actually drawn, otherwise a
  // culled frame would make any instancing claim look good.
  assert(
    renderScale.after.triangles > renderScale.before.triangles,
    `Expected the batch to add rendered triangles, went ${renderScale.before.triangles} -> ${renderScale.after.triangles}`,
  )
  assert(
    renderScale.after.triangles > 20_000,
    `Expected a substantial rendered triangle count, saw ${renderScale.after.triangles}`,
  )
  // Undo the stress batch so the reload check sees the real project.
  await page.evaluate(() => window.brickwright.invoke('undo_edit', {}))
  await page.locator('.autonomy-switch').getByRole('button', { name: 'propose' }).click()

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

  // -- projects, checkpoints and attribution -------------------------------
  // Driven entirely through the DOM: the persistence layer supported multiple
  // projects long before an operator could reach one, so the acceptance is that
  // the switcher works, not that the repository does.
  await page.locator('.project-menu .project-identity').click()
  const restoreHeadline = (await page.locator('.restore-report strong').innerText()).trim()
  assert(
    /Restored from a checkpoint/.test(restoreHeadline),
    `Expected the reopened project to report a restore, saw "${restoreHeadline}"`,
  )

  const beforeFork = await page.evaluate(() => {
    const model = window.brickwright.getDocument()
    return { id: model.id, name: model.name, revision: model.revision, parts: Object.keys(model.parts).length }
  })
  await page.getByLabel('New or forked project name').fill('E2E fork')
  const forkStarted = Date.now()
  await page.locator('.project-panel').getByRole('button', { name: 'Fork' }).click()
  // A fork checkpoints the outgoing project and writes a copy, so it is bounded
  // by IndexedDB rather than by rendering. The budget is generous because a
  // shared CI runner is roughly an order of magnitude slower than a laptop, and
  // the duration is reported below so a real regression is visible as a number
  // rather than as a timeout.
  await page.waitForFunction(() => window.brickwright.getDocument().name === 'E2E fork', null, { timeout: 90_000 })
  const forkMs = Date.now() - forkStarted

  // A fork must copy the work, not merely rename the pointer to it.
  const forked = await page.evaluate(() => {
    const model = window.brickwright.getDocument()
    return { id: model.id, name: model.name, parts: Object.keys(model.parts).length }
  })
  assert(forked.id !== beforeFork.id, 'The fork reused the original project id')
  assert(
    forked.parts === beforeFork.parts,
    `The fork lost geometry: original had ${beforeFork.parts} parts, fork has ${forked.parts}`,
  )

  // The row list refreshes after the fork's checkpoint is written, which is
  // later than the document swap — so wait on the list, not on the name.
  await page.waitForFunction(() => document.querySelectorAll('.project-list li').length >= 2, null, { timeout: 15_000 })
  const projectRows = await page.locator('.project-list li').count()
  const projectRowText = await page.locator('.project-list li').allInnerTexts()
  assert(
    projectRowText.some((row) => row.includes('E2E fork')) && projectRowText.some((row) => row.includes(beforeFork.name)),
    `Expected both projects in the switcher, saw ${JSON.stringify(projectRowText)}`,
  )

  // Switch back and confirm the original is intact and reopened at its own
  // revision — the fork's transactions must not have landed in its log.
  await page.locator(`.project-open:not(:disabled)`).first().click()
  await page.waitForFunction((id) => window.brickwright.getDocument().id === id, beforeFork.id, { timeout: 15_000 })
  const restored = await page.evaluate(() => {
    const model = window.brickwright.getDocument()
    return { id: model.id, revision: model.revision, parts: Object.keys(model.parts).length }
  })
  assert(
    restored.revision === beforeFork.revision && restored.parts === beforeFork.parts,
    `Switching back changed the original: r${beforeFork.revision}/${beforeFork.parts} -> r${restored.revision}/${restored.parts}`,
  )

  // Attribution has to be reachable from the running app, not just present in a
  // build artefact, and the review-required flags have to be visible.
  await page.locator('.project-actions button', { hasText: 'Data' }).click()
  await page.locator('.legal-list li').first().waitFor({ timeout: 15_000 })
  const attribution = await page.evaluate(() => ({
    datasets: document.querySelectorAll('.legal-list li').length,
    reviewFlags: document.querySelectorAll('.legal-review').length,
    mentionsLdraw: document.querySelector('.legal-list')?.textContent?.includes('LDraw') ?? false,
    trademark: (document.querySelector('.legal-trademark')?.textContent ?? '').includes('LEGO'),
  }))
  assert(attribution.datasets >= 3, `Expected every compiled dataset to be listed, saw ${attribution.datasets}`)
  assert(attribution.mentionsLdraw, 'The attribution panel does not credit the LDraw Parts Library')
  assert(attribution.reviewFlags >= 2, `Expected the licence review flags to be shown, saw ${attribution.reviewFlags}`)
  assert(attribution.trademark, 'The trademark disclaimer is missing from the attribution panel')
  await page.keyboard.press('Escape')

  // -- an exported model imports back as the same build ---------------------
  // Interoperability is only real if the round trip closes. This is the last
  // check in the run because it replaces the open document.
  const roundTripPath = 'artifacts/e2e-roundtrip.ldr'
  await writeFile(roundTripPath, exported, 'utf8')
  await page.getByRole('button', { name: 'More export options' }).click()
  await page.locator('.export-panel input[type=file]').setInputFiles(roundTripPath)
  await page.waitForFunction(
    (parts) => Object.keys(window.brickwright.getDocument().parts).length === parts,
    type1,
    { timeout: 30_000 },
  )
  const imported = await page.evaluate(() => {
    const model = window.brickwright.getDocument()
    return {
      parts: Object.keys(model.parts).length,
      placeable: Object.values(model.parts).every((part) => Boolean(part.definitionId)),
      connections: Object.keys(model.connections).length,
    }
  })
  assert(
    imported.parts === type1,
    `Re-importing the export produced ${imported.parts} parts from ${type1} type-1 lines`,
  )
  assert(imported.placeable, 'An imported part lost its catalog identity')
  assert(imported.connections > 0, 'The imported model derived no connection graph')

  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`)

  console.log(JSON.stringify({
    status: 'passed',
    catalog: initial.workspace.catalog,
    index: {
      ...catalogue.build.index,
      exactNumberRanksFirst: catalogue.exact.results[0]?.id,
      wholeCatalogueMatches: catalogue.wide.matched,
      pagingDeterministic: true,
      searchMs,
      panelFacets: humanFacets.length,
      panelTotal: humanTotal,
    },
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
    palette: {
      thumbnailsOnResults: palette.withThumbnails,
      distinctThumbnailHashes: palette.distinctHashes,
      renderedInDom: palette.renderedInDom,
    },
    interface: {
      modalShortcutsBlocked: true,
      focusRestored: true,
      firstRunGuideShownOnceOnly: true,
      gizmoScreenPixels: Math.round(gizmoSize.screenPixels),
      gizmoDragCommitted: afterDrag.revision === beforeDrag.revision + 1,
      viewportPlacement: { parts: afterPlace.parts, revision: afterPlace.revision },
      buildStepsVisibleAfterEdit: stepCards,
      boxSelection: marqueeSelected,
      commandDeckCapabilities: 13,
      commandDeckScreenshot: 'artifacts/e2e-command-deck.png',
      sharedCapabilityParity: {
        humanRevision: humanParity.revision,
        agentRevision: agentParity.result?.resultRevision,
        restoredRevision: parityUndo.revision,
      },
    },
    generation: {
      storeyParts: generated.storey.report.parts,
      storeyCourses: generated.storey.report.courses,
      runningBond: generated.storey.report.runningBond,
      stackedParts: generated.stacked.report.parts,
      stackPitchLdu: generated.stacked.report.pitchLdu,
      partsFromTwoCalls: generated.after - generated.before,
      transactions: generated.afterRevision - generated.beforeRevision,
      collisions: generated.collisions,
      sequencedSteps: generatedOrder.steps,
      sequenceVerified: generatedOrder.verified,
      sequenceMs: generatedOrder.ms,
      buildingParts: block.raised.report.parts,
      buildingWindows: block.raised.report.windows,
      buildingDoors: block.raised.report.doors,
      moduleStampedParts: block.stamped.report.parts,
      blockCollisions: block.collisions,
    },
    refusedUnplaceableIdentity: unplaceable,
    buildOrder: {
      steps: sequence.steps,
      verified: sequence.verified,
      partsCovered: sequence.totalParts,
      warnings: sequence.warnings,
    },
    articulation: {
      drivableJoints: articulation.joints?.joints?.length,
      family: articulation.joints?.joints?.[0]?.family,
      freedom: articulation.joints?.joints?.[0]?.freedom?.kind,
      drivenByAgent: driven.committed,
    },
    contractEnforcement: {
      profile: contract.profile,
      malformedBatch: contract.malformed?.code,
      shearedBasis: contract.sheared?.code,
      staleProfile: contract.drifted?.code,
    },
    afterProposal,
    afterAdd,
    afterUndo,
    exportType1Lines: type1,
    importRoundTrip: { parts: imported.parts, connections: imported.connections },
    delivery: {
      mpdFileBlocks: (mpd.match(/^0 FILE /gm) ?? []).length,
      guideSteps,
      guideImages,
      guideBytes: Buffer.byteLength(guide),
    },
    constraintGate: {
      refusedOutsideEnvelope: constraintGate.refused.code,
      constraintsLifted: constraintGate.lifted.length,
      committedOnceLifted: Number.isInteger(constraintGate.released.revision),
    },
    renderScale: {
      partsAfterBatch: renderScale.parts,
      drawCallsBefore: renderScale.before.drawCalls,
      drawCallsAfter: renderScale.after.drawCalls,
      drawCallsAddedBy400Parts: renderScale.after.drawCalls - renderScale.before.drawCalls,
      trianglesAfter: renderScale.after.triangles,
    },
    reloadRestored: afterReload,
    projects: {
      restoreHeadline,
      forkMs,
      forkedProjectId: forked.id,
      forkedParts: forked.parts,
      projectsListed: projectRows,
      switchedBackTo: restored.id,
      attributionDatasets: attribution.datasets,
      licenceReviewFlags: attribution.reviewFlags,
    },
    screenshot: 'artifacts/e2e-final.png',
  }, null, 2))
  await browser.close()
} finally {
  server?.kill('SIGTERM')
}
