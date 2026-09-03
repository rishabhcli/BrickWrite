/**
 * Keyboard contract for the CAD viewport.
 *
 * The share viewer already owns this interaction: arrows orbit, Shift is a
 * coarser step, and the canvas is a real focus stop. The editor canvas had
 * none of that. These helpers are the shared mapping so the React wiring and
 * the unit tests cannot drift.
 */

export const VIEWPORT_ORBIT_STEP_DEG = 5
export const VIEWPORT_ORBIT_COARSE_DEG = 45
export const VIEWPORT_DOLLY_STEP = 0.12
export const VIEWPORT_PITCH_LIMIT_DEG = 80

export type ViewportKeyMode = 'orbit' | 'nudge'

export interface OrbitCommand {
  readonly kind: 'orbit'
  readonly yawDeg: number
  readonly pitchDeg: number
}

export interface DollyCommand {
  readonly kind: 'dolly'
  readonly factor: number
}

export interface FrameCommand {
  readonly kind: 'frame'
}

export interface WalkCommand {
  readonly kind: 'walk'
  readonly direction: -1 | 1
  readonly extend: boolean
}

export interface NudgeCommand {
  readonly kind: 'nudge'
  readonly dx: number
  readonly dz: number
  readonly dy?: number
}

export type ViewportCommand =
  | OrbitCommand
  | DollyCommand
  | FrameCommand
  | WalkCommand
  | NudgeCommand
  | JointCommand
  | SectionCommand
  | OccludeCommand
  | PlaceCommand
  | ActCommand

export const VIEWPORT_JOINT_ROTATE_DEG = 15
export const VIEWPORT_JOINT_SLIDE_LDU = 4
export const VIEWPORT_SECTION_STEP_LDU = 8

export interface JointCommand {
  readonly kind: 'joint'
  readonly rotateDegrees: number
  readonly slideLdu: number
}

export interface SectionCommand {
  readonly kind: 'section'
  readonly offsetLdu: number
}

export interface OccludeCommand {
  readonly kind: 'occlude'
}

export interface PlaceCommand {
  readonly kind: 'place'
}

export interface ActCommand {
  readonly kind: 'act'
}

export function viewportMode(tool: 'select' | 'pan' | 'orbit' | 'move' | 'rotate' | 'connect', selectionCount: number): ViewportKeyMode {
  return (tool === 'move' || tool === 'rotate') && selectionCount > 0 ? 'nudge' : 'orbit'
}

export function commandFromViewportKey(
  key: string,
  options: { shift: boolean; mode: ViewportKeyMode; gridLdu: number; placing?: boolean },
): ViewportCommand | null {
  const orbitStep = options.shift ? VIEWPORT_ORBIT_COARSE_DEG : VIEWPORT_ORBIT_STEP_DEG
  const nudge = options.shift ? options.gridLdu * 4 : options.gridLdu

  if (key === 'Home' || key === '0') return { kind: 'frame' }
  if (options.mode === 'nudge' && (key === 'PageUp' || key === 'PageDown')) {
    return { kind: 'nudge', dx: 0, dz: 0, dy: key === 'PageUp' ? -nudge : nudge }
  }
  if (key === 'PageUp' || key === '+' || key === '=' || key === 'Add') {
    return { kind: 'dolly', factor: 1 - VIEWPORT_DOLLY_STEP }
  }
  if (key === 'PageDown' || key === '-' || key === '_' || key === 'Subtract') {
    return { kind: 'dolly', factor: 1 + VIEWPORT_DOLLY_STEP }
  }
  if (key === '[' || key === ']') {
    return { kind: 'walk', direction: key === ']' ? 1 : -1, extend: options.shift }
  }
  if (key === '\\' || key === '|') return { kind: 'occlude' }
  if (key === 'Enter') return options.placing ? { kind: 'place' } : { kind: 'act' }
  if (key === ',' || key === '<') {
    return options.shift
      ? { kind: 'joint', rotateDegrees: 0, slideLdu: -VIEWPORT_JOINT_SLIDE_LDU }
      : { kind: 'joint', rotateDegrees: -VIEWPORT_JOINT_ROTATE_DEG, slideLdu: 0 }
  }
  if (key === '.' || key === '>') {
    return options.shift
      ? { kind: 'joint', rotateDegrees: 0, slideLdu: VIEWPORT_JOINT_SLIDE_LDU }
      : { kind: 'joint', rotateDegrees: VIEWPORT_JOINT_ROTATE_DEG, slideLdu: 0 }
  }
  if (key === ';') return { kind: 'section', offsetLdu: -VIEWPORT_SECTION_STEP_LDU }
  if (key === "'") return { kind: 'section', offsetLdu: VIEWPORT_SECTION_STEP_LDU }

  if (options.mode === 'nudge') {
    const deltas: Record<string, readonly [number, number]> = {
      ArrowLeft: [-nudge, 0],
      ArrowRight: [nudge, 0],
      ArrowUp: [0, -nudge],
      ArrowDown: [0, nudge],
    }
    const delta = deltas[key]
    return delta ? { kind: 'nudge', dx: delta[0], dz: delta[1] } : null
  }

  const orbits: Record<string, readonly [number, number]> = {
    ArrowLeft: [-orbitStep, 0],
    ArrowRight: [orbitStep, 0],
    ArrowUp: [0, orbitStep],
    ArrowDown: [0, -orbitStep],
  }
  const orbit = orbits[key]
  return orbit ? { kind: 'orbit', yawDeg: orbit[0], pitchDeg: orbit[1] } : null
}

export function walkPartOrder(
  stepPartIds: readonly string[][],
  partIds: readonly string[],
  visible: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const step of stepPartIds) {
    for (const id of step) {
      if (!visible.has(id) || seen.has(id)) continue
      seen.add(id)
      order.push(id)
    }
  }
  for (const id of partIds) {
    if (!visible.has(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  return order
}

export function nextInOrder(order: readonly string[], current: string | undefined, direction: -1 | 1): string | null {
  if (!order.length) return null
  const index = current ? order.indexOf(current) : -1
  if (index < 0) return direction === 1 ? order[0]! : order[order.length - 1]!
  return order[(index + direction + order.length) % order.length]!
}

export function describeViewportCommand(command: ViewportCommand, mode: ViewportKeyMode): string {
  switch (command.kind) {
    case 'orbit':
      return `Orbit ${command.yawDeg}° yaw, ${command.pitchDeg}° pitch`
    case 'dolly':
      return command.factor < 1 ? 'Zoom in' : 'Zoom out'
    case 'frame':
      return 'Framed the model'
    case 'walk':
      return command.extend ? 'Extended the selection' : 'Moved the selection'
    case 'nudge':
      return `Nudged ${mode === 'nudge' ? 'the selection' : 'the camera'}`
    case 'joint':
      return command.slideLdu ? `Slid the joint ${command.slideLdu} LDU` : `Rotated the joint ${command.rotateDegrees}°`
    case 'section':
      return `Offset the section plane ${command.offsetLdu} LDU`
    case 'occlude':
      return 'Cycled occlusion'
    case 'place':
      return 'Placed the armed part'
    case 'act':
      return 'Acted on the focused part'
  }
}
