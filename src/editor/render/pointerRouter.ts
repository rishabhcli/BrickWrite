/** A single arbiter for native controls, R3F handles and click selection. */
export type PointerOwner = 'none' | 'orbit' | 'select' | 'marquee' | 'placement' | 'gizmo' | 'joint' | 'section'
export const CLICK_SLOP_PX = 4
export interface HitContext {
  placementArmed?: boolean
  gizmo?: boolean
  joint?: boolean
  section?: boolean
}
export function classifyPointerDown(event: Pick<PointerEvent, 'button' | 'shiftKey' | 'altKey'>, ctx: HitContext): PointerOwner {
  if (ctx.placementArmed) return 'placement'
  if (event.button !== 0) return event.button === 1 || event.button === 2 ? 'orbit' : 'none'
  if (ctx.gizmo) return 'gizmo'
  if (ctx.joint) return 'joint'
  if (ctx.section) return 'section'
  if (event.shiftKey || event.altKey) return 'marquee'
  return 'select'
}
export const cameraOwnsPointer = (owner: PointerOwner) => owner === 'none' || owner === 'orbit'

export class PointerRouter {
  owner: PointerOwner = 'none'
  placementArmed = false
  pointerId: number | null = null
  accepts(event: Pick<PointerEvent, 'pointerId'>): boolean {
    return this.pointerId === null || event.pointerId === this.pointerId
  }
  private listeners = new Set<(owner: PointerOwner) => void>()
  private hitTests = new Set<(event: PointerEvent) => Partial<HitContext>>()
  claim(owner: PointerOwner) {
    // An armed placement always wins, including over a stale hovered gizmo.
    const next = this.placementArmed ? 'placement' : owner
    if (next === this.owner) return
    this.owner = next
    for (const listener of this.listeners) listener(next)
  }
  release(owner?: PointerOwner) {
    if (owner && this.owner !== owner) return
    this.claim('none')
  }
  setPlacement(armed: boolean) {
    this.placementArmed = armed
    if (armed || this.owner === 'placement') this.claim(armed ? 'placement' : 'none')
  }
  subscribe(listener: (owner: PointerOwner) => void) {
    this.listeners.add(listener)
    listener(this.owner)
    return () => { this.listeners.delete(listener) }
  }
  hitTest(test: (event: PointerEvent) => Partial<HitContext>) {
    this.hitTests.add(test)
    return () => { this.hitTests.delete(test) }
  }
  classify(event: PointerEvent) {
    const context: HitContext = { placementArmed: this.placementArmed }
    for (const test of this.hitTests) Object.assign(context, test(event))
    return classifyPointerDown(event, context)
  }
}
const routers = new WeakMap<HTMLCanvasElement, PointerRouter>()
export function pointerRouterFor(canvas: HTMLCanvasElement): PointerRouter {
  let router = routers.get(canvas)
  if (!router) { router = new PointerRouter(); routers.set(canvas, router) }
  return router
}

/** Installs once per canvas, before controls' bubbling listeners. Left drags
 * enter CameraControls through its rotate API only after click slop is crossed;
 * no replayed/synthetic pointerdown is needed to turn a click into an orbit. */
export function installPointerRouter(
  canvas: HTMLCanvasElement,
  router: PointerRouter,
  rotate: (dx: number, dy: number) => void,
) {
  let press: { id: number; x: number; y: number; lastX: number; lastY: number; left: boolean; button: number; manual: boolean } | null = null
  let deferredContext = false
  // TransformControls listens on ownerDocument and does not track pointer IDs.
  // Returning from our own handler cannot protect it: reject secondary input
  // before any native target/bubble handler can move or commit the active drag.
  // Native camera gestures deliberately retain all fingers for pinch/truck.
  const guardSecondaryPointer = (event: PointerEvent) => {
    if (!cameraOwnsPointer(router.owner) && !router.accepts(event)) event.stopImmediatePropagation()
  }
  const contextMenu = (event: MouseEvent) => {
    if (press?.button !== 2) return
    event.preventDefault()
    event.stopPropagation()
    deferredContext = true
  }
  const down = (event: PointerEvent) => {
    if (press && event.pointerId !== press.id) return
    router.pointerId = event.pointerId
    const classified = router.classify(event)
    // CameraControls owns native multi-touch; selection still resolves a tap on release.
    router.claim(event.pointerType === 'touch' && classified === 'select' ? 'orbit' : classified)
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY,
      left: event.button === 0, button: event.button, manual: router.owner === 'select' }
    if (router.owner !== 'none') {
      try { canvas.setPointerCapture(event.pointerId) } catch { /* synthetic tests / detached canvas */ }
    }
  }
  const move = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id || !press.left || !press.manual) return
    if (router.owner === 'select' && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) {
      router.claim('orbit')
    }
    if (router.owner === 'orbit') rotate(event.clientX - press.lastX, event.clientY - press.lastY)
    if (router.owner !== 'select') { press.lastX = event.clientX; press.lastY = event.clientY }
  }
  const release = (event?: Event) => {
    if (event && 'pointerId' in event && press && event.pointerId !== press.id) return
    const previous = press
    press = null
    deferredContext = false
    router.pointerId = null
    if (previous && canvas.hasPointerCapture?.(previous.id)) canvas.releasePointerCapture(previous.id)
    router.release()
  }
  const up = (event: PointerEvent) => {
    if (press && event.pointerId !== press.id) return
    const showContext = deferredContext && press?.button === 2 && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= CLICK_SLOP_PX
    deferredContext = false
    queueMicrotask(() => {
      release(event)
      // On macOS contextmenu fires on press, before pan-vs-click is knowable.
      // Deliver only that menu event after an actual click; never fake pointer events.
      if (showContext) canvas.dispatchEvent(new MouseEvent('contextmenu', {
        clientX: event.clientX, clientY: event.clientY, button: 2, bubbles: true, cancelable: true,
      }))
    })
  }
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') release() }
  const guardedEvents = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const
  for (const type of guardedEvents) canvas.ownerDocument.addEventListener(type, guardSecondaryPointer, true)
  canvas.addEventListener('contextmenu', contextMenu, true)
  canvas.addEventListener('pointerdown', down, true)
  canvas.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', release)
  canvas.addEventListener('lostpointercapture', release)
  window.addEventListener('blur', release)
  window.addEventListener('keydown', key, true)
  return () => {
    for (const type of guardedEvents) canvas.ownerDocument.removeEventListener(type, guardSecondaryPointer, true)
    canvas.removeEventListener('contextmenu', contextMenu, true)
    canvas.removeEventListener('pointerdown', down, true)
    canvas.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', release)
    canvas.removeEventListener('lostpointercapture', release)
    window.removeEventListener('blur', release)
    window.removeEventListener('keydown', key, true)
    release()
  }
}
