import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateDocument, boxGeometry, healthyValidation } from '../__fixtures__/model'
import { createPublication, publicationBytes } from '../publish'
import type { Publication } from '../types'
import { SharedViewer } from './SharedViewer'
import { describeStep, INITIAL_VIEWER_STATE, stepSelection, viewerReducer } from './state'

/**
 * The viewer's contract has two halves, and both are tested here.
 *
 * The behavioural half — orbiting, scrubbing, exploding, forking — is exercised
 * through the rendered component. The structural half — that this code
 * *cannot* reach the canonical project — is checked by reading the module
 * sources, because "we did not import the engine" is a property of the files,
 * not of any one render.
 */

const publish = () =>
  createPublication({
    document: privateDocument(11),
    validation: healthyValidation(11),
    capabilities: { view: true, comment: false, fork: true, download: false, embed: true },
    title: 'Survey Rover',
    author: { displayName: 'Rishabh Bansal', handle: null, url: null },
    now: new Date('2026-08-27T00:00:00.000Z'),
  })

const FULL = { view: true, comment: false, fork: true, download: false, embed: true }

// This project does not enable Vitest globals, so Testing Library's automatic
// cleanup never registers. Without this, every render stacks in the same
// document and `getByTestId` finds the previous test's tree.
afterEach(cleanup)

function renderViewer(publication: Publication, overrides: Partial<Parameters<typeof SharedViewer>[0]> = {}) {
  return render(
    <SharedViewer
      publication={publication}
      capabilities={FULL}
      geometry={boxGeometry}
      shareUrl={`https://brickwrite.tech/share/${publication.slug}`}
      embedUrl={`https://brickwrite.tech/embed/${publication.slug}`}
      canvasWidth={160}
      canvasHeight={120}
      {...overrides}
    />,
  )
}

describe('viewer state', () => {
  it('wraps yaw and stops pitch short of the pole', () => {
    let state = INITIAL_VIEWER_STATE
    state = viewerReducer(state, { type: 'orbit', deltaYaw: 400, deltaPitch: 0 })
    expect(state.yaw).toBe(40)
    state = viewerReducer(state, { type: 'orbit', deltaYaw: -80, deltaPitch: 0 })
    expect(state.yaw).toBe(320)
    state = viewerReducer(state, { type: 'orbit', deltaYaw: 0, deltaPitch: 999 })
    expect(state.pitch).toBe(80)
    state = viewerReducer(state, { type: 'orbit', deltaYaw: 0, deltaPitch: -9999 })
    expect(state.pitch).toBe(-80)
  })

  it('clamps zoom and explode, and ignores nonsense', () => {
    let state = INITIAL_VIEWER_STATE
    for (let i = 0; i < 50; i += 1) state = viewerReducer(state, { type: 'zoom', delta: 1 })
    expect(state.zoom).toBe(3)
    for (let i = 0; i < 50; i += 1) state = viewerReducer(state, { type: 'zoom', delta: -1 })
    expect(state.zoom).toBe(0.4)
    expect(viewerReducer(state, { type: 'explode', value: 9 }).explode).toBe(1)
    expect(viewerReducer(state, { type: 'explode', value: Number.NaN }).explode).toBe(state.explode)
  })

  it('loops the step sequence through the finished model', () => {
    let state = INITIAL_VIEWER_STATE
    state = viewerReducer(state, { type: 'step-delta', delta: 1, stepCount: 3 })
    // Stepping forward from "finished" wraps to the start.
    expect(state.step).toBeNull()
    state = viewerReducer(state, { type: 'step', value: 1 })
    expect(state.step).toBe(1)
    state = viewerReducer(state, { type: 'step-delta', delta: -1, stepCount: 3 })
    expect(state.step).toBeNull()
    state = viewerReducer({ ...state, step: 3 }, { type: 'step-delta', delta: 1, stepCount: 3 })
    expect(state.step).toBeNull()
    expect(viewerReducer(state, { type: 'step-delta', delta: 1, stepCount: 0 })).toBe(state)
  })

  it('selects exactly the parts placed up to a step', async () => {
    const publication = await publish()
    expect(stepSelection(publication.document, null)).toEqual({ include: null, highlight: null })
    const atTwo = stepSelection(publication.document, 2)
    expect([...atTwo.include!].sort()).toEqual(['part_001', 'part_002', 'part_003', 'part_004'])
    expect([...atTwo.highlight!].sort()).toEqual(['part_003', 'part_004'])
    expect(describeStep(publication.document, 2)).toContain('Step 2 of 3')
    expect(describeStep(publication.document, null)).toContain('Finished model')
  })
})

