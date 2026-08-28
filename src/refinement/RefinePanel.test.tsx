// `tsconfig.app.json` type-checks `.test.tsx` (its exclude list only names
// `.test.ts`), so the jest-dom matcher augmentation is imported here as well as
// in the shared setup file. The import is idempotent at runtime.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CadEngine } from '../cad/engine'
import type { ModelDocument } from '../cad/types'
import type { WorkbenchApi } from '../editor/workbench'
import { refinementFixture } from './__fixtures__'
import { ObjectivesDialog } from './ObjectivesDialog'
import { objectiveList } from './objectives'
import { busFor, runRefinement } from './pipeline'
import { RefineOverlay } from './RefineOverlay'
import { RefinePanel } from './RefinePanel'
import { RefinementSession, type RefinementRunner } from './session'
import type { RefinementProposalV1 } from './types'
import type { RefinementJobResult } from './worker'

/**
 * The Refine panel, against real proposals.
 *
 * The proposals these tests review are produced once by the actual search over a
 * real fixture — real operations, real metric vectors, real regressions — and
 * then replayed through an injected runner. Hand-written proposal literals would
 * pass while the panel misread the engine's own shape, which is the failure this
 * whole integration exists to prevent. What is faked is the *timing*: a runner a
 * test controls is the only way to hold a search open long enough to assert the
 * loading, cancel and failure states as designed surfaces.
 */

afterEach(cleanup)

let fixtureDoc: ModelDocument
let realResult: RefinementJobResult

beforeAll(() => {
  const fixture = refinementFixture('seam-wall')
  fixtureDoc = fixture.document
  const run = runRefinement(
    {
      version: 1,
      id: 'test_seed',
      scopePartIds: fixture.scopePartIds,
      baseRevision: fixture.document.revision,
      instruction: fixture.instruction,
      budget: { maxIterations: 200, wallClockMs: 4_000 },
    },
    fixture.document,
  )
  realResult = {
    proposals: run.proposals,
    report: run.report,
    rankingRationale: run.rankingRationale,
    ranOn: 'inline',
  }
})

const ranked = (): RefinementProposalV1[] => realResult.proposals.filter((p) => p.status === 'ranked')

const resolved = (result: RefinementJobResult): RefinementRunner => () => Promise.resolve(result)

const held = (): { runner: RefinementRunner; release: (result: RefinementJobResult) => void } => {
  let settle: (result: RefinementJobResult) => void = () => {}
  const gate = new Promise<RefinementJobResult>((resolve) => {
    settle = resolve
  })
  return { runner: () => gate, release: settle }
}

interface ApiSpy {
  selected: string[][]
  notices: Array<{ kind: string; title: string; detail: string }>
  modals: Array<string | null>
  framed: number
}

function Harness({
  session,
  document: doc,
  initialSelection,
  spy,
}: {
  session: RefinementSession
  document: ModelDocument
  initialSelection: readonly string[]
  spy: ApiSpy
}) {
  const [selection, setSelection] = useState<readonly string[]>(initialSelection)
  const api: WorkbenchApi = {
    snapshot: { document: doc, selection: [...selection] } as unknown as WorkbenchApi['snapshot'],
    selection,
    tool: 'select',
    activeColor: 15,
    renderMode: 'beauty',
    cameraView: 'isometric',
    placement: null,
    online: true,
    hiddenPartIds: new Set<string>(),
    activeModal: null,
    select: (ids) => {
      spy.selected.push([...ids])
      setSelection([...ids])
    },
    setTool: () => {},
    setActiveColor: () => {},
    setRenderMode: () => {},
    setCameraView: () => {},
    frameSelection: () => {
      spy.framed += 1
    },
    armPart: () => true,
    runCapability: () => true,
    execute: () => true,
    notify: (notice) => spy.notices.push(notice),
    openModal: (id) => spy.modals.push(id),
  }
  return (
    <>
      <RefinePanel api={api} session={session} />
      <RefineOverlay api={api} session={session} />
    </>
  )
}

