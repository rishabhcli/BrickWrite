// `tsconfig.app.json` type-checks `.test.tsx` (its exclude list only names
// `.test.ts`), so the jest-dom matcher augmentation is imported here as well as
// in the shared setup file. The import is idempotent at runtime.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CadEngine } from '../cad/engine'
import { createBlankDocument } from '../cad/sample'
import type { ModelDocument } from '../cad/types'
import type { WorkbenchApi } from '../editor/workbench'
import { compileBriefDeterministically } from './brief'
import { CompareDialog } from './CompareDialog'
import { GenerationEngine, type GenerationRun } from './engine'
import { GeneratePanel } from './GeneratePanel'
import { GenerationStatus } from './GenerationStatus'
import type { Candidate, PhaseEvent } from './phases'
import { CANDIDATE_METRICS, GenerationSession, generationBusFor, type GenerationRunner } from './session'
import { createTestModelProvider } from './testing'

/**
 * The Generate panel, against a real pipeline.
 *
 * The candidates reviewed here were produced by the actual four-phase pipeline
 * over a real brief, with the deterministic model double standing in for the
 * network and the kernel real throughout — so their metric vectors, their
 * operations and their build orders are the ones the product would show. What
 * the tests control is the *timing* and the *transport*: a runner a test can
 * hold open is the only way to assert the streaming and cancel states, and an
 * injected `fetch` is the only way to assert what the panel says when the model
 * route is not there.
 */

afterEach(cleanup)

const PROMPT = 'a small 8 x 4 stud red kiosk under 90 parts'

let realRun: GenerationRun
let realPhases: Array<{ event: PhaseEvent; index: number }>

beforeAll(async () => {
  const brief = compileBriefDeterministically(PROMPT)
  const engine = new GenerationEngine({ provider: createTestModelProvider() })
  realPhases = []
  realRun = await engine.generate(brief, {
    base: createBlankDocument('generation panel test'),
    count: 2,
    onPhase: (event, index) => realPhases.push({ event, index }),
  })
  if (!realRun.candidates.length) throw new Error('The fixture brief produced no accepted candidate.')
}, 60_000)

const replay = (run?: GenerationRun): GenerationRunner => async (input) => {
  for (const { event, index } of realPhases) input.onPhase(event, index)
  return run ?? realRun
}

const holdOpen = (): { runner: GenerationRunner; emit: (count: number) => void; settle: () => void; fail: (cause: unknown) => void } => {
  let resolveRun: (run: GenerationRun) => void = () => {}
  let rejectRun: (cause: unknown) => void = () => {}
  let onPhase: ((event: PhaseEvent, index: number) => void) | null = null
  const runner: GenerationRunner = (input) => {
    onPhase = input.onPhase
    input.onStage('massing')
    return new Promise<GenerationRun>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })
  }
  return {
    runner,
    emit: (count) => {
      for (const { event, index } of realPhases.slice(0, count)) onPhase?.(event, index)
    },
    settle: () => resolveRun(realRun),
    fail: (cause) => rejectRun(cause),
  }
}

const ndjson = (lines: unknown[], status = 200) =>
  new Response(lines.map((line) => JSON.stringify(line)).join('\n'), { status })

interface ApiSpy {
  notices: Array<{ kind: string; title: string; detail: string }>
  modals: Array<string | null>
}

function Harness({
  session,
  document: doc,
  spy,
}: {
  session: GenerationSession
  document: ModelDocument
  spy: ApiSpy
}) {
  const [selection] = useState<readonly string[]>([])
  const api: WorkbenchApi = {
    snapshot: { document: doc, selection: [] } as unknown as WorkbenchApi['snapshot'],
    selection,
    tool: 'select',
    activeColor: 15,
    renderMode: 'beauty',
    cameraView: 'isometric',
    placement: null,
    online: true,
    hiddenPartIds: new Set<string>(),
    activeModal: null,
    select: () => {},
    setTool: () => {},
    setActiveColor: () => {},
    setRenderMode: () => {},
    setCameraView: () => {},
    frameSelection: () => {},
    armPart: () => true,
    runCapability: () => true,
    execute: () => true,
    notify: (notice) => spy.notices.push(notice),
    openModal: (id) => spy.modals.push(id),
  }
  return (
    <>
      <GeneratePanel api={api} session={session} />
      <GenerationStatus session={session} />
    </>
  )
}

