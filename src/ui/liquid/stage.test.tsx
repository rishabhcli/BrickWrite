import { cleanup, act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlassBar, GlassDock, GlassIsland, GlassSheet } from './index'
import { LiquidStage, useLiquidEnvironment, useLiquidPerformance } from './LiquidStage'
import { SETTLE_DELAY_MS } from './motion'

afterEach(cleanup)

function Probe() {
  const environment = useLiquidEnvironment()
  const report = useLiquidPerformance()
  return (
    <>
      <output data-interacting={String(environment.interacting)}>{String(environment.interacting)}</output>
      <button type="button" onClick={() => report({ interacting: true })}>
        start
      </button>
      <button type="button" onClick={() => report({ interacting: false })}>
        end
      </button>
    </>
  )
}

describe('the stage owns the only pointer listener', () => {
  let added: string[] = []
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    added = []
    // Bound before the spy replaces it. Reaching for EventTarget.prototype
    // instead throws in jsdom: the unbound method rejects `window` as not a
    // valid instance.
    const original = window.addEventListener.bind(window)
    addSpy = vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, ...rest: unknown[]) => {
      added.push(type)
      ;(original as (...args: unknown[]) => void)(type, ...rest)
    }) as never)
  })

  afterEach(() => addSpy.mockRestore())

  it('attaches exactly one pointermove handler however many surfaces are mounted', () => {
    // liquid-glass-react attaches its own per instance, each driving two
    // setState calls per event. Supplying both pointer props short-circuits
    // that path; this asserts the count that proves it stayed short-circuited.
    render(
      <LiquidStage>
        <GlassBar aria-label="one">bar</GlassBar>
        <GlassDock aria-label="two">dock</GlassDock>
        <GlassIsland aria-label="three">island</GlassIsland>
        <GlassSheet aria-label="four">sheet</GlassSheet>
      </LiquidStage>,
    )

    expect(added.filter((type) => type === 'pointermove')).toHaveLength(1)
  })
})

describe('document preferences', () => {
  it('mirrors the material preference onto the document for surfaces CSS alone must answer', () => {
    render(
      <LiquidStage>
        <span>content</span>
      </LiquidStage>,
    )
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-reduced-transparency')).toBe('false')
  })

  it('restores what it found when it unmounts', () => {
    document.documentElement.setAttribute('data-theme', 'preexisting')
    const view = render(
      <LiquidStage>
        <span>content</span>
      </LiquidStage>,
    )
    view.unmount()
    expect(document.documentElement.getAttribute('data-theme')).toBe('preexisting')
    document.documentElement.removeAttribute('data-theme')
  })
})

describe('settling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('demotes on the spot but promotes only after the gesture has been quiet', () => {
    render(
      <LiquidStage>
        <Probe />
      </LiquidStage>,
    )
    const state = () => screen.getByRole('status').dataset.interacting
    const start = screen.getByRole('button', { name: 'start' })
    const end = screen.getByRole('button', { name: 'end' })

    expect(state()).toBe('false')

    // The frame that needs the cheaper material is the one already in flight,
    // so a gesture starting is applied without waiting.
    act(() => start.click())
    expect(state()).toBe('true')

    // Reported ended. The gaps between pointer events during a slow drag must
    // not flicker the tier, so it stays interacting until the timer fires.
    act(() => end.click())
    expect(state()).toBe('true')

    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS - 1)
    })
    expect(state()).toBe('true')

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(state()).toBe('false')
  })

  it('cancels a pending promotion when the gesture resumes', () => {
    render(
      <LiquidStage>
        <Probe />
      </LiquidStage>,
    )
    const state = () => screen.getByRole('status').dataset.interacting
    act(() => screen.getByRole('button', { name: 'start' }).click())
    act(() => screen.getByRole('button', { name: 'end' }).click())
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS - 20)
    })
    act(() => screen.getByRole('button', { name: 'start' }).click())

    // Without cancelling, the old timer would fire mid-gesture and promote the
    // material back to lensed while the operator is still dragging.
    act(() => {
      vi.advanceTimersByTime(SETTLE_DELAY_MS * 2)
    })
    expect(state()).toBe('true')
  })
})

describe('adapting to a measured backdrop', () => {
  const SURFACE = { left: 100, top: 100, width: 200, height: 40 }
  let original: typeof Element.prototype.getBoundingClientRect

  beforeEach(() => {
    // jsdom implements no layout, so every box is zero and no surface would
    // ever be found to overlap anything. The stub is the layout this assertion
    // is about, not a convenience.
    original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      return { ...SURFACE, right: 300, bottom: 140, x: 100, y: 100, toJSON: () => ({}) } as DOMRect
    }
  })
  afterEach(() => {
    Element.prototype.getBoundingClientRect = original
  })

  function Reporter({ luminance }: { luminance: number }) {
    const report = useLiquidPerformance()
    return (
      <button
        type="button"
        onClick={() =>
          report({
            // One cell, covering a region the surface sits well inside.
            backdrop: { region: { left: 0, top: 0, width: 1000, height: 1000 }, cells: [luminance], columns: 1, rows: 1 },
          })
        }
      >
        report
      </button>
    )
  }

  it('takes the over-light treatment once the scene behind it is bright', () => {
    render(
      <LiquidStage>
        <Reporter luminance={0.72} />
        <GlassBar aria-label="over the model">bar</GlassBar>
      </LiquidStage>,
    )
    const bar = screen.getByLabelText('over the model')
    expect(bar.className).not.toContain('liquid-over-light')

    act(() => screen.getByRole('button', { name: 'report' }).click())
    expect(bar.className).toContain('liquid-over-light')
  })

  it('leaves a surface over a dark scene alone', () => {
    render(
      <LiquidStage>
        <Reporter luminance={0.004} />
        <GlassBar aria-label="over the void">bar</GlassBar>
      </LiquidStage>,
    )
    act(() => screen.getByRole('button', { name: 'report' }).click())
    expect(screen.getByLabelText('over the void').className).not.toContain('liquid-over-light')
  })

  it('ignores a scene it does not overlap', () => {
    function FarReporter() {
      const report = useLiquidPerformance()
      return (
        <button
          type="button"
          onClick={() =>
            report({
              // A bright scene somewhere else entirely — the docks and the
              // topbar sit beside and above the canvas, never over it.
              backdrop: { region: { left: 900, top: 900, width: 100, height: 100 }, cells: [0.9], columns: 1, rows: 1 },
            })
          }
        >
          report far
        </button>
      )
    }
    render(
      <LiquidStage>
        <FarReporter />
        <GlassBar aria-label="beside the model">bar</GlassBar>
      </LiquidStage>,
    )
    act(() => screen.getByRole('button', { name: 'report far' }).click())
    expect(screen.getByLabelText('beside the model').className).not.toContain('liquid-over-light')
  })
})

describe('surfaces without a stage', () => {
  it('fall back to the opaque material rather than assuming a capability', () => {
    // A primitive rendered outside a stage — in an isolated component test, for
    // instance — must not optimistically claim it can refract.
    render(<GlassBar aria-label="unstaged">bar</GlassBar>)
    expect(screen.getByLabelText('unstaged')).toHaveAttribute('data-tier', 'opaque')
  })
})
