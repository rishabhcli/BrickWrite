import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useReducedMotion } from '../explore/motion'

/**
 * The plate.
 *
 * Every other panel on this page argues that Brickwright produces real builds.
 * This one hands the visitor a baseplate and lets them prove it with their own
 * hands: the plate starts assembling a miniature of the featured whale on its
 * own, bottom-up, in the same order a build order would call — and the moment a
 * pointer arrives it stops showing off and takes instruction instead. Click a
 * column and a brick falls onto it, squashes on the studs, and stays.
 *
 * The premise of the product in eight seconds, without a word of copy: it
 * builds, you edit.
 *
 * Nothing here is a model document. It is honest decoration — original
 * geometry, no catalog parts, no validation claims — and it is the one place
 * on the front door where the motion answers a person rather than a timer.
 */

/** Isometric half-width, half-depth and layer height of one 2 x 2 cell, in user units. */
const CELL_W = 30
const CELL_D = 14
const LAYER = 22

/** Plate extent in cells. Deliberately longer than the whale, so there is room to add to it. */
const COLUMNS = 10
const ROWS = 4
const PLATE_H = 15

type Cell = { x: number; z: number }
type Brick = { key: number; x: number; z: number; y: number; color: number; mine: boolean }

/**
 * Brick colours as [top, left, right] faces. The whale is built from the
 * featured demo's own palette; a visitor's bricks come from the warm end of it,
 * so what they added stays legible against what arrived built.
 */
const COLORS: readonly (readonly [string, string, string])[] = [
  ['#7cb2d8', '#5285a8', '#3b6a89'], // medium blue — hull
  ['#f1efe4', '#cbc8ba', '#adaa9c'], // white — foam
  ['#a9dfe8', '#7cb4bd', '#5d919b'], // trans light blue — spout
  ['#f47b52', '#c15736', '#98401f'], // studio orange
  ['#8fc46b', '#679a48', '#4e7a35'], // green
  ['#f6c445', '#c99b26', '#a17a16'], // yellow
]
const HULL = 0
const FOAM = 1
const SPOUT = 2
/** What a click places, in order. Cycling makes a run of clicks read as a build, not a smear. */
const MINE = [3, 4, 5, 3, 2, 4] as const

const project = (x: number, z: number, y: number) => ({
  sx: (x - z) * CELL_W,
  sy: (x + z) * CELL_D - y * LAYER,
})

/** The pointer lands on the plate plane; the brick then stacks on whatever is already in that column. */
function cellAt(vx: number, vy: number): Cell {
  const across = vx / CELL_W
  const into = vy / CELL_D
  return { x: Math.round((across + into) / 2), z: Math.round((into - across) / 2) }
}

const onPlate = (cell: Cell) => cell.x >= 0 && cell.x < COLUMNS && cell.z >= 0 && cell.z < ROWS

const columnKey = (x: number, z: number) => `${x}:${z}`

/**
 * A miniature of the Blue Whale Monument, in plate cells, in build order:
 * hull courses bottom-up, then the tail, then the surface pass. The real demo
 * is thousands of validated parts; this is forty-four, and it is drawn rather
 * than validated — it claims nothing the kernel would have to stand behind.
 */
function whale(): Omit<Brick, 'key' | 'mine'>[] {
  const cells: Omit<Brick, 'key' | 'mine'>[] = []
  const add = (x: number, z: number, y: number, color: number) => cells.push({ x, z, y, color })
  /** The two centre rows carry the body; the outer two are water. */
  const body = [1, 2]

  // Bottom-up, the way a build order would call it. Each course is shorter than
  // the one below and set toward the head, so the profile is a wedge — bulk
  // forward, thinning to the tail. Courses of equal length would stack into a
  // bus, which is what separates an animal from a box at this size.
  for (const x of [0, 1, 2, 3, 4, 5, 6, 7]) for (const z of body) add(x, z, 0, FOAM)
  for (const x of [0, 1, 2, 3, 4, 5]) for (const z of body) add(x, z, 1, HULL)
  for (const x of [1, 2, 3]) for (const z of body) add(x, z, 2, HULL)
  // The fluke spreads across the full depth of the plate on a narrow stock, so
  // it reads as a tail rather than another block of hull.
  for (const z of body) add(8, z, 0, HULL)
  for (const z of [0, 1, 2, 3]) add(8, z, 1, HULL)
  add(2, 1, 3, SPOUT)
  // Foam off the flanks. Three bricks are enough to say water.
  add(1, 0, 0, FOAM)
  add(4, 3, 0, FOAM)
  add(6, 0, 0, FOAM)
  return cells
}