interface MountOptions {
  runner?: GenerationRunner
  /** Use GenerationSession's real provider-backed runner instead of the fast fixture replay. */
  useDefaultRunner?: boolean
  briefRunner?: ConstructorParameters<typeof GenerationSession>[0] extends infer O
    ? O extends { briefRunner?: infer B }
      ? B
      : never
    : never
  bus?: ConstructorParameters<typeof GenerationSession>[0] extends infer O
    ? O extends { bus?: infer B }
      ? B
      : never
    : never
  client?: ConstructorParameters<typeof GenerationSession>[0] extends infer O
    ? O extends { client?: infer C }
      ? C
      : never
    : never
  document?: ModelDocument
}

const mount = (options: MountOptions = {}) => {
  const spy: ApiSpy = { notices: [], modals: [] }
  const engine = new CadEngine(options.document ?? createBlankDocument('panel host'))
  const session = new GenerationSession({
    tickMs: 0,
    ...(options.useDefaultRunner ? {} : { runner: options.runner ?? replay() }),
    bus: options.bus ?? generationBusFor(engine),
    ...(options.briefRunner ? { briefRunner: options.briefRunner } : {}),
    ...(options.client ? { client: options.client } : {}),
  })
  const view = render(<Harness session={session} document={engine.getDocument()} spy={spy} />)
  return { session, spy, view, engine }
}

const localBrief = () => ({
  brief: compileBriefDeterministically(PROMPT),
  method: 'model' as const,
  provenance: { provider: 'anthropic', model: 'claude-sonnet-5', promptHash: 'abc', seed: 0, createdAt: '' },
  notes: [],
})

const type = (text: string) =>
  fireEvent.change(screen.getByLabelText('What should be built'), { target: { value: text } })

const compile = async () => {
  type(PROMPT)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Compile brief/ }))
  })
}

/** Settles the one conflict the fixture brief always carries. */
const settleConflicts = () => {
  for (const radio of screen.queryAllByRole('radio', { name: 'Keep the reading above.' })) {
    fireEvent.click(radio)
  }
}

const generate = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Generate 3/ }))
  })
}

// ---------------------------------------------------------------------------

describe('the empty state', () => {
  it('explains the flow instead of showing a bare prompt box', () => {
    mount()
    expect(screen.getByRole('region', { name: 'Generate' })).toBeInTheDocument()
    expect(screen.getByText(/Describe it, then check the brief/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing is written until you accept a ghost/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Compile brief/ })).toBeDisabled()
  })

  it('draws no status readout while nothing is happening', () => {
    mount()
    expect(screen.queryByText(/Generating/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Compiling brief/)).not.toBeInTheDocument()
  })
})

