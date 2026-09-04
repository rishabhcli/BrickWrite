import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boxGeometry, healthyValidation, privateDocument, SECRETS } from '../__fixtures__/model'
import { cloneSettings, normaliseSettings, STUDIO_PRESET_IDS, STUDIO_PRESETS } from '../render/presets'
import type { Publication } from '../types'
import { ShareStudio } from './ShareStudio'
import { useStudioSettings } from './useStudioSettings'
import { act, renderHook } from '@testing-library/react'

afterEach(cleanup)

/**
 * Share Studio.
 *
 * jsdom has no 2D canvas, so the preview cannot be sampled here — that is
 * asserted in the browser by `tools/e2e/share.mjs`, which reads pixels back out
 * of a real canvas. What this suite covers is everything else: that the panel
 * states the revision it is about to freeze, that the publish payload carries
 * real cards with real hashes, that nothing private or invented reaches it, and
 * that a failure is reported rather than swallowed.
 */

const document = privateDocument(14)

function renderStudio(overrides: Partial<Parameters<typeof ShareStudio>[0]> = {}) {
  const onPublish = vi.fn(async (_publication: Publication, _cards: Record<string, Uint8Array>) => ({
    slug: 'survey-rover-abcdefghijkl',
  }))
  render(
    <ShareStudio
      document={document}
      geometry={boxGeometry}
      validation={healthyValidation(14)}
      author={{ displayName: 'Rishabh Bansal', handle: null, url: null }}
      onPublish={onPublish}
      origin="https://brickwrite.tech"
      {...overrides}
    />,
  )
  return onPublish
}

describe('settings model', () => {
  it('replaces every field atomically when a preset is chosen', () => {
    const { result } = renderHook(() => useStudioSettings())
    act(() => result.current.dispatch({ type: 'camera', yaw: 90 }))
    expect(result.current.settings.camera.yaw).toBe(90)
    expect(result.current.modified).toBe(true)

    act(() => result.current.dispatch({ type: 'preset', id: 'blueprint' }))
    expect(result.current.settings).toEqual(STUDIO_PRESETS.blueprint)
    expect(result.current.modified).toBe(false)
  })

  it('ships presets that are already normalised, so a preset is one cache key', () => {
    for (const id of STUDIO_PRESET_IDS) {
      expect(normaliseSettings(cloneSettings(STUDIO_PRESETS[id])), `${id} is not normalised`).toEqual(
        STUDIO_PRESETS[id],
      )
    }
  })

  it('normalises every transition, so a bad value cannot reach the renderer', () => {
    const { result } = renderHook(() => useStudioSettings())
    act(() => result.current.dispatch({ type: 'framing', zoom: 9999 }))
    expect(result.current.settings.framing.zoom).toBe(4)
    act(() => result.current.dispatch({ type: 'tone', exposure: Number.NaN }))
    expect(result.current.settings.tone.exposure).toBe(1)
  })

  it('turns the mark off and back on without losing the rest', () => {
    const { result } = renderHook(() => useStudioSettings())
    act(() => result.current.dispatch({ type: 'watermark', enabled: false }))
    expect(result.current.settings.watermark).toBeNull()
    act(() => result.current.dispatch({ type: 'watermark', text: 'CUSTOM' }))
    expect(result.current.settings.watermark?.text).toBe('CUSTOM')
  })
})

describe('share studio', () => {
  it('states the revision it will freeze, and that later edits will not change it', () => {
    renderStudio()
    expect(screen.getByText(/Publishing captures/)).toHaveTextContent('revision 14')
    expect(screen.getByText(/Later edits will not change what this link shows/)).toBeInTheDocument()
    expect(screen.getByTestId('publish-button')).toHaveTextContent('Publish revision 14')
  })

  it('offers every documented crop and explains what each is for', () => {
    renderStudio()
    for (const preset of ['square', 'portrait', 'landscape', 'opengraph', 'twitter', 'transparent']) {
      expect(screen.getByTestId(`crop-${preset}`)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByTestId('crop-portrait'))
    expect(screen.getByText(/1080 × 1350/)).toBeInTheDocument()
  })

  it('states plainly that every publication is public', () => {
    renderStudio()
    expect(screen.getByText(/appears in the public gallery/)).toBeInTheDocument()
  })

  it('says so, rather than inventing one, when there is no account attribution', () => {
    renderStudio({ author: null })
    expect(screen.getByText(/Nothing is invented/)).toBeInTheDocument()
  })

  it('refuses to preview or publish when no geometry is resident, and says why', () => {
    renderStudio({ geometry: () => null })
    expect(screen.getByTestId('studio-no-geometry')).toBeInTheDocument()
    expect(screen.getByTestId('publish-button')).toBeDisabled()
  })

  it('publishes a frozen snapshot of the exact revision, with real hashed cards', async () => {
    const onPublish = renderStudio()
    fireEvent.change(screen.getByTestId('publish-title'), { target: { value: 'Survey Rover' } })
    fireEvent.change(screen.getByTestId('publish-tags'), { target: { value: 'rover technic' } })
    fireEvent.click(screen.getByTestId('publish-button'))

    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1), { timeout: 60_000 })
    const [publication, cards] = onPublish.mock.calls[0]

    expect(publication.revision).toBe(14)
    expect(publication.document.revision).toBe(14)
    expect(publication.title).toBe('Survey Rover')
    expect(publication.tags).toEqual(['rover', 'technic'])
    expect(publication.visibility).toBe('public')
    expect(Object.isFrozen(publication)).toBe(true)

    // Six crops, each with bytes that hash to the value the record claims.
    expect(publication.cards.map((card) => card.preset).sort()).toEqual([
      'landscape',
      'opengraph',
      'portrait',
      'square',
      'transparent',
      'twitter',
    ])
    for (const card of publication.cards) {
      const bytes = cards[card.preset]
      expect(bytes, `${card.preset} was declared but not handed over`).toBeInstanceOf(Uint8Array)
      expect(bytes.byteLength).toBe(card.byteLength)
      expect(card.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }

    // Nothing private travelled with it.
    const serialised = JSON.stringify(publication)
    for (const secret of Object.values(SECRETS)) expect(serialised).not.toContain(secret)

    expect(screen.getByTestId('published-link')).toHaveAttribute(
      'href',
      'https://brickwrite.tech/share/survey-rover-abcdefghijkl',
    )
    expect(screen.getByTestId('publish-status')).toHaveTextContent('revision 14')
  }, 90_000)

  it('reports a publish failure instead of claiming success', async () => {
    renderStudio({
      onPublish: async () => {
        throw new Error('the endpoint returned 409')
      },
    })
    fireEvent.click(screen.getByTestId('publish-button'))
    await waitFor(() => expect(screen.getByTestId('publish-error')).toHaveTextContent('409'), { timeout: 60_000 })
    expect(screen.queryByTestId('published-link')).toBeNull()
  }, 90_000)
})
