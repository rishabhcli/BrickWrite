import { useCallback, useMemo, useReducer } from 'react'
import {
  cloneSettings,
  DEFAULT_STUDIO_PRESET,
  normaliseSettings,
  STUDIO_PRESETS,
  type BackgroundSettings,
  type ShareStudioSettings,
  type StudioPresetId,
} from '../render/presets'

/**
 * Share Studio's settings model.
 *
 * A reducer rather than a dozen `useState` calls, because a preset change has
 * to replace *every* field atomically — a half-applied preset is a render
 * nobody chose. Every transition runs through `normaliseSettings`, so the
 * clamping that protects the card endpoint from a hostile query string also
 * protects the preview from a slider that got a bad value.
 *
 * `presetId` is remembered alongside the settings and cleared the moment
 * anything is edited, so the UI can honestly say "Studio" or "Studio, modified"
 * instead of implying a preset that no longer describes the output.
 */

export interface StudioSettingsState {
  settings: ShareStudioSettings
  presetId: StudioPresetId
  modified: boolean
}

export type StudioSettingsAction =
  | { type: 'preset'; id: StudioPresetId }
  | { type: 'camera'; yaw?: number; pitch?: number; roll?: number }
  | { type: 'framing'; padding?: number; zoom?: number; offsetX?: number; offsetY?: number }
  | { type: 'background'; background: BackgroundSettings }
  | { type: 'tone'; exposure?: number; contrast?: number; shadowLift?: number }
  | { type: 'watermark'; text?: string; opacity?: number; scale?: number; enabled?: boolean }
  | { type: 'outline'; value: boolean }
  | { type: 'supersample'; value: 1 | 2 | 3 }
  | { type: 'reset' }

const initial = (id: StudioPresetId): StudioSettingsState => ({
  settings: normaliseSettings(cloneSettings(STUDIO_PRESETS[id])),
  presetId: id,
  modified: false,
})

function reduce(state: StudioSettingsState, action: StudioSettingsAction): StudioSettingsState {
  if (action.type === 'preset') return initial(action.id)
  if (action.type === 'reset') return initial(state.presetId)

  const next = cloneSettings(state.settings)
  switch (action.type) {
    case 'camera':
      next.camera = {
        yaw: action.yaw ?? next.camera.yaw,
        pitch: action.pitch ?? next.camera.pitch,
        roll: action.roll ?? next.camera.roll,
      }
      break
    case 'framing':
      next.framing = {
        padding: action.padding ?? next.framing.padding,
        zoom: action.zoom ?? next.framing.zoom,
        offsetX: action.offsetX ?? next.framing.offsetX,
        offsetY: action.offsetY ?? next.framing.offsetY,
      }
      break
    case 'background':
      next.background = action.background
      break
    case 'tone':
      next.tone = {
        exposure: action.exposure ?? next.tone.exposure,
        contrast: action.contrast ?? next.tone.contrast,
        shadowLift: action.shadowLift ?? next.tone.shadowLift,
      }
      break
    case 'watermark': {
      if (action.enabled === false) {
        next.watermark = null
        break
      }
      const base = next.watermark ?? cloneSettings(STUDIO_PRESETS.studio).watermark!
      next.watermark = {
        ...base,
        text: action.text ?? base.text,
        opacity: action.opacity ?? base.opacity,
        scale: action.scale ?? base.scale,
      }
      break
    }
    case 'outline':
      next.outline = action.value
      break
    case 'supersample':
      next.supersample = action.value
      break
  }
  return { settings: normaliseSettings(next), presetId: state.presetId, modified: true }
}

export function useStudioSettings(presetId: StudioPresetId = DEFAULT_STUDIO_PRESET) {
  const [state, dispatch] = useReducer(reduce, presetId, initial)
  const label = useMemo(
    () => `${presetId === state.presetId ? state.presetId : state.presetId}${state.modified ? ', modified' : ''}`,
    [presetId, state.presetId, state.modified],
  )
  const set = useCallback((action: StudioSettingsAction) => dispatch(action), [])
  return { ...state, label, dispatch: set }
}