describe('compiling the brief', () => {
  it('reads the brief back from /api/brief as editable fields', async () => {
    const brief = compileBriefDeterministically(PROMPT)
    const fetchImpl = vi.fn(async () =>
      ndjson([
        { type: 'accepted', requestId: 'r1' },
        { type: 'result', value: brief, provenance: { provider: 'anthropic', model: 'claude-sonnet-5', promptHash: 'h', seed: 0, createdAt: '' }, usage: { inputTokens: 1, outputTokens: 2 } },
      ]),
    ) as unknown as typeof fetch
    mount({ client: { fetchImpl } })
    await compile()

    expect(fetchImpl).toHaveBeenCalledWith('/api/brief', expect.objectContaining({ method: 'POST' }))
    expect(screen.getByLabelText('Subject')).toHaveValue(brief.subject)
    expect(screen.getByLabelText('Envelope width in studs')).toHaveValue(8)
    expect(screen.getByLabelText('Envelope depth in studs')).toHaveValue(4)
    expect(screen.getByLabelText('Part budget')).toHaveValue(90)
    expect(screen.getByLabelText('Scale')).toHaveValue('unspecified')
    expect(screen.getByText(/compiled by claude-sonnet-5/)).toBeInTheDocument()
    // The phrase each field was read from travels with it.
    expect(screen.getByText('“under 90 parts”')).toBeInTheDocument()
  })

  it('says precisely why the route did not answer, and never invents a brief', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'no_api_key', detail: 'ANTHROPIC_API_KEY is not set on the generation service.' }), { status: 503 }),
    ) as unknown as typeof fetch
    mount({ client: { fetchImpl } })
    await compile()

    expect(screen.getByText('/api/brief is not available')).toBeInTheDocument()
    expect(screen.getByText('ANTHROPIC_API_KEY is not set on the generation service.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument()
  })

  it('reports an unreachable route with the reason the fetch gave', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    mount({ client: { fetchImpl } })
    await compile()
    expect(screen.getByText('/api/brief is not available')).toBeInTheDocument()
    expect(screen.getByText(/could not be reached: Failed to fetch/)).toBeInTheDocument()
  })

  it('offers the rule-based compiler as an explicit, labelled choice', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'no_api_key', detail: 'no key' }), { status: 503 }),
    ) as unknown as typeof fetch
    const { session } = mount({ client: { fetchImpl } })
    await compile()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compile here from rules' }))
    })
    expect(screen.getByText('compiled from rules')).toBeInTheDocument()
    expect(screen.getByText(/No model read this request/)).toBeInTheDocument()
    expect(session.getState().briefMethod).toBe('deterministic')
    expect(screen.getByLabelText('Part budget')).toHaveValue(90)
  })
})

describe('conflicts', () => {
  it('blocks generation until every contradiction is settled by hand', async () => {
    mount({ briefRunner: async () => localBrief() })
    await compile()
    expect(screen.getByText('1 contradiction to settle')).toBeInTheDocument()
    expect(screen.getByText(/Generation waits on envelopeStuds/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate/ })).toBeDisabled()
    expect(screen.getByText(/no height; 6 studs was derived/)).toBeInTheDocument()
  })

  it('takes “keep the compiler’s reading” as a real, recorded decision', async () => {
    const { session } = mount({ briefRunner: async () => localBrief() })
    await compile()
    fireEvent.click(screen.getByRole('radio', { name: 'Keep the reading above.' }))
    expect(session.getState().conflictChoices).toEqual({ envelopeStuds: 'compiler' })
    expect(screen.getByRole('button', { name: /Generate/ })).toBeEnabled()
    expect(screen.getByText('Resolved · envelopeStuds')).toBeInTheDocument()
  })

  it('treats editing the disputed field as settling it', async () => {
    const { session } = mount({ briefRunner: async () => localBrief() })
    await compile()
    fireEvent.change(screen.getByLabelText('Envelope height in studs'), { target: { value: '10' } })
    expect(session.getState().conflictChoices).toEqual({ envelopeStuds: 'operator' })
    expect(session.getState().brief?.envelopeStuds).toEqual([8, 10, 4])
    expect(session.getState().brief?.evidence.envelopeStuds).toMatch(/operator edit/)
    expect(screen.getByRole('button', { name: /Generate/ })).toBeEnabled()
  })
})