const newSpy = (): ApiSpy => ({ selected: [], notices: [], modals: [], framed: 0 })

interface MountOptions {
  runner?: RefinementRunner
  bus?: ConstructorParameters<typeof RefinementSession>[0] extends infer O
    ? O extends { bus?: infer B }
      ? B
      : never
    : never
  selection?: readonly string[]
  document?: ModelDocument
}

const mount = (options: MountOptions = {}) => {
  const spy = newSpy()
  const session = new RefinementSession({
    tickMs: 0,
    runner: options.runner ?? resolved(realResult),
    ...(options.bus ? { bus: options.bus } : {}),
  })
  const doc = options.document ?? fixtureDoc
  const view = render(
    <Harness
      session={session}
      document={doc}
      initialSelection={options.selection ?? Object.keys(doc.parts)}
      spy={spy}
    />,
  )
  return { session, spy, view, document: doc }
}

const search = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Find refinements/ }))
  })
}

// ---------------------------------------------------------------------------

describe('empty scope', () => {
  it('explains what a region is instead of showing a blank box', () => {
    mount({ selection: [] })
    expect(screen.getByRole('region', { name: 'Refine' })).toBeInTheDocument()
    expect(screen.getByText('Pick a region to refine')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`measures ${objectiveList.length}`))).toBeInTheDocument()
    expect(screen.getByText(/A wall whose joints line up through two courses/)).toBeInTheDocument()
    // Nothing to run yet, so no dead control pretending otherwise.
    expect(screen.queryByRole('button', { name: /Find refinements/ })).not.toBeInTheDocument()
  })

  it('offers a working selection action rather than an instruction to go elsewhere', () => {
    const { spy } = mount({ selection: [] })
    const all = Object.keys(fixtureDoc.parts)
    fireEvent.click(screen.getByRole('button', { name: `Select all ${all.length} parts` }))
    expect(spy.selected[0]).toEqual(all)
  })

  it('opens the objective reference from the empty state', () => {
    const { spy } = mount({ selection: [] })
    fireEvent.click(screen.getByRole('button', { name: /What is measured/ }))
    expect(spy.modals).toEqual(['refinement.objectives'])
  })
})

describe('the request', () => {
  it('reports the live selection as the scope', () => {
    mount({ selection: ['p004', 'p005'] })
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('parts in scope')).toBeInTheDocument()
    expect(screen.getByText(`r${fixtureDoc.revision}`)).toBeInTheDocument()
  })

  it('carries the instruction and the hand-set weights into the request', async () => {
    const seen: unknown[] = []
    const runner: RefinementRunner = (request) => {
      seen.push(request)
      return Promise.resolve(realResult)
    }
    mount({ runner })
    fireEvent.change(screen.getByLabelText('What should change'), {
      target: { value: 'lose the stacked joints' },
    })
    fireEvent.change(screen.getByLabelText('Seam bonding'), { target: { value: '5' } })
    await search()
    const request = seen[0] as { instruction: string; objectiveWeights: Record<string, number>; scopePartIds: string[] }
    expect(request.instruction).toBe('lose the stacked joints')
    expect(request.objectiveWeights).toEqual({ seamBonding: 5 })
    expect(request.scopePartIds).toEqual(Object.keys(fixtureDoc.parts))
  })

  it('leaves untouched objectives out of the request so the derived goal still decides', async () => {
    const seen: Array<Record<string, unknown>> = []
    const runner: RefinementRunner = (request) => {
      seen.push(request as unknown as Record<string, unknown>)
      return Promise.resolve(realResult)
    }
    mount({ runner })
    await search()
    expect(seen[0].objectiveWeights).toEqual({})
  })
})

