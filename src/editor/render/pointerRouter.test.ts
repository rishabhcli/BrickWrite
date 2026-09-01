import { describe, expect, it } from 'vitest'
import { cameraOwnsPointer, classifyPointerDown, PointerRouter, CLICK_SLOP_PX } from './pointerRouter'
const left = { button: 0, shiftKey: false, altKey: false }
describe('exclusive pointer routing', () => {
  it.each([
    [{ placementArmed: true, gizmo: true, joint: true }, 'placement'],
    [{ gizmo: true, joint: true, section: true }, 'gizmo'],
    [{ joint: true, section: true }, 'joint'],
    [{ section: true }, 'section'],
    [{}, 'select'],
  ] as const)('resolves priority %j to %s', (context, owner) => {
    expect(classifyPointerDown(left, context)).toBe(owner)
  })
  it('preserves modifiers, right pan and middle dolly', () => {
    expect(classifyPointerDown({...left, shiftKey: true}, {})).toBe('marquee')
    expect(classifyPointerDown({...left, altKey: true}, {})).toBe('marquee')
    expect(classifyPointerDown({...left, button: 2}, {gizmo: true})).toBe('orbit')
    expect(classifyPointerDown({...left, button: 1}, {})).toBe('orbit')
    expect(CLICK_SLOP_PX).toBe(4)
  })
  it('only enables camera for none/orbit; an unrelated release cannot steal ownership', () => {
    const router = new PointerRouter()
    const enabled: boolean[] = []
    const unsubscribe = router.subscribe(owner => enabled.push(cameraOwnsPointer(owner)))
    router.claim('gizmo')
    router.release('section')
    expect(router.owner).toBe('gizmo')
    router.release('gizmo')
    expect(enabled).toEqual([true, false, true])
    unsubscribe()
  })
  it('armed placement outranks handles and cleanup restores the camera', () => {
    const router = new PointerRouter()
    router.setPlacement(true)
    router.claim('gizmo')
    router.release()
    expect(router.owner).toBe('placement')
    router.setPlacement(false)
    expect(router.owner).toBe('none')
    expect(cameraOwnsPointer(router.owner)).toBe(true)
  })
})

it('does not let a secondary pointer take an active gesture', () => {
  const router = new PointerRouter()
  router.pointerId = 7
  router.claim('joint')
  expect(router.accepts({pointerId: 8})).toBe(false)
  expect(router.accepts({pointerId: 7})).toBe(true)
  expect(router.owner).toBe('joint')
})

// Real DOM propagation matters: capture must classify before native controls,
// and the release must wait until committed-drag listeners have consumed it.
it('keeps native controls out of selection until slop and ignores a second pointer', async () => {
  const { installPointerRouter } = await import('./pointerRouter')
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const router = new PointerRouter()
  const deltas: number[] = []
  const uninstall = installPointerRouter(canvas, router, dx => deltas.push(dx))
  const send = (type: string, id: number, x: number) => {
    const event = new MouseEvent(type, {bubbles: true, clientX:x, clientY:10, button:0})
    Object.defineProperty(event, 'pointerId', {value:id})
    canvas.dispatchEvent(event)
  }
  send('pointerdown', 1, 10)
  expect(router.owner).toBe('select')
  send('pointermove', 1, 13)
  expect(deltas).toEqual([])
  send('pointerdown', 2, 20)
  send('pointermove', 2, 100)
  send('pointerup', 2, 100)
  await Promise.resolve()
  expect(router.owner).toBe('select')
  expect(router.pointerId).toBe(1)
  send('pointermove', 1, 18)
  expect(router.owner).toBe('orbit')
  expect(deltas).toEqual([8])
  send('pointerup', 1, 18)
  expect(router.owner).toBe('orbit')
  await Promise.resolve()
  expect(router.owner).toBe('none')
  uninstall(); canvas.remove()
})

it('defers an early context menu for right click and discards it for right pan', async () => {
  const { installPointerRouter } = await import('./pointerRouter')
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const router = new PointerRouter()
  const uninstall = installPointerRouter(canvas, router, () => {})
  let menus = 0
  canvas.addEventListener('contextmenu', () => { menus++ })
  const send = (type: string, x: number) => {
    const event = new MouseEvent(type, {bubbles:true, cancelable:true, button:2, clientX:x, clientY:10})
    Object.defineProperty(event, 'pointerId', {value:1})
    canvas.dispatchEvent(event)
  }
  send('pointerdown',10); send('contextmenu',10)
  expect(menus).toBe(0)
  send('pointerup',10); await Promise.resolve()
  expect(menus).toBe(1)
  send('pointerdown',10); send('contextmenu',10); send('pointermove',60); send('pointerup',60)
  await Promise.resolve()
  expect(menus).toBe(1)
  uninstall(); canvas.remove()
})

it('blocks secondary native TransformControls releases but preserves camera multitouch', async () => {
  const { installPointerRouter } = await import('./pointerRouter')
  const { TransformControls } = await import('three-stdlib/controls/TransformControls.js')
  const { Object3D, PerspectiveCamera } = await import('three')
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const router = new PointerRouter()
  const uninstall = installPointerRouter(canvas, router, () => {})
  const controls = new TransformControls(new PerspectiveCamera(), canvas)
  controls.attach(new Object3D())
  // Runtime fields are not all public in three-stdlib's declaration.
  const runtime = controls as unknown as { axis: string | null; dragging: boolean }
  let commits = 0
  controls.addEventListener('mouseUp', () => { commits++ })
  const send = (type: string, id: number) => {
    const event = new MouseEvent(type, {bubbles:true, cancelable:true, button:0, clientX:10, clientY:10})
    Object.defineProperty(event, 'pointerId', {value:id})
    canvas.dispatchEvent(event)
  }
  try {
    send('pointerdown', 7)
    router.claim('gizmo')
    runtime.axis = 'X'; runtime.dragging = true
    send('pointerup', 8)
    await Promise.resolve()
    expect(commits).toBe(0)
    expect(runtime.dragging).toBe(true)
    expect(router.pointerId).toBe(7)
    send('pointerup', 7)
    await Promise.resolve()
    expect(commits).toBe(1)
    expect(runtime.dragging).toBe(false)
    expect(router.owner).toBe('none')
    // A camera owner must let secondary events reach native document controls.
    let secondaryMoves = 0
    const nativeMove = () => { secondaryMoves++ }
    document.addEventListener('pointermove', nativeMove)
    try {
      router.pointerId = 7; router.claim('orbit')
      send('pointermove', 8)
      expect(secondaryMoves).toBe(1)
    } finally { document.removeEventListener('pointermove', nativeMove) }
  } finally {
    controls.dispose(); uninstall(); canvas.remove()
  }
})