describe('streaming the phases', () => {
  it('reports per-phase progress from the pipeline as it arrives', async () => {
    const gate = holdOpen()
    mount({ briefRunner: async () => localBrief(), runner: gate.runner })
    await compile()
    settleConflicts()
    await generate()

    const bar = screen.getByRole('progressbar', { name: 'Generation phase progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '12')

    await act(async () => gate.emit(3))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
    expect(screen.getByText(/packing done/)).toBeInTheDocument()
    expect(screen.getByText(/Server: massing/)).toBeInTheDocument()
    // The status bar carries the same fact where the dock cannot be seen.
    expect(screen.getByText(/Generating 1\/3/)).toBeInTheDocument()
    await act(async () => gate.settle())
  })

  it('marks phases done, active and pending rather than animating a guess', async () => {
    const gate = holdOpen()
    mount({ briefRunner: async () => localBrief(), runner: gate.runner })
    await compile()
    settleConflicts()
    await generate()
    await act(async () => gate.emit(2))
    expect(screen.getByText('massing').closest('li')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText('skeleton').closest('li')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText('packing').closest('li')).toHaveAttribute('data-state', 'active')
    expect(screen.getByText('detail').closest('li')).toHaveAttribute('data-state', 'pending')
    await act(async () => gate.settle())
  })
})

describe('cancel', () => {
  it('stops the run and leaves the document exactly as it was', async () => {
    const gate = holdOpen()
    const { session, engine } = mount({ briefRunner: async () => localBrief(), runner: gate.runner })
    await compile()
    settleConflicts()
    await generate()
    await act(async () => gate.emit(4))

    const revisionBefore = engine.getDocument().revision
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Cancel generation/ }))
    })

    expect(session.getState().runPhase).toBe('cancelled')
    expect(screen.getByText('Generation cancelled')).toBeInTheDocument()
    expect(screen.getByText(/no transaction was created and no ghost is left over/)).toBeInTheDocument()
    expect(engine.getDocument().revision).toBe(revisionBefore)
    expect(engine.getSnapshot().transactions).toHaveLength(0)
    expect(engine.getSnapshot().proposals).toHaveLength(0)
    await act(async () => gate.settle())
    expect(session.getState().runPhase).toBe('cancelled')
  })
})

describe('provider honesty', () => {
  it('names the unavailable route and offers the deterministic path as a choice', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/brief')) {
        return ndjson([{ type: 'result', value: compileBriefDeterministically(PROMPT) }])
      }
      return new Response(JSON.stringify({ error: 'model_provider_unavailable', detail: 'The generation service has no credential configured.' }), { status: 503 })
    }) as unknown as typeof fetch
    const { session } = mount({ client: { fetchImpl }, useDefaultRunner: true })
    await compile()
    settleConflicts()
    await generate()

    await waitFor(() => expect(screen.getByText('/api/generate is not available')).toBeInTheDocument())
    expect(screen.getByText('The generation service has no credential configured.')).toBeInTheDocument()
    expect(screen.getByText(/No candidate was invented in its place/)).toBeInTheDocument()
    expect(session.getState().run).toBeNull()
    expect(screen.queryByRole('button', { name: /Preview candidate/ })).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate without the model' }))
    })
    await waitFor(() => expect(session.getState().runPhase).toBe('ready'))
    expect(session.getState().usedModel).toBe(false)
    expect(screen.getByText('deterministic')).toBeInTheDocument()
  }, 30_000)

  it('reports a generation failure as an alert without touching the document', async () => {
    const gate = holdOpen()
    const { engine } = mount({ briefRunner: async () => localBrief(), runner: gate.runner })
    await compile()
    settleConflicts()
    await generate()
    await act(async () => gate.fail(new Error('The realiser could not resolve part 3001.')))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('/api/generate failed')).toBeInTheDocument()
    expect(within(alert).getByText('The realiser could not resolve part 3001.')).toBeInTheDocument()
    expect(engine.getSnapshot().transactions).toHaveLength(0)
  })

  it('says when the gates refused everything rather than showing an empty list', async () => {
    mount({
      briefRunner: async () => localBrief(),
      runner: replay({
        ...realRun,
        candidates: [],
        rejected: realRun.candidates.map((candidate) => ({ candidate, failures: ['2 collision(s) remain in the candidate'] })),
      }),
    })
    await compile()
    settleConflicts()
    await generate()
    expect(screen.getByText('No candidate passed the hard gates')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was invented to fill the gap/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Refused by the hard gates/ })).toBeInTheDocument()
    expect(screen.getAllByText('2 collision(s) remain in the candidate').length).toBeGreaterThan(0)
  })
})