describe('read-only viewer', () => {
  it('renders attribution, stats, the validation badge and the parts list', async () => {
    const publication = await publish()
    renderViewer(publication)

    expect(screen.getByTestId('viewer-author')).toHaveTextContent('Rishabh Bansal')
    expect(screen.getByTestId('part-count')).toHaveTextContent('6')
    expect(screen.getByTestId('validation-badge')).toHaveTextContent(/Validated/)
    expect(within(screen.getByRole('table')).getAllByRole('row').length).toBeGreaterThan(1)
    expect(screen.getByTestId('share-url')).toHaveValue(`https://brickwrite.tech/share/${publication.slug}`)
  })

  it('says "Author not stated" rather than inventing one', async () => {
    const publication = await createPublication({ document: privateDocument(1) })
    renderViewer(publication)
    expect(screen.queryByTestId('viewer-author')).toBeNull()
    expect(screen.getByText('Author not stated')).toBeInTheDocument()
  })

  it('scrubs the build sequence and announces the step', async () => {
    const publication = await publish()
    renderViewer(publication)

    expect(screen.getByTestId('step-label')).toHaveTextContent('Finished model')
    fireEvent.click(screen.getByTestId('step-2'))
    expect(screen.getByTestId('step-label')).toHaveTextContent('Step 2 of 3: Interlock layer')
    expect(screen.getByTestId('share-viewer-canvas')).toHaveAttribute('data-step', '2')

    fireEvent.click(screen.getByTestId('step-back'))
    expect(screen.getByTestId('share-viewer-canvas')).toHaveAttribute('data-step', '1')
    fireEvent.click(screen.getByTestId('step-all'))
    expect(screen.getByTestId('share-viewer-canvas')).toHaveAttribute('data-step', 'all')
  })

  it('orbits from the keyboard', async () => {
    const publication = await publish()
    renderViewer(publication)
    const canvas = screen.getByTestId('share-viewer-canvas')
    expect(canvas).toHaveAttribute('data-yaw', '0')
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    expect(canvas).toHaveAttribute('data-yaw', '5')
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true })
    expect(canvas).toHaveAttribute('data-yaw', '50')
    fireEvent.keyDown(canvas, { key: 'ArrowUp' })
    expect(canvas).toHaveAttribute('data-pitch', '5')
    fireEvent.keyDown(canvas, { key: '0' })
    expect(canvas).toHaveAttribute('data-yaw', '0')
    expect(canvas).toHaveAttribute('data-pitch', '0')
    fireEvent.keyDown(canvas, { key: 'ArrowRight' })
    fireEvent.keyDown(canvas, { key: 'Home' })
    expect(canvas).toHaveAttribute('data-yaw', '0')
  })

  it('explodes without touching the snapshot', async () => {
    const publication = await publish()
    const before = publicationBytes(publication)
    renderViewer(publication)
    fireEvent.change(screen.getByTestId('explode-slider'), { target: { value: '0.8' } })
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(publicationBytes(publication)).toEqual(before)
  })

  it('reports parts it could not draw instead of showing a silent gap', async () => {
    const publication = await publish()
    renderViewer(publication, { geometry: () => null, unavailableDefinitionIds: ['3001'] })
    expect(screen.getByTestId('missing-geometry')).toHaveTextContent('3001')
  })

  it('hides the fork action when the capability is off, and says why', async () => {
    const publication = await publish()
    renderViewer(publication, { capabilities: { ...FULL, fork: false } })
    expect(screen.queryByTestId('fork-button')).toBeNull()
    expect(screen.getByText(/has not enabled forking/)).toBeInTheDocument()
  })
})