const CORNERS = {
  back: project(-0.5, -0.5, 0),
  right: project(COLUMNS - 0.5, -0.5, 0),
  front: project(COLUMNS - 0.5, ROWS - 0.5, 0),
  left: project(-0.5, ROWS - 0.5, 0),
}

/**
 * The slab and its empty studs, built once.
 *
 * A brick lands roughly every 90ms, and each one re-renders this component. The
 * plate underneath never changes, so rebuilding its 160 studs on every landing
 * is pure waste — enough of it that assembly measured ~290ms per brick on a
 * phone-sized viewport instead of the 90ms it asks for. Hoisting the static
 * geometry out of the render path is the whole fix.
 */
const PLATE = (
  <>
    <g className="bw-plate-slab">
      <path
        d={`M${CORNERS.right.sx} ${CORNERS.right.sy}L${CORNERS.front.sx} ${CORNERS.front.sy} ${CORNERS.front.sx} ${CORNERS.front.sy + PLATE_H} ${CORNERS.right.sx} ${CORNERS.right.sy + PLATE_H}Z`}
        fill="#1d2620"
      />
      <path
        d={`M${CORNERS.left.sx} ${CORNERS.left.sy}L${CORNERS.front.sx} ${CORNERS.front.sy} ${CORNERS.front.sx} ${CORNERS.front.sy + PLATE_H} ${CORNERS.left.sx} ${CORNERS.left.sy + PLATE_H}Z`}
        fill="#151c17"
      />
      <path
        d={`M${CORNERS.back.sx} ${CORNERS.back.sy}L${CORNERS.right.sx} ${CORNERS.right.sy} ${CORNERS.front.sx} ${CORNERS.front.sy} ${CORNERS.left.sx} ${CORNERS.left.sy}Z`}
        fill="#2b3730"
      />
      <path
        d={`M${CORNERS.back.sx} ${CORNERS.back.sy}L${CORNERS.right.sx} ${CORNERS.right.sy} ${CORNERS.front.sx} ${CORNERS.front.sy} ${CORNERS.left.sx} ${CORNERS.left.sy}Z`}
        fill="none"
        stroke="#ffffff1f"
        strokeWidth="1"
      />
    </g>
    <g className="bw-plate-studs">
      {Array.from({ length: COLUMNS * ROWS }, (_, index) => {
        const x = index % COLUMNS
        const z = Math.floor(index / COLUMNS)
        return [-1, 1].flatMap((ox) =>
          [-1, 1].map((oz) => {
            const spot = project(x + ox * 0.25, z + oz * 0.25, 0)
            return <ellipse key={`${x}-${z}-${ox}-${oz}`} cx={spot.sx} cy={spot.sy} rx="5.2" ry="2.5" />
          }),
        )
      })}
    </g>
  </>
)

/** Painter's order: back cells first, then upward, so a brick never draws through its neighbour. */
const depth = (a: { x: number; z: number; y: number }, b: { x: number; z: number; y: number }) =>
  a.x + a.z - (b.x + b.z) || a.y - b.y