describe('running', () => {
  it('shows determinate progress against the budget it is actually spending', async () => {
    const gate = held()
    mount({ runner: gate.runner })
    await search()
    const bar = screen.getByRole('progressbar', { name: 'Refinement search budget used' })
    expect(bar).toHaveAttribute('aria-valuemax', '2500')
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('Searching')).toBeInTheDocument()
    await act(async () => gate.release(realResult))
  })

  it('says which thread the search is on rather than implying one', async () => {
    const gate = held()
    mount({ runner: gate.runner })
    await search()
    // jsdom exposes no Worker, and the panel says so instead of claiming a
    // background thread it did not get.
    expect(screen.getByText(/no Worker, so the viewport will not respond/)).toBeInTheDocument()
    await act(async () => gate.release(realResult))
    expect(screen.getByText('main thread')).toBeInTheDocument()
  })

  it('swaps the run control for a cancel while a search is open', async () => {
    const gate = held()
    mount({ runner: gate.runner })
    await search()
    expect(screen.queryByRole('button', { name: /Find refinements/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel search/ })).toBeEnabled()
    await act(async () => gate.release(realResult))
  })
})

describe('cancel', () => {
  it('stops the search, writes nothing, and offers to run again', async () => {
    const dispatch = vi.fn()
    const gate = held()
    const { session } = mount({ runner: gate.runner, bus: { dispatch } })
    await search()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Cancel search/ }))
    })
    expect(session.getState().status).toBe('cancelled')
    expect(screen.getByText('Search cancelled')).toBeInTheDocument()
    expect(screen.getByText(/before anything was verified. The document is unchanged/)).toBeInTheDocument()
    expect(dispatch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Search again' })).toBeInTheDocument()
  })

  it('keeps whatever was verified before the stop as explicitly partial results', async () => {
    const gate = held()
    const { session } = mount({ runner: gate.runner })
    await search()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Cancel search/ }))
    })
    // The inline fallback is synchronous, so a late result always belongs to a
    // run the operator already stopped.
    await act(async () => gate.release(realResult))
    expect(session.getState().status).toBe('cancelled')
    expect(screen.getByText(/proposals below are what had been found/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /proposals \(partial\)/ })).toBeInTheDocument()
  })
})

describe('failure', () => {
  it('reports a transport failure as an alert with the reason and a way forward', async () => {
    const runner: RefinementRunner = () => Promise.reject(new Error('The refinement worker failed to start.'))
    mount({ runner })
    await search()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/The search failed/)).toBeInTheDocument()
    expect(within(alert).getByText('The refinement worker failed to start.')).toBeInTheDocument()
    expect(within(alert).getByText(/The document was not touched/)).toBeInTheDocument()
  })

  it('refuses to search an empty scope with a reason rather than doing nothing', async () => {
    const session = new RefinementSession({ tickMs: 0, runner: resolved(realResult) })
    await act(async () => {
      await session.run(fixtureDoc, [])
    })
    expect(session.getState().status).toBe('error')
    expect(session.getState().error).toMatch(/Nothing is selected/)
  })
})

