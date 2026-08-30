import { useId, useState, type CSSProperties } from 'react'
import { usePointerTilt } from './reveal'
import { useRef } from 'react'

type Brick = { x: number; y: number; z: number; color: number }

const PALETTE = [
  ['#e9ddc6', '#c3b49a', '#a89980'],
  ['#f47c51', '#bd482e', '#913725'],
  ['#afc8b3', '#6f9580', '#4f7563'],
  ['#96bbca', '#588393', '#3e6474'],
]

/** An original, decorative brick pavilion, not a purported CAD document. */
const BRICKS: Brick[] = []
for (let z = -2; z <= 2; z++) {
  for (let x = -4; x <= 4; x++) BRICKS.push({ x, y: 0, z, color: 0 })
}
for (let y = 1; y <= 7; y++) {
  for (const z of [-1, 0]) {
    const columns = y < 5 ? [-3, 3] : y === 5 ? [-3, -2, 2, 3] : y === 6 ? [-2, -1, 0, 1, 2] : [-1, 0, 1]
    for (const x of columns) BRICKS.push({ x, y, z, color: y >= 5 || x === 3 ? 1 : 0 })
  }
}
// A small stair, garden, and loose pieces make the pavilion a place, not a logo.
for (let y = 1; y <= 3; y++) {
  for (let z = -2; z <= 0; z++) BRICKS.push({ x: -5 + y, y, z: z + 2, color: 0 })
}
BRICKS.push(
  { x: 3, y: 1, z: 2, color: 2 },
  { x: 4, y: 1, z: 2, color: 2 },
  { x: 3, y: 2, z: 2, color: 2 },
  { x: -3, y: 1, z: -2, color: 3 },
  { x: -3, y: 2, z: -2, color: 3 },
  { x: 5.5, y: 1.5, z: -1, color: 1 },
  { x: -5.5, y: 3, z: -1, color: 3 },
  { x: 1, y: 8.7, z: 0, color: 0 },
)
BRICKS.sort((a, b) => a.x + a.z - (b.x + b.z) || a.y - b.y)

export function BrickSculpture({ paused }: { paused: boolean }) {
  const [scattered, setScattered] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const id = useId().replace(/:/g, '')
  usePointerTilt(ref, paused)

  return (
    <div className="bw-sculpture" ref={ref} data-scattered={scattered}>
      <div className="bw-sculpture-drawing">
        <svg
          className="bw-pavilion"
          viewBox="-320 -340 640 560"
          role="img"
          aria-label="An isometric brick pavilion with a terracotta arch, ivory stairs, and floating blue and green bricks. A playful illustration of building possibilities."
        >
          <defs>
            <radialGradient id={`${id}-glow`}>
              <stop offset="0" stopColor="#b9704b" stopOpacity=".18" />
              <stop offset="1" stopColor="#b9704b" stopOpacity="0" />
            </radialGradient>
            <symbol id={`${id}-brick`} viewBox="-30 -14 60 49">
              <path
                d="M-30 0 0 14 0 35-30 21Z"
                fill="var(--brick-left)"
                stroke="#181914"
                strokeOpacity=".16"
                strokeWidth=".6"
              />
              <path
                d="M0 14 30 0 30 21 0 35Z"
                fill="var(--brick-right)"
                stroke="#181914"
                strokeOpacity=".16"
                strokeWidth=".6"
              />
              <path
                d="M-30 0 0-14 30 0 0 14Z"
                fill="var(--brick-top)"
                stroke="#fff"
                strokeOpacity=".23"
                strokeWidth=".6"
              />
              {[-1, 1].flatMap((x) =>
                [-1, 1].map((z) => {
                  const cx = (x - z) * 7.1
                  const cy = (x + z) * 3.3
                  return (
                    <g key={`${x}-${z}`}>
                      <path d={`M${cx - 5.4} ${cy - 3.2}v3.2a5.4 2.6 0 0 0 10.8 0v-3.2`} fill="var(--brick-left)" />
                      <ellipse
                        cx={cx}
                        cy={cy - 3.2}
                        rx="5.4"
                        ry="2.6"
                        fill="var(--brick-top)"
                        stroke="#fff"
                        strokeOpacity=".3"
                        strokeWidth=".7"
                      />
                    </g>
                  )
                }),
              )}
            </symbol>
          </defs>
          <circle cx="0" cy="-70" r="265" fill={`url(#${id}-glow)`} />
          <g className="bw-pavilion-orbits" fill="none" stroke="currentColor">
            <ellipse cx="0" cy="85" rx="272" ry="117" />
            <ellipse cx="0" cy="85" rx="244" ry="105" strokeDasharray="2 7" />
            <path d="M-300 85H300M0-52V217" strokeDasharray="3 8" />
            <path d="M-280 77v16M280 77v16M-8 203h16M-8-33h16" />
          </g>
          <ellipse cx="0" cy="86" rx="178" ry="58" fill="#000" opacity=".16" />
          <g className="bw-pavilion-float">
            {BRICKS.map((brick, index) => {
              const [top, left, right] = PALETTE[brick.color]
              const angle = index * 2.39996
              return (
                <g
                  key={index}
                  className="bw-pavilion-brick"
                  style={
                    {
                      '--brick-top': top,
                      '--brick-left': left,
                      '--brick-right': right,
                      '--scatter-x': `${Math.cos(angle) * (60 + (index % 5) * 22)}px`,
                      '--scatter-y': `${Math.sin(angle) * (50 + (index % 7) * 14)}px`,
                      '--scatter-rotation': `${((index % 7) - 3) * 8}deg`,
                      '--brick-delay': `${(index % 13) * 22}ms`,
                    } as CSSProperties
                  }
                >
                  <use
                    href={`#${id}-brick`}
                    x={(brick.x - brick.z) * 30 - 30}
                    y={(brick.x + brick.z) * 14 - brick.y * 22 - 14}
                    width="60"
                    height="49"
                  />
                </g>
              )
            })}
          </g>
        </svg>
        <span className="bw-sculpture-coordinate bw-coordinate-top" aria-hidden="true">
          FIG. 001 / A LITTLE POSSIBILITY
        </span>
        <span className="bw-sculpture-coordinate bw-coordinate-side" aria-hidden="true">
          IMAGINATION, IN THREE DIMENSIONS
        </span>
      </div>
      <button
        type="button"
        className="bw-sculpture-toggle"
        aria-pressed={scattered}
        onClick={() => setScattered((value) => !value)}
      >
        <span className="bw-toggle-icon" aria-hidden="true">
          {scattered ? '↙' : '↗'}
        </span>
        {scattered ? 'Put it together' : 'Take it apart'}
        <span className="bw-toggle-note">Go on. It’s your playground.</span>
      </button>
    </div>
  )
}