describe('edit a copy', () => {
  it('produces a distinct project with fork provenance, leaving the publication untouched', async () => {
    const publication = await publish()
    const before = publicationBytes(publication)
    const onFork = vi.fn()
    renderViewer(publication, { onFork })

    fireEvent.click(screen.getByTestId('fork-button'))

    expect(onFork).toHaveBeenCalledTimes(1)
    const result = onFork.mock.calls[0][0] as {
      document: { id: string; revision: number; parts: Record<string, unknown> }
      provenance: { publicationId: string; sourceRevision: number; sourceContentHash: string }
    }
    expect(result.document.id).toMatch(/^prj_/)
    expect(result.document.revision).toBe(0)
    expect(Object.keys(result.document.parts)).toHaveLength(6)
    expect(result.provenance).toMatchObject({
      publicationId: publication.id,
      slug: publication.slug,
      sourceRevision: 11,
      sourceContentHash: publication.contentHash,
    })
    expect(publicationBytes(publication)).toEqual(before)
    expect(screen.getByTestId('fork-button')).toHaveTextContent('Copy created')
  })

  it('gives every fork its own project id', async () => {
    const publication = await publish()
    const ids = new Set<string>()
    const onFork = vi.fn((result: { document: { id: string } }) => ids.add(result.document.id))
    renderViewer(publication, { onFork })
    fireEvent.click(screen.getByTestId('fork-button'))
    fireEvent.click(screen.getByTestId('fork-button'))
    expect(ids.size).toBe(2)
  })

  it('surfaces a fork failure rather than silently doing nothing', async () => {
    const publication = await publish()
    renderViewer(publication, {
      onFork: () => {
        throw new Error('storage refused')
      },
    })
    fireEvent.click(screen.getByTestId('fork-button'))
    expect(screen.getByRole('alert')).toHaveTextContent('storage refused')
  })
})

/**
 * The structural argument, checked rather than asserted in prose.
 *
 * The viewer cannot mutate the canonical project because it has no way to
 * address it: no engine, no session, no command bus, and — apart from the route
 * shell, which saves a *new* project — no repository. If somebody later imports
 * `cadEngine` into this directory, this test fails and says exactly why.
 */
describe('the viewer is structurally incapable of mutating a project', () => {
  // Vitest rewrites `import.meta.url` to a server-root-relative path, so the
  // directory is resolved from the working directory instead.
  const directory = join(process.cwd(), 'src/features/share/viewer')
  const sources = readdirSync(directory)
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.test.tsx'))
    .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }))

  it('has sources to check', () => {
    expect(new Set(sources.map((entry) => entry.name))).toEqual(
      new Set(['ModelCanvas.tsx', 'SharePage.tsx', 'ShareBar.tsx', 'SharedViewer.tsx', 'geometry.ts', 'state.ts']),
    )
  })

  it('never imports the command bus, the engine or the session', () => {
    for (const { name, text } of sources) {
      // Comments are stripped first: this file argues about the engine in prose,
      // and prose is not an import.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const forbidden of ['cad/engine', 'cad/session', 'cad/patch', 'cad/storage', 'webmcp/adapter']) {
        expect(code, `${name} imports ${forbidden}`).not.toContain(forbidden)
      }
      expect(code, `${name} references cadEngine`).not.toMatch(/\bcadEngine\b/)
    }
  })

  it('touches persistence only in the route shell, and only to save a new project', () => {
    const persistence = sources.filter((entry) => entry.text.includes('cad/persistence'))
    expect(persistence.map((entry) => entry.name)).toEqual(['SharePage.tsx'])
    const shell = persistence[0].text
    // The only repository call is a checkpoint of the forked document, which is
    // keyed by that document's own fresh id.
    expect(shell.match(/createRepository\(\)\.\w+/g)).toEqual(['createRepository().saveCheckpoint'])
    expect(shell).toContain('saveCheckpoint(result.document)')
    expect(shell).not.toMatch(/deleteProject|appendTransaction/)
  })

  it('exposes no mutation action in the viewer reducer', () => {
    const state = sources.find((entry) => entry.name === 'state.ts')!.text
    const actions = [...state.matchAll(/\|\s*\{\s*type:\s*'([a-z-]+)'/g)].map((match) => match[1])
    expect(actions.sort()).toEqual(['drag', 'explode', 'orbit', 'reset', 'set-orbit', 'step', 'step-delta', 'zoom'])
  })
})

describe('share bar credentials', () => {
  it('does not offer Copy link when the URL would not grant a recipient access', async () => {
    const publication = await publish()
    renderViewer(publication, { urlGrantsAccess: false })
    expect(screen.queryByTestId('share-copy')).toBeNull()
    expect(screen.queryByTestId('share-url')).toBeNull()
    expect(screen.getByTestId('share-url-not-credential')).toHaveTextContent(/not a shareable link/)
  })
})