describe('candidates', () => {
  const ready = async () => {
    const mounted = mount({ briefRunner: async () => localBrief() })
    await compile()
    settleConflicts()
    await generate()
    return mounted
  }

  it('lists every candidate with the metric vector the engine measured', async () => {
    await ready()
    expect(screen.getByRole('heading', { name: new RegExp(`${realRun.candidates.length} candidates`) })).toBeInTheDocument()
    const first = realRun.candidates[0]
    const card = screen.getByRole('button', { name: new RegExp(`^Candidate 1: ${first.strategy}`) }).closest('li') as HTMLElement
    for (const key of ['partCount', 'distinctElements', 'collisionCount', 'componentCount', 'buildOrderValid', 'withinBudget', 'supportMarginLdu', 'rarePartCount']) {
      const row = CANDIDATE_METRICS.find((entry) => entry.key === key)!
      expect(within(card).getByText(row.label)).toBeInTheDocument()
      expect(within(card).getByText(row.value(first.metrics))).toBeInTheDocument()
    }
  })

  it('reports how many of the candidates are structurally distinct', async () => {
    await ready()
    expect(
      screen.getByRole('heading', { name: new RegExp(`${realRun.distinctHashes} distinct structure`) }),
    ).toBeInTheDocument()
  })

  it('previews a candidate as a ghost without moving the revision', async () => {
    const { engine, session } = await ready()
    const before = engine.getDocument().revision
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 1/ })[0])
    })
    expect(engine.getDocument().revision).toBe(before)
    expect(engine.getSnapshot().transactions).toHaveLength(0)
    expect(engine.getSnapshot().proposals).toHaveLength(1)
    expect(session.getState().ghost?.collisions).toBe(0)
    expect(screen.getByText(/The kernel validated it and found 0 collisions/)).toBeInTheDocument()
    // And the status bar says a ghost is on screen.
    expect(screen.getByText(/Ghost candidate/)).toBeInTheDocument()
  })

  it('withdraws the ghost when review is abandoned, creating no transaction', async () => {
    const { engine } = await ready()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 1/ })[0])
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Discard ghost/ }))
    })
    expect(engine.getSnapshot().proposals).toHaveLength(0)
    expect(engine.getSnapshot().transactions).toHaveLength(0)
    expect(screen.queryByText(/Ghost candidate/)).not.toBeInTheDocument()
  })

  it('swaps one ghost for another rather than stacking them', async () => {
    const { engine } = await ready()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 1/ })[0])
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 2/ })[0])
    })
    expect(engine.getSnapshot().proposals).toHaveLength(1)
  })

  it('commits the reviewed candidate as one transaction at the ghost’s revision', async () => {
    const { engine, spy, session } = await ready()
    const before = engine.getDocument().revision
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 1/ })[0])
    })
    const ghost = session.getState().ghost!
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add to model/ }))
    })
    const transactions = engine.getSnapshot().transactions
    expect(transactions).toHaveLength(1)
    expect(transactions[0].baseRevision).toBe(ghost.baseRevision)
    expect(engine.getDocument().revision).toBe(before + 1)
    expect(Object.keys(engine.getDocument().parts)).toHaveLength(realRun.candidates[0].metrics.partCount)
    expect(engine.getSnapshot().proposals).toHaveLength(0)
    expect(spy.notices.at(-1)?.kind).toBe('success')
    expect(screen.getByText('Candidate added')).toBeInTheDocument()
  })

  it('surfaces STALE_DOCUMENT as a recoverable state when the model moves under the ghost', async () => {
    const { engine, spy } = await ready()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 1/ })[0])
    })
    // Somebody else commits between the preview and the accept.
    const document = engine.getDocument()
    const anyPart = Object.values(document.parts)[0]
    const other = anyPart
      ? engine.execute('Recolour', [{ type: 'part.recolor', partId: anyPart.id, color: 4 }], 'human', document.revision)
      : engine.execute('Rename', [{ type: 'document.rename', name: 'moved on' }], 'human', document.revision)
    expect(other.ok).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add to model/ }))
    })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/The document moved on · STALE_DOCUMENT/)).toBeInTheDocument()
    expect(within(alert).getByText(/Reread the changed region/)).toBeInTheDocument()
    expect(spy.notices.at(-1)?.kind).toBe('error')
    expect(engine.getSnapshot().transactions).toHaveLength(1)
  })

  it('refuses to commit a ghost the kernel found collisions in', async () => {
    const dispatch = vi.fn()
    const candidate = realRun.candidates[0]
    const bus = {
      preflight: () => ({
        ok: true as const,
        value: {
          id: 'proposal_x',
          label: 'ghost',
          author: 'agent' as const,
          baseRevision: 1,
          createdAt: '',
          operations: [],
          previewDocument: candidate.document,
          validation: { collisions: [{}, {}] } as never,
          status: 'pending' as const,
        },
      }),
      dispatch,
      withdraw: () => {},
    }
    mount({ briefRunner: async () => localBrief(), bus })
    await compile()
    settleConflicts()
    await generate()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 1/ })[0])
    })
    expect(screen.getByRole('button', { name: /Add to model/ })).toBeDisabled()
    expect(screen.getByText(/found 2 collisions/)).toBeInTheDocument()
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('the comparison dialog', () => {
  it('puts every candidate against every measured axis', () => {
    render(
      <CompareDialog
        candidates={realRun.candidates}
        selectedId={realRun.candidates[0].id}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: 'Candidates side by side' })
    for (const row of CANDIDATE_METRICS) {
      expect(
        within(dialog)
          .getAllByRole('rowheader', { name: row.label })
          .find((header) => header.getAttribute('scope') === 'row'),
      ).toBeInTheDocument()
    }
    for (const [index, candidate] of realRun.candidates.entries()) {
      expect(
        within(dialog).getByRole('columnheader', { name: `${index + 1} · ${candidate.strategy}` }),
      ).toBeInTheDocument()
    }
  })

  it('says so plainly when there is nothing to compare', () => {
    render(<CompareDialog candidates={[]} selectedId={null} onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/No candidate passed the hard gates, so there is nothing to compare/)).toBeInTheDocument()
  })

  it('traps focus, restores it on close, and closes on Escape', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const view = render(
      <CompareDialog candidates={realRun.candidates} selectedId={null} onSelect={() => {}} onClose={onClose} />,
    )
    const close = screen.getByRole('button', { name: 'Close the candidate comparison' })
    await waitFor(() => expect(close).toHaveFocus())

    const last = screen.getAllByRole('button').at(-1)!
    last.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})

describe('accessibility', () => {
  it('labels every control, including the brief’s own fields', async () => {
    mount({ briefRunner: async () => localBrief() })
    expect(screen.getByLabelText('What should be built')).toBeInstanceOf(HTMLTextAreaElement)
    await compile()
    for (const label of [
      'Subject',
      'Envelope width in studs',
      'Envelope height in studs',
      'Envelope depth in studs',
      'Scale',
      'Symmetry',
      'Part budget',
      'Add functions',
      'Add an LDraw colour code to the palette',
      'Add style',
      'How many candidates to generate',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument()
    }
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName()
    }
  })

  it('presents each contradiction as a named radio group', async () => {
    mount({ briefRunner: async () => localBrief() })
    await compile()
    const group = screen.getByRole('group', { name: /Decide · envelopeStuds/ })
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(within(group).getByRole('radio', { name: 'Keep the reading above.' })).not.toBeChecked()
  })

  it('marks the candidate under review as pressed', async () => {
    mount({ briefRunner: async () => localBrief() })
    await compile()
    settleConflicts()
    await generate()
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Preview candidate 1/ })[0])
    })
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
  })
})
