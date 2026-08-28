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
/**
 * The editor is one surface among several the platform shell routes to, so the
 * acceptance run navigates to it explicitly rather than assuming it owns `/`.
 */
const editorUrl = `${url.replace(/\/+$/, '')}/editor`
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
  // Visual-regression states land here, one file per major workspace state.
  await mkdir('artifacts/workbench', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
  const errors = []
  const requests = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (cause) => errors.push(cause.message))
  page.on('request', (request) => requests.push(request.url()))

  // -- the installed platform surfaces route as one application -------------
  // Root used to be an honest "not installed" state even though a complete
  // landing surface existed in the tree, and its hash links changed the URL
  // without changing React Router's route. Drive the shipped entry point before
  // the editor so that wiring failures cannot hide behind isolated unit tests.
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('.bw-landing').waitFor({ timeout: 15_000 })
  assert(await page.locator('main').count() === 1, 'The framed landing page nests or duplicates the document main landmark')
  const landingCatalogRequests = requests.filter((entry) => /\/catalog\/(?:latest|manifest|parts|colors)/.test(entry))
  assert(
    landingCatalogRequests.length === 0,
    `The boot:none landing route fetched catalog data: ${landingCatalogRequests.slice(0, 3).join(', ')}`,
  )
  await page.locator('a.bw-demo-card').first().click()
  await page.locator('.bw-explore').waitFor({ timeout: 30_000 })
  assert(new URL(page.url()).pathname === '/explore', `A demo link did not route through the platform shell: ${page.url()}`)
  assert(new URL(page.url()).searchParams.has('demo'), `A demo link lost its selected demo: ${page.url()}`)
  await page.locator('.bw-explore canvas').waitFor({ timeout: 30_000 })
  assert(await page.locator('.bw-explore [role="alert"]').count() === 0, 'The demo explorer failed to load its verified preview')
  await page.locator('#bw-step').fill('1')
  await page.waitForFunction(() => new URL(window.location.href).searchParams.get('step') === '1')

  await page.goto(editorUrl, { waitUntil: 'networkidle' })
  // The catalog must load before the editor mounts at all.
  await page.locator('canvas').waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean(window.brickwright), null, { timeout: 30_000 })
  assert(await page.locator('.bw-agent[aria-label="Design partner"]').count() === 1, 'The design partner contribution is not mounted in the editor')

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

  // -- benchmark workflows --------------------------------------------------
  // The moves a builder actually makes: find a part and place it, position it
  // numerically, mate it through Connect, recolour, clone, array, isolate, and
  // undo all of it. Every one is asserted through the kernel — part counts,
  // revisions, stored transforms and the connection graph — not by checking
  // that a button looked pressed.
  const workflow = {}
  const lastPartId = () => page.evaluate(() => Object.keys(window.brickwright.getDocument().parts).at(-1))
  const modelState = () => page.evaluate(() => ({
    revision: window.brickwright.getDocument().revision,
    parts: Object.keys(window.brickwright.getDocument().parts).length,
  }))

  // find -> place, from the keyboard alone.
  await page.locator('[data-catalog-search]').fill('3005')
  await page.waitForFunction(() => document.querySelectorAll('.part-card').length > 0, null, { timeout: 10_000 })
  const beforeFind = await modelState()
  await page.locator('[data-catalog-search]').press('ArrowDown')
  await page.locator('[data-catalog-search]').press('Enter')
  await page.locator('.placement-hud').waitFor({ timeout: 5_000 })
  assert(
    (await page.locator('.placement-hud strong').innerText()).trim().length > 0,
    'Arming a part from the keyboard did not name it in the placement HUD',
  )
  await page.locator('canvas').click({ position: canvasCentre })
  await page.waitForFunction((parts) => Object.keys(window.brickwright.getDocument().parts).length > parts, beforeFind.parts, { timeout: 10_000 })
  const afterFind = await modelState()
  assert(afterFind.parts === beforeFind.parts + 1, 'Keyboard find-then-place did not add exactly one part')
  assert(afterFind.revision === beforeFind.revision + 1, 'Keyboard placement was not a single transaction')
  await page.keyboard.press('Escape')
  await page.locator('.placement-hud').waitFor({ state: 'hidden' })
  await page.locator('[data-catalog-search]').fill('')
  const subjectId = await lastPartId()
  workflow.findAndPlace = { parts: afterFind.parts, placedId: subjectId }

  // numeric transform: an exact coordinate, committed through the same bus, and
  // shown back in the field exactly as it was stored.
  const numericX = page.locator('.dock-right').getByLabel('X in LDraw units')
  const numericY = page.locator('.dock-right').getByLabel('Y in LDraw units')
  await numericX.waitFor({ timeout: 5_000 })
  const beforeNumeric = await modelState()
  const numericTarget = await page.evaluate(
    (id) => Math.round((window.brickwright.getDocument().parts[id].transform.position[0] + 60) / 20) * 20,
    subjectId,
  )
  await numericX.fill(String(numericTarget))
  await numericX.press('Enter')
  await page.waitForFunction((revision) => window.brickwright.getDocument().revision > revision, beforeNumeric.revision, { timeout: 10_000 })
  const numericResult = await page.evaluate((id) => {
    const model = window.brickwright.getDocument()
    const basis = model.parts[id].transform.basis
    let worst = 0
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        let dot = 0
        for (let k = 0; k < 3; k += 1) dot += basis[row * 3 + k] * basis[col * 3 + k]
        worst = Math.max(worst, Math.abs(dot - (row === col ? 1 : 0)))
      }
    }
    return { x: model.parts[id].transform.position[0], revision: model.revision, orthonormalityError: worst }
  }, subjectId)
  assert(
    numericResult.revision === beforeNumeric.revision + 1,
    `Numeric entry committed ${numericResult.revision - beforeNumeric.revision} transactions, not one`,
  )
  const shownX = Number(await numericX.inputValue())
  assert(
    shownX === numericResult.x,
    `The numeric field shows ${shownX} but the document stores ${numericResult.x}`,
  )
  // A numeric edit that sheared the basis would be refused by the kernel on the
  // next commit, so the canonical path has to keep it exactly orthonormal.
  assert(
    numericResult.orthonormalityError < 1e-9,
    `Numeric entry left the basis sheared by ${numericResult.orthonormalityError}`,
  )
  workflow.numericTransform = numericResult

  // Lift it clear of the build. LDraw is Y-down, so this is 200 LDU up, well
  // outside the connector solver's search radius — the part is now genuinely
  // detached, which is the state Connect exists for.
  const beforeLift = await modelState()
  const liftTarget = await page.evaluate(
    (id) => window.brickwright.getDocument().parts[id].transform.position[1] - 200,
    subjectId,
  )
  await numericY.fill(String(liftTarget))
  await numericY.press('Enter')
  await page.waitForFunction((revision) => window.brickwright.getDocument().revision > revision, beforeLift.revision, { timeout: 10_000 })
  const detachedEdges = await page.evaluate(
    (id) => Object.values(window.brickwright.getDocument().connections)
      .filter((edge) => edge.a.partId === id || edge.b.partId === id).length,
    subjectId,
  )
  assert(detachedEdges === 0, `Lifting the part clear left ${detachedEdges} connections behind`)

  // mate via Connect: an explicit two-stage interaction with a reviewed preview.
  await page.locator('.primary-tools .tool-button', { hasText: 'Connect' }).click()
  const connectPanel = page.locator('.connect-panel')
  await connectPanel.waitFor({ timeout: 5_000 })
  assert(
    (await connectPanel.locator('.connect-stages li').count()) === 3,
    'Connect should present three explicit stages',
  )
  // Stage one is answered by the existing selection, so the flow opens on the
  // target stage already naming the part that will move.
  assert(
    (await connectPanel.getAttribute('data-stage')) === 'target',
    'Picking up Connect with one part selected should seed it as the moving part',
  )
  const movingName = (await connectPanel.locator('.connect-side strong').first().innerText()).trim()
  assert(movingName.length > 0, 'Connect did not name the part it is about to move')
  assert(
    (await connectPanel.locator('.connector-chips').first().locator('button').count()) > 1,
    'Connect surfaced no connectors on the moving part',
  )

  // Stage two: click parts until one offers a legal mate. A target that offers
  // none is a legitimate answer, and is asserted to say so rather than leaving
  // a dead button.
  let connectReady = false
  let refusal = null
  for (const offset of [[0, 0], [90, -50], [-90, -50], [140, 30], [-140, 30], [0, -110], [60, 90], [-60, 90], [180, -20], [-180, -20]]) {
    await page.locator('canvas').click({ position: { x: canvasCentre.x + offset[0], y: canvasCentre.y + offset[1] } })
    await page.waitForTimeout(220)
    if ((await connectPanel.getAttribute('data-stage')) !== 'review') continue
    if (!(await page.locator('.connect-commit').isDisabled())) { connectReady = true; break }
    refusal = (await connectPanel.locator('.connect-empty').innerText()).trim()
    assert(refusal.length > 0, 'Connect offered no mate and gave no reason')
    await page.locator('.connect-actions button', { hasText: 'BACK' }).click()
    await page.waitForTimeout(140)
  }
  assert(connectReady, `Connect never found a legal mate for ${movingName}${refusal ? ` (last refusal: ${refusal})` : ''}`)
  const previewRows = await connectPanel.locator('.connect-preview div').count()
  assert(previewRows >= 4, `The mate preview should state its mates, certainty, movement and seat, saw ${previewRows} rows`)
  await page.screenshot({ path: 'artifacts/workbench/state-connect.png' })

  const beforeConnect = await modelState()
  const beforeConnectPose = await page.evaluate(
    (id) => JSON.stringify(window.brickwright.getDocument().parts[id].transform),
    subjectId,
  )
  await page.locator('.connect-commit').click()
  await page.waitForFunction((revision) => window.brickwright.getDocument().revision > revision, beforeConnect.revision, { timeout: 10_000 })
  const afterConnect = await modelState()
  assert(afterConnect.revision === beforeConnect.revision + 1, 'Connect committed more than one transaction')
  assert(afterConnect.parts === beforeConnect.parts, 'Connect changed the part count; it may only move a part')
  assert(
    (await page.evaluate((id) => JSON.stringify(window.brickwright.getDocument().parts[id].transform), subjectId)) !== beforeConnectPose,
    'Connect committed without moving anything',
  )
  // The mate has to be real: the kernel's own connection graph must now record
  // an edge touching the part Connect moved.
  const matedEdges = await page.evaluate(
    (id) => Object.values(window.brickwright.getDocument().connections)
      .filter((edge) => edge.a.partId === id || edge.b.partId === id).length,
    subjectId,
  )
  assert(matedEdges > 0, 'Connect moved the part but the kernel recorded no connection')
  workflow.connect = { moving: movingName, previewRows, matedEdges, committed: true }
  await page.locator('.primary-tools .tool-button', { hasText: 'Select' }).click()

  // recolour: choose an active colour in the palette, then paint the selection.
  const beforeColour = await page.evaluate((id) => ({
    revision: window.brickwright.getDocument().revision,
    color: window.brickwright.getDocument().parts[id].color,
  }), subjectId)
  const swatchIndex = await page.evaluate((current) => {
    const swatches = [...document.querySelectorAll('.palette-dock .swatches button')]
    return swatches.findIndex((node) => !(node.getAttribute('title') ?? '').includes(`LDraw ${current}`))
  }, beforeColour.color)
  assert(swatchIndex >= 0, 'The project palette offered no colour other than the one already applied')
  await page.locator('.palette-dock .swatches button').nth(swatchIndex).click()
  await page.locator('.dock-right').getByRole('button', { name: 'Paint' }).click()
  await page.waitForFunction((revision) => window.brickwright.getDocument().revision > revision, beforeColour.revision, { timeout: 10_000 })
  const afterColour = await page.evaluate((id) => window.brickwright.getDocument().parts[id].color, subjectId)
  assert(afterColour !== beforeColour.color, 'Painting the selection did not change its colour')
  workflow.recolour = { from: beforeColour.color, to: afterColour }

  // clone
  const beforeClone = await modelState()
  await page.locator('.dock-right').getByRole('button', { name: 'Clone' }).click()
  await page.waitForFunction((parts) => Object.keys(window.brickwright.getDocument().parts).length > parts, beforeClone.parts, { timeout: 10_000 })
  const afterClone = await modelState()
  assert(afterClone.parts === beforeClone.parts + 1, `Clone added ${afterClone.parts - beforeClone.parts} parts, not one`)
  assert(afterClone.revision === beforeClone.revision + 1, 'Clone was not a single transaction')
  workflow.clone = afterClone

  // array. The control is parameterised rather than a fixed guess, so the run
  // states its own copies, axis and spacing.
  const beforeArray = await modelState()
  await page.locator('.dock-right').getByRole('button', { name: 'Array' }).click()
  await page.locator('.array-control').waitFor({ timeout: 5_000 })
  await page.locator('.array-control').getByLabel('Array copies').fill('3')
  await page.locator('.array-control').getByLabel('Array axis').selectOption('y')
  await page.locator('.array-control').getByRole('button', { name: 'ARRAY' }).click()
  await page.waitForFunction((parts) => Object.keys(window.brickwright.getDocument().parts).length > parts, beforeArray.parts, { timeout: 10_000 })
  const afterArray = await modelState()
  assert(afterArray.parts === beforeArray.parts + 3, `A three-copy array added ${afterArray.parts - beforeArray.parts} parts`)
  assert(afterArray.revision === beforeArray.revision + 1, 'The array was not a single transaction')
  workflow.array = afterArray

  // isolate: view state, never a document edit.
  const beforeIsolate = await page.evaluate(() => window.brickwright.getDocument().revision)
  await page.locator('.dock-right').getByRole('button', { name: /Isolate/ }).click()
  await page.locator('.status-visibility').waitFor({ timeout: 5_000 })
  const isolateNote = (await page.locator('.status-visibility').innerText()).trim()
  assert(/Isolated \d+ of \d+ parts/.test(isolateNote), `Isolate did not report its scope, saw "${isolateNote}"`)
  assert(
    (await page.evaluate(() => window.brickwright.getDocument().revision)) === beforeIsolate,
    'Isolating parts mutated the document; visibility has to be view state only',
  )
  await page.screenshot({ path: 'artifacts/workbench/state-isolate.png' })
  await page.locator('.status-visibility').click()
  await page.locator('.status-visibility').waitFor({ state: 'hidden' })
  workflow.isolate = isolateNote

  // undo unwinds the whole workflow, one transaction at a time.
  const beforeUndoChain = await modelState()
  for (let step = 0; step < 14; step += 1) {
    if ((await page.evaluate(() => Object.keys(window.brickwright.getDocument().parts).length)) === beforeFind.parts) break
    await page.getByRole('button', { name: 'Undo' }).click()
    await page.waitForTimeout(120)
  }
  const afterUndoChain = await modelState()
  assert(
    afterUndoChain.parts === beforeFind.parts,
    `Undoing the workflow left ${afterUndoChain.parts} parts, expected ${beforeFind.parts}`,
  )
  assert(afterUndoChain.revision > beforeUndoChain.revision, 'Undo did not advance the revision monotonically')
  workflow.undo = afterUndoChain

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

  // -- responsive, accessible and visually pinned ---------------------------
  // A dense CAD console is exactly the kind of interface that quietly breaks at
  // a width nobody tested, or that can only be driven with a mouse. Both are
  // asserted here rather than assumed, and every state is written to
  // artifacts/workbench/ so a regression is visible as an image.
  const quality = { responsive: [], contrast: [], screenshots: [] }
  const shot = async (name) => {
    await page.screenshot({ path: `artifacts/workbench/${name}.png` })
    quality.screenshots.push(name)
  }

  await page.locator('.primary-tools .tool-button', { hasText: 'Select' }).click()
  await page.locator('canvas').click({ position: canvasCentre })
  await shot('state-default')

  await page.locator('.category-row .facet-toggle').click()
  await page.locator('.palette-facets').waitFor()
  await shot('state-palette-facets')
  await page.locator('.category-row .facet-toggle').click()

  await shot('state-transform')

  await page.locator('.timeline-switch button', { hasText: 'HISTORY' }).click()
  await shot('state-timeline-history')
  await page.locator('.timeline-switch button', { hasText: 'STEPS' }).click()

  await page.selectOption('.render-picker select', 'connections')
  await page.waitForTimeout(300)
  await shot('state-render-connections')
  await page.selectOption('.render-picker select', 'exploded')
  await page.waitForTimeout(400)
  await shot('state-render-exploded')
  await page.selectOption('.render-picker select', 'beauty')
  await page.waitForTimeout(200)

  // The inspector's validation report, which is also the last existing
  // assertion's target — proven reachable rather than assumed.
  await page.getByRole('button', { name: /VALIDATE/ }).click()
  await page.locator('.validation-hero').waitFor({ timeout: 10_000 })
  await shot('state-validate')
  await page.getByRole('button', { name: /OBJECT/ }).click()

  // Collapsed docks are a first-class layout, not a degraded one.
  await page.locator('.dock-left .dock-collapse').click()
  await page.locator('.dock-rail.left').waitFor()
  await shot('state-dock-collapsed')
  await page.locator('.dock-rail.left button').click()
  await page.locator('.dock-left').waitFor()

  // -- command palette: keyboard-only, trapped, and restoring focus ---------
  await page.locator('.primary-tools .tool-button', { hasText: 'Select' }).focus()
  await page.keyboard.press('ControlOrMeta+p')
  const commandPalette = page.getByRole('dialog', { name: 'Command palette' })
  await commandPalette.waitFor({ timeout: 10_000 })
  assert(
    await commandPalette.getByLabel('Search commands').evaluate((node) => document.activeElement === node),
    'Opening the command palette did not move focus into its search field',
  )
  await page.keyboard.type('isolate')
  const paletteRows = await commandPalette.getByRole('option').count()
  assert(paletteRows > 0, 'The command palette matched nothing for a command it publishes')
  await shot('state-command-palette')

  // Focus trap: tabbing off the last control has to come back to the first.
  const trapped = await page.evaluate(() => {
    const dialog = document.querySelector('.command-palette')
    if (!dialog) return false
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
    focusable[focusable.length - 1].focus()
    return focusable.length > 1
  })
  assert(trapped, 'The command palette had too few controls to test its focus trap')
  await page.keyboard.press('Tab')
  assert(
    await page.evaluate(() => document.querySelector('.command-palette')?.contains(document.activeElement) ?? false),
    'Tab escaped the command palette; a modal that leaks focus is not modal',
  )

  // The keys tab is where a binding is changed, and where a conflict is named.
  await commandPalette.getByRole('tab', { name: /KEYS/ }).click()
  await commandPalette.locator('.keymap-row').first().waitFor()
  const keymapRows = await commandPalette.locator('.keymap-row').count()
  assert(keymapRows > 30, `Expected the whole command map to be rebindable, saw ${keymapRows} rows`)
  await shot('state-keymap')
  // Rebind Move onto Select's chord and confirm the conflict is reported rather
  // than one of them silently winning.
  await commandPalette.getByLabel(/Change the shortcut for Move tool/).click()
  await page.keyboard.press('v')
  await commandPalette.locator('.keymap-conflicts').waitFor({ timeout: 5_000 })
  const conflictText = await commandPalette.locator('.keymap-conflicts').innerText()
  assert(/tool\.move/.test(conflictText) && /tool\.select/.test(conflictText), `The conflict did not name both commands: ${conflictText}`)
  await shot('state-keymap-conflict')
  await commandPalette.getByRole('button', { name: /RESET ALL/ }).click()
  assert(
    (await commandPalette.locator('.keymap-conflicts').count()) === 0,
    'Resetting the keyboard map did not clear the conflict',
  )
  await page.keyboard.press('Escape')
  await commandPalette.waitFor({ state: 'hidden' })
  assert(
    await page.locator('.primary-tools .tool-button', { hasText: 'Select' }).evaluate((node) => document.activeElement === node),
    'Closing the command palette did not restore focus to whatever opened it',
  )

  // -- screen-reader labelling ---------------------------------------------
  const labelling = await page.evaluate(() => {
    const unnamed = []
    for (const button of document.querySelectorAll('button')) {
      const text = (button.textContent ?? '').trim()
      const named = button.getAttribute('aria-label') || button.getAttribute('title') || text
      if (!named) unnamed.push(button.className || button.outerHTML.slice(0, 80))
    }
    const unlabelledFields = []
    for (const field of document.querySelectorAll('input, select, textarea')) {
      const id = field.getAttribute('id')
      const named = field.getAttribute('aria-label')
        || (id && document.querySelector(`label[for="${id}"]`))
        || field.closest('label')
        || field.getAttribute('title')
      if (!named) unlabelledFields.push(field.className || field.outerHTML.slice(0, 80))
    }
    return { unnamed, unlabelledFields }
  })
  assert(
    labelling.unnamed.length === 0,
    `${labelling.unnamed.length} buttons have no accessible name: ${labelling.unnamed.slice(0, 4).join(' | ')}`,
  )
  assert(
    labelling.unlabelledFields.length === 0,
    `${labelling.unlabelledFields.length} form fields have no label: ${labelling.unlabelledFields.slice(0, 4).join(' | ')}`,
  )

  // -- keyboard reachability ------------------------------------------------
  // Tab from the very top of the document and record what it can reach.
  await page.locator('.brand-lockup').click({ position: { x: 4, y: 4 } })
  const reached = []
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press('Tab')
    const id = await page.evaluate(() => {
      const node = document.activeElement
      if (!node || node === document.body) return null
      return `${node.tagName.toLowerCase()}.${(node.className || '').toString().split(' ')[0]}:${(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 24)}`
    })
    if (id) reached.push(id)
  }
  assert(reached.length > 20, `Only ${reached.length} controls were reachable by Tab in 60 presses`)
  assert(
    reached.some((entry) => entry.includes('tool-button')),
    'The tool rail is not reachable by keyboard',
  )
  assert(
    reached.some((entry) => entry.startsWith('input')),
    'No text field is reachable by keyboard',
  )
  quality.keyboardReachable = reached.length

  // Resizing a dock has to be possible without a pointer. The splitter is a
  // focusable separator, and the arrow keys move it.
  const splitter = page.locator('.dock-splitter').first()
  await splitter.focus()
  assert(
    await splitter.evaluate((node) => document.activeElement === node),
    'The dock splitter cannot take focus, so resizing is pointer-only',
  )
  const widthBeforeKeys = await page.evaluate(() => Math.round(document.querySelector('.dock-left').getBoundingClientRect().width))
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const widthAfterKeys = await page.evaluate(() => Math.round(document.querySelector('.dock-left').getBoundingClientRect().width))
  assert(
    widthAfterKeys > widthBeforeKeys,
    `Arrow keys did not resize the dock (${widthBeforeKeys} -> ${widthAfterKeys})`,
  )
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(150)
  quality.keyboardResize = { before: widthBeforeKeys, after: widthAfterKeys }

  // -- contrast -------------------------------------------------------------
  // Sampled on the text that carries meaning rather than blanket-scanned: the
  // status bar, the dock headers, the tool labels and the palette copy.
  const contrast = await page.evaluate(() => {
    const luminance = (rgb) => {
      const channel = (value) => {
        const v = value / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
    }
    const parse = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const backdropOf = (node) => {
      let current = node
      while (current) {
        const background = getComputedStyle(current).backgroundColor
        const parts = (background.match(/[\d.]+/g) ?? []).map(Number)
        if (parts.length >= 3 && (parts[3] === undefined || parts[3] > 0.6)) return parts.slice(0, 3)
        current = current.parentElement
      }
      return [9, 13, 14]
    }
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const samples = [
      ['.statusbar .status-scope', 4.5],
      ['.statusbar .status-hint', 4.5],
      ['.dock-section-toggle span', 4.5],
      ['.tool-button.active span', 4.5],
      ['.part-copy strong', 4.5],
      ['.selection-summary strong', 4.5],
      ['.transform-action span', 4.5],
      ['.selection-modes button', 4.5],
      ['.dock-head .eyebrow', 3],
      ['.part-copy span', 3],
    ]
    return samples.map(([selector, minimum]) => {
      const node = document.querySelector(selector)
      if (!node) return { selector, minimum, ratio: null }
      const style = getComputedStyle(node)
      return {
        selector,
        minimum,
        ratio: Number(ratio(parse(style.color), backdropOf(node)).toFixed(2)),
      }
    })
  })
  for (const sample of contrast) {
    assert(sample.ratio !== null, `Contrast sample "${sample.selector}" was not on screen`)
    assert(
      sample.ratio >= sample.minimum,
      `${sample.selector} reads at ${sample.ratio}:1, below its ${sample.minimum}:1 floor`,
    )
  }
  quality.contrast = contrast

  // -- prefers-reduced-motion ----------------------------------------------
  const motionBefore = await page.evaluate(() => {
    const card = document.querySelector('.part-card')
    return card ? getComputedStyle(card).transitionDuration : null
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const motionAfter = await page.evaluate(() => {
    const card = document.querySelector('.part-card')
    const chevron = document.querySelector('.dock-chevron')
    return {
      card: card ? getComputedStyle(card).transitionDuration : null,
      chevron: chevron ? getComputedStyle(chevron).transitionDuration : null,
    }
  })
  const seconds = (value) => Math.max(...(value ?? '0s').split(',').map((entry) => Number.parseFloat(entry) || 0))
  assert(seconds(motionBefore) > 0.05, `Expected a real transition by default, saw ${motionBefore}`)
  assert(seconds(motionAfter.card) < 0.01, `prefers-reduced-motion left a ${motionAfter.card} transition on part cards`)
  assert(seconds(motionAfter.chevron) < 0.01, `prefers-reduced-motion left a ${motionAfter.chevron} transition on dock chevrons`)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  quality.reducedMotion = { normal: motionBefore, reduced: motionAfter.card }

  // -- four widths, no overflow, no unusably small controls ----------------
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1600, height: 1000 },
    { width: 2560, height: 1080 },
  ]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(350)
    const measured = await page.evaluate((viewport) => {
      const shell = document.querySelector('.app-shell')
      const canvas = document.querySelector('canvas')
      const rect = canvas?.getBoundingClientRect()
      const tooSmall = []
      const interactive = document.querySelectorAll(
        '.toolrail button, .statusbar button, .dock-section-toggle, .selection-modes button, .transform-action, .tier-row button, .part-add, .dock-splitter',
      )
      for (const node of interactive) {
        // A splitter is drawn as a hairline on purpose; what has to clear the
        // minimum is the area a pointer can actually hit.
        const target = node.classList.contains('dock-splitter') ? (node.firstElementChild ?? node) : node
        const box = target.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) continue
        if (Math.min(box.width, box.height) < 16) {
          tooSmall.push(`${node.className}:${Math.round(box.width)}x${Math.round(box.height)}`)
        }
      }
      const overflowing = []
      for (const node of document.querySelectorAll('.app-shell > *')) {
        const box = node.getBoundingClientRect()
        if (box.right > viewport.width + 1 || box.left < -1) {
          overflowing.push(`${node.className}:${Math.round(box.left)}..${Math.round(box.right)}`)
        }
      }
      return {
        documentScrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        shellWidth: shell ? Math.round(shell.getBoundingClientRect().width) : 0,
        canvasWidth: rect ? Math.round(rect.width) : 0,
        canvasHeight: rect ? Math.round(rect.height) : 0,
        tooSmall,
        overflowing,
      }
    }, size)
    assert(
      measured.documentScrollWidth <= measured.clientWidth + 1,
      `At ${size.width}x${size.height} the page scrolls horizontally (${measured.documentScrollWidth} > ${measured.clientWidth})`,
    )
    assert(
      measured.overflowing.length === 0,
      `At ${size.width}x${size.height} these regions overflow the shell: ${measured.overflowing.join(', ')}`,
    )
    assert(
      measured.canvasWidth >= 420 && measured.canvasHeight >= 280,
      `At ${size.width}x${size.height} the viewport is only ${measured.canvasWidth}x${measured.canvasHeight}`,
    )
    assert(
      measured.tooSmall.length === 0,
      `At ${size.width}x${size.height} these controls are under 16px: ${measured.tooSmall.slice(0, 5).join(', ')}`,
    )
    await shot(`layout-${size.width}x${size.height}`)
    quality.responsive.push({ ...size, canvas: [measured.canvasWidth, measured.canvasHeight] })
  }
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForTimeout(300)

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
    workflows: workflow,
    quality: {
      responsive: quality.responsive,
      keyboardReachableControls: quality.keyboardReachable,
      keyboardResize: quality.keyboardResize,
      contrast: quality.contrast,
      reducedMotion: quality.reducedMotion,
      screenshots: quality.screenshots.length,
      screenshotDirectory: 'artifacts/workbench/',
    },
    screenshot: 'artifacts/e2e-final.png',
  }, null, 2))
  await browser.close()
} finally {
  server?.kill('SIGTERM')
}