export function StudPlate({ paused }: { paused: boolean }) {
  const reduced = useReducedMotion()
  const still = reduced || paused
  const plan = useMemo(whale, [])
  const id = useId().replace(/:/g, '')

  // Reduced motion is handed the finished plate rather than a slower assembly:
  // the point of the panel is that bricks are placeable, and that survives.
  const [bricks, setBricks] = useState<Brick[]>(() =>
    reduced ? plan.map((cell, index) => ({ ...cell, key: index, mine: false })) : [],
  )
  const [cursor, setCursor] = useState<Cell | null>(null)
  const [taken, setTaken] = useState(reduced)
  const [shocks, setShocks] = useState<{ key: number; sx: number; sy: number }[]>([])
  const [said, setSaid] = useState('')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const ghostRef = useRef<SVGGElement | null>(null)
  const seq = useRef(plan.length)

  const heights = useMemo(() => {
    const map = new Map<string, number>()
    for (const brick of bricks) {
      const key = columnKey(brick.x, brick.z)
      map.set(key, Math.max(map.get(key) ?? 0, brick.y + 1))
    }
    return map
  }, [bricks])

  const mine = bricks.reduce((count, brick) => count + (brick.mine ? 1 : 0), 0)

  /**
   * The plate assembles itself until someone reaches for it. One brick every
   * 90ms is fast enough to finish inside a scroll and slow enough to watch.
   */
  useEffect(() => {
    if (still || taken) return
    const remaining = plan.length - bricks.filter((brick) => !brick.mine).length
    if (remaining <= 0) return
    const timer = window.setTimeout(() => {
      setBricks((current) => {
        const next = plan[current.filter((brick) => !brick.mine).length]
        if (!next) return current
        return [...current, { ...next, key: seq.current++, mine: false }]
      })
    }, 90)
    return () => window.clearTimeout(timer)
  }, [still, taken, bricks, plan])

  /** Skipping the show should not skip the whale — a paused plate is a finished one. */
  useEffect(() => {
    if (!still) return
    setBricks((current) => {
      const placed = current.filter((brick) => !brick.mine)
      if (placed.length >= plan.length) return current
      const rest = plan.slice(placed.length).map((cell) => ({ ...cell, key: seq.current++, mine: false }))
      return [...current, ...rest]
    })
  }, [still, plan])

  /** Client coordinates → user space, from the viewBox alone; the plate carries no transform. */
  const toUser = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const box = svg.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const view = svg.viewBox.baseVal
    const scale = Math.min(box.width / view.width, box.height / view.height)
    return {
      vx: (clientX - box.left - (box.width - view.width * scale) / 2) / scale + view.x,
      vy: (clientY - box.top - (box.height - view.height * scale) / 2) / scale + view.y,
    }
  }, [])

  const place = useCallback(
    (cell: Cell) => {
      if (!onPlate(cell)) return
      const y = heights.get(columnKey(cell.x, cell.z)) ?? 0
      if (y >= 6) {
        setSaid('That column is as tall as the plate takes. Try another one.')
        return
      }
      const spot = project(cell.x, cell.z, y)
      const key = seq.current++
      setTaken(true)
      setBricks((current) => [...current, { ...cell, y, key, color: MINE[mine % MINE.length], mine: true }])
      setSaid(`Brick placed at column ${cell.x + 1}, ${cell.z + 1}. ${y + 1} high.`)
      if (still) return
      setShocks((current) => [...current.slice(-4), { key, sx: spot.sx, sy: spot.sy + LAYER }])
      window.setTimeout(() => setShocks((current) => current.filter((shock) => shock.key !== key)), 620)
    },
    [heights, mine, still],
  )

  /**
   * The ghost rushes to the stud it will land on and settles there. Snapping it
   * outright is honest but reads as a jump; a time-based exponential ease keeps
   * a fast sweep across the plate as one gesture and is frame-rate independent,
   * so a 120Hz display gets the same feel as a 60Hz one.
   */
  useEffect(() => {
    const ghost = ghostRef.current
    if (!ghost || !cursor) return
    const target = project(cursor.x, cursor.z, heights.get(columnKey(cursor.x, cursor.z)) ?? 0)
    if (still) {
      ghost.setAttribute('transform', `translate(${target.sx} ${target.sy})`)
      return
    }
    const from = ghost.getAttribute('transform')?.match(/-?[\d.]+/g)
    let sx = from ? Number(from[0]) : target.sx
    let sy = from ? Number(from[1]) : target.sy
    let last = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const step = 1 - Math.exp(((last - now) / 1000) * 19)
      last = now
      sx += (target.sx - sx) * step
      sy += (target.sy - sy) * step
      ghost.setAttribute('transform', `translate(${sx.toFixed(2)} ${sy.toFixed(2)})`)
      if (Math.abs(target.sx - sx) > 0.3 || Math.abs(target.sy - sy) > 0.3) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [cursor, heights, still])

  const move = (clientX: number, clientY: number) => {
    const user = toUser(clientX, clientY)
    if (!user) return
    const cell = cellAt(user.vx, user.vy)
    if (!onPlate(cell)) {
      setCursor(null)
      return
    }
    setTaken(true)
    setCursor((current) => (current && current.x === cell.x && current.z === cell.z ? current : cell))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, Cell> = {
      ArrowLeft: { x: -1, z: 0 },
      ArrowRight: { x: 1, z: 0 },
      ArrowUp: { x: 0, z: -1 },
      ArrowDown: { x: 0, z: 1 },
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      place(cursor ?? { x: 3, z: 2 })
      return
    }
    const delta = step[event.key]
    if (!delta) return
    event.preventDefault()
    setTaken(true)
    const from = cursor ?? { x: 3, z: 2 }
    const next = { x: from.x + delta.x, z: from.z + delta.z }
    if (onPlate(next)) setCursor(next)
  }

  const ghostHeight = cursor ? (heights.get(columnKey(cursor.x, cursor.z)) ?? 0) : 0
  const sorted = [...bricks].sort(depth)

  return (
    <div className="bw-plate" data-taken={taken ? 'true' : 'false'}>
      <div
        className="bw-plate-field"
        tabIndex={0}
        role="group"
        aria-label="A brick plate. Arrow keys choose a column, Enter drops a brick."
        onPointerMove={(event) => move(event.clientX, event.clientY)}
        onPointerLeave={() => setCursor(null)}
        onPointerDown={(event) => {
          const user = toUser(event.clientX, event.clientY)
          if (user) place(cellAt(user.vx, user.vy))
        }}
        onKeyDown={onKeyDown}
      >
        {/* Framed on the plate's own centre (x = 90 in user space). Headroom is
            modest and `overflow: visible` carries the rare six-high stack. */}
        <svg ref={svgRef} className="bw-plate-svg" viewBox="-190 -66 560 271" aria-hidden="true">
          <defs>
            <symbol id={`${id}-brick`} viewBox="-30 -14 60 50">
              <path d="M-30 0 0 14 0 36-30 22Z" fill="var(--face-left)" />
              <path d="M0 14 30 0 30 22 0 36Z" fill="var(--face-right)" />
              <path d="M-30 0 0-14 30 0 0 14Z" fill="var(--face-top)" />
              <path d="M-30 0 0-14 30 0 0 14Z" fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth=".7" />
              {[-1, 1].flatMap((sx) =>
                [-1, 1].map((sz) => {
                  const cx = (sx - sz) * 7.1
                  const cy = (sx + sz) * 3.3
                  return (
                    <g key={`${sx}-${sz}`}>
                      <path d={`M${cx - 5.4} ${cy - 3.4}v3.4a5.4 2.6 0 0 0 10.8 0v-3.4`} fill="var(--face-right)" />
                      <ellipse cx={cx} cy={cy - 3.4} rx="5.4" ry="2.6" fill="var(--face-top)" />
                      <ellipse
                        cx={cx}
                        cy={cy - 3.4}
                        rx="5.4"
                        ry="2.6"
                        fill="none"
                        stroke="#fff"
                        strokeOpacity=".26"
                        strokeWidth=".7"
                      />
                    </g>
                  )
                }),
              )}
            </symbol>
            <radialGradient id={`${id}-lamp`}>
              <stop offset="0" stopColor="#f4a882" stopOpacity=".5" />
              <stop offset="1" stopColor="#f4a882" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* The slab and its empty studs never change; see PLATE. */}
          {PLATE}

          {sorted.map((brick) => {
            const spot = project(brick.x, brick.z, brick.y)
            const [top, left, right] = COLORS[brick.color]
            return (
              <g
                key={brick.key}
                className="bw-plate-brick"
                data-mine={brick.mine ? 'true' : 'false'}
                style={
                  {
                    '--face-top': top,
                    '--face-left': left,
                    '--face-right': right,
                  } as CSSProperties
                }
              >
                <use href={`#${id}-brick`} x={spot.sx - 30} y={spot.sy - 14} width="60" height="50" />
              </g>
            )
          })}

          {shocks.map((shock) => (
            <ellipse
              key={shock.key}
              className="bw-plate-shock"
              cx={shock.sx}
              cy={shock.sy}
              rx="46"
              ry="21"
              style={{ transformOrigin: `${shock.sx}px ${shock.sy}px` }}
            />
          ))}

          {/* The lamp rides with the ghost, so the plate lights under the hand for free. */}
          <g ref={ghostRef} className="bw-plate-ghost" data-live={cursor ? 'true' : 'false'}>
            <circle className="bw-plate-lamp" cy="14" r="132" fill={`url(#${id}-lamp)`} />
            <use href={`#${id}-brick`} x={-30} y={-14} width="60" height="50" />
          </g>
        </svg>

        <p className="bw-plate-prompt" data-lift={cursor ? 'true' : 'false'} aria-hidden="true">
          {cursor ? `Column ${cursor.x + 1}, ${cursor.z + 1} · ${ghostHeight + 1} high` : 'Click the plate'}
        </p>
      </div>

      <div className="bw-plate-readout">
        <span>
          <b>{bricks.length}</b> bricks down
          {mine > 0 ? (
            <>
              {' · '}
              <b>{mine}</b> placed by you
            </>
          ) : null}
        </span>
        <button
          type="button"
          className="bw-plate-clear"
          disabled={!mine}
          onClick={() => {
            setBricks((current) => current.filter((brick) => !brick.mine))
            setSaid('Your bricks are off the plate.')
          }}
        >
          Take mine back off
        </button>
      </div>
      <p className="bw-visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  )
}

export default StudPlate