describe('proposals', () => {
  it('lists ranked proposals and names what each one cost', async () => {
    mount()
    await search()
    const top = ranked()[0]
    expect(screen.getByRole('heading', { name: `${ranked().length} proposals` })).toBeInTheDocument()
    const card = screen.getByRole('button', { name: `Accept proposal 1: ${top.label}` }).closest('li') as HTMLElement
    for (const regression of top.regressions) {
      const label = objectiveList.find((objective) => objective.id === regression)!.label
      expect(within(card).getByText(new RegExp(`Cost: ${label}`))).toBeInTheDocument()
    }
    expect(top.regressions.length).toBeGreaterThan(0)
  })

  it('shows the complete metric vector for the proposal under review', async () => {
    mount()
    await search()
    const table = screen.getByRole('table')
    expect(within(table).getByText(/Full metric vector/)).toBeInTheDocument()
    for (const objective of objectiveList) {
      expect(within(table).getAllByText(objective.label).length).toBeGreaterThan(0)
    }
    // Every axis is present, including the ones that did not move.
    expect(within(table).getAllByRole('row')).toHaveLength(objectiveList.length + 1)
  })

  it('selects the proposal’s changed parts when a proposal is chosen', async () => {
    const { spy } = mount()
    await search()
    const second = ranked()[1]
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Proposal 2: ${second.label}, ${second.strategy}, score ${second.score.toFixed(2)}` }))
    })
    expect(spy.selected.at(-1)).toEqual(second.changedPartIds)
  })

  it('says so plainly when the search improved nothing', async () => {
    mount({ runner: resolved({ ...realResult, proposals: [] }) })
    await search()
    expect(screen.getByText('No proposal improved this region')).toBeInTheDocument()
    expect(screen.getByText(/Widen the selection/)).toBeInTheDocument()
  })

  it('marks a budget-exhausted result as partial rather than complete', async () => {
    mount({
      runner: resolved({ ...realResult, report: { ...realResult.report, budgetExhausted: true } }),
    })
    await search()
    expect(screen.getByText('Budget expired')).toBeInTheDocument()
    expect(screen.getByText(/not the whole search/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: `${ranked().length} proposals` })).toBeInTheDocument()
  })

  it('surfaces the guards’ own refusals with their codes', async () => {
    const refusal: RefinementProposalV1 = {
      ...ranked()[0],
      id: 'rj_test',
      status: 'rejected',
      operations: [],
      rejection: {
        code: 'PROTECTED_PART',
        reason: '1 part in the selection cannot be changed: p007 is marked protected in the document.',
        partIds: ['p007'],
      },
    }
    mount({ runner: resolved({ ...realResult, proposals: [...realResult.proposals, refusal] }) })
    await search()
    expect(screen.getByRole('heading', { name: 'Refused by the guards (1)' })).toBeInTheDocument()
    expect(screen.getByText('PROTECTED_PART')).toBeInTheDocument()
    expect(screen.getByText(/p007 is marked protected/)).toBeInTheDocument()
  })
})

describe('accept', () => {
  it('commits one transaction through the bus at the proposal’s base revision', async () => {
    const engine = new CadEngine(fixtureDoc)
    const before = engine.getDocument().revision
    const { spy, session } = mount({ bus: busFor(engine) })
    await search()
    const top = ranked()[0]
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Accept proposal 1: ${top.label}` }))
    })
    expect(engine.getDocument().revision).toBe(before + 1)
    expect(engine.getSnapshot().transactions).toHaveLength(1)
    expect(engine.getSnapshot().transactions[0].operations).toHaveLength(top.operations.length)
    expect(session.getState().outcome?.kind).toBe('applied')
    expect(spy.notices.at(-1)?.kind).toBe('success')
    expect(screen.getByText('Refinement applied')).toBeInTheDocument()
  })

  it('surfaces the kernel’s own STALE_DOCUMENT as a recoverable state', async () => {
    const engine = new CadEngine(fixtureDoc)
    const { spy } = mount({ bus: busFor(engine) })
    await search()
    // Somebody else commits between the search and the accept.
    const other = engine.execute(
      'Recolour',
      [{ type: 'part.recolor', partId: 'p001', color: 4 }],
      'human',
      engine.getDocument().revision,
    )
    expect(other.ok).toBe(true)

    const top = ranked()[0]
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Accept proposal 1: ${top.label}` }))
    })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/The document moved on · STALE_DOCUMENT/)).toBeInTheDocument()
    expect(within(alert).getByText(/Expected revision 1; current revision is 2/)).toBeInTheDocument()
    expect(within(alert).getByRole('button', { name: /Search again at r/ })).toBeInTheDocument()
    expect(spy.notices.at(-1)?.kind).toBe('error')
    // The stale attempt wrote nothing beyond the unrelated commit.
    expect(engine.getSnapshot().transactions).toHaveLength(1)
  })
})

describe('reject', () => {
  it('creates no transaction and says the document is untouched', async () => {
    const dispatch = vi.fn()
    const { session } = mount({ bus: { dispatch } })
    await search()
    const top = ranked()[0]
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Reject proposal 1: ${top.label}` }))
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(session.getState().outcome?.kind).toBe('dismissed')
    expect(screen.getByText('Proposal rejected')).toBeInTheDocument()
    expect(screen.getByText(/No transaction was created/)).toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /^Accept proposal/ })).toHaveLength(ranked().length - 1)
    expect(screen.getByRole('heading', { name: `${ranked().length - 1} proposals` })).toBeInTheDocument()
  })
})

describe('the changed-part overlay', () => {
  it('paints the engine’s own overlay instructions for the selected proposal', async () => {
    mount()
    await search()
    const top = ranked()[0]
    const overlay = screen.getByRole('complementary', { name: 'Changed parts heatmap' })
    expect(within(overlay).getByText(`Changed parts · ${top.overlay.length}`)).toBeInTheDocument()
    for (const entry of top.overlay) {
      expect(within(overlay).getByText(entry.partId)).toBeInTheDocument()
    }
  })

  it('focuses a changed part in the viewport when its row is activated', async () => {
    const { spy } = mount()
    await search()
    const entry = ranked()[0].overlay[0]
    const overlay = screen.getByRole('complementary', { name: 'Changed parts heatmap' })
    await act(async () => {
      fireEvent.click(within(overlay).getByRole('button', { name: new RegExp(`^Focus ${entry.partId}`) }))
    })
    expect(spy.selected.at(-1)).toEqual([entry.partId])
    expect(spy.framed).toBe(1)
  })

  it('draws nothing at all when no proposal is under review', () => {
    mount()
    expect(screen.queryByRole('complementary', { name: 'Changed parts heatmap' })).not.toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('labels every control the panel offers', async () => {
    mount()
    expect(screen.getByRole('region', { name: 'Refine' })).toBeInTheDocument()
    expect(screen.getByLabelText('What should change')).toBeInstanceOf(HTMLTextAreaElement)
    expect(screen.getByLabelText('Effort')).toBeInstanceOf(HTMLSelectElement)
    for (const objective of objectiveList) {
      const slider = screen.getByLabelText(objective.label)
      expect(slider).toHaveAttribute('type', 'range')
      expect(slider).toHaveAccessibleDescription(new RegExp(objective.unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    await search()
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName()
    }
    expect(screen.getByRole('table')).toHaveAccessibleName(/Full metric vector/)
  })

  it('marks the proposal under review as pressed, for a screen reader', async () => {
    mount()
    await search()
    const [first, second] = ranked()
    expect(screen.getByRole('button', { name: new RegExp(`^Proposal 1: ${first.label}`), pressed: true })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Proposal 2: ${second.label}`) }))
    })
    await waitFor(() =>
      expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1),
    )
  })

  it('drives accept from the keyboard alone', async () => {
    const engine = new CadEngine(fixtureDoc)
    mount({ bus: busFor(engine) })
    await search()
    const accept = screen.getByRole('button', { name: `Accept proposal 1: ${ranked()[0].label}` })
    accept.focus()
    expect(accept).toHaveFocus()
    await act(async () => {
      fireEvent.keyDown(accept, { key: 'Enter' })
      fireEvent.click(accept)
    })
    expect(engine.getSnapshot().transactions).toHaveLength(1)
  })
})

describe('the objective reference dialog', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('is a labelled modal dialog listing every objective the engine publishes', () => {
    render(<ObjectivesDialog onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: /Objectives — what each weight buys/ })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    for (const objective of objectiveList) {
      expect(within(dialog).getByRole('heading', { name: objective.label })).toBeInTheDocument()
    }
  })

  it('takes focus on open and returns it to the opener on close', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    expect(opener).toHaveFocus()

    const view = render(<ObjectivesDialog onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Close the objective reference/ })).toHaveFocus())
    view.unmount()
    expect(opener).toHaveFocus()
  })

  it('closes on Escape and traps Tab inside itself', () => {
    const onClose = vi.fn()
    render(<ObjectivesDialog onClose={onClose} />)
    const dialog = screen.getByRole('dialog')
    const close = screen.getByRole('button', { name: /Close the objective reference/ })

    // The close button is the only focusable control, so it is both ends of the
    // cycle: Tab and Shift+Tab must both land back on it rather than escaping.
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(close).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
