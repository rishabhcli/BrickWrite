import type { SVGProps } from 'react'

export type WorkbenchIconName =
  | 'select'
  | 'move'
  | 'rotate'
  | 'connect'
  | 'generate'
  | 'refine'
  | 'agent'
  | 'object'
  | 'explore'
  | 'gallery'
  | 'projects'
  | 'parts'
  | 'share'
  | 'presence'
  | 'commands'
  | 'timeline'
  | 'render'
  | 'focus'
  | 'ground'
  | 'duplicate'
  | 'iso'
  | 'help'

/**
 * A tiny icon language made for Brickwright rather than borrowed from a generic
 * application set. Every mark is drawn on the same stud-and-axle geometry: the
 * square is a brick, the round terminals are connection points, and the amber
 * notch is supplied by the active control rather than baked into the SVG.
 */
export function WorkbenchIcon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & { name: WorkbenchIconName; size?: number }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.65,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" {...props}>
      <g {...common}>{paths[name]}</g>
    </svg>
  )
}

const paths: Record<WorkbenchIconName, React.ReactNode> = {
  select: (
    <>
      <path d="m5 3.8 12.6 8-6.3 1.6-2.4 6.2z" />
      <path d="m13.2 14.2 4 4" />
    </>
  ),
  move: (
    <>
      <rect x="7.2" y="7.2" width="9.6" height="9.6" rx="2" />
      <path d="M12 2.8v4.1M12 17.1v4.1M2.8 12h4.1M17.1 12h4.1M10 4.8l2-2 2 2M10 19.2l2 2 2-2M4.8 10l-2 2 2 2M19.2 10l2 2-2 2" />
    </>
  ),
  rotate: (
    <>
      <path d="M18.9 8.2A7.7 7.7 0 1 0 19 15.7" />
      <path d="m17.3 4.3 1.7 3.9-4.2.4" />
      <rect x="9" y="9" width="6" height="6" rx="1.4" />
    </>
  ),
  connect: (
    <>
      <path d="M8.8 8.8 6.6 6.6a3.3 3.3 0 0 0-4.6 4.7l2.5 2.5a3.3 3.3 0 0 0 4.7 0l1-1" />
      <path d="m15.2 15.2 2.2 2.2a3.3 3.3 0 0 0 4.6-4.7l-2.5-2.5a3.3 3.3 0 0 0-4.7 0l-1 1M8.5 15.5l7-7" />
    </>
  ),
  generate: (
    <>
      <path d="M5 18.8 7.2 13l2.2 5.8L15.5 21l-6.1 2.2z" transform="translate(0 -2)" />
      <path d="M15.5 3.2 16.7 6l2.8 1.2-2.8 1.2-1.2 2.8-1.2-2.8-2.8-1.2L14.3 6zM6 3.5v4M4 5.5h4" />
    </>
  ),
  refine: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
      <path d="m14.7 12 1 1 2-2" />
    </>
  ),
  agent: (
    <>
      <path d="M5 7.5A3.5 3.5 0 0 1 8.5 4h7A3.5 3.5 0 0 1 19 7.5v6a3.5 3.5 0 0 1-3.5 3.5H11l-4.5 3v-3.4A3.5 3.5 0 0 1 5 13.5z" />
      <circle cx="9" cy="10.5" r=".7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10.5" r=".7" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10.5" r=".7" fill="currentColor" stroke="none" />
    </>
  ),
  object: (
    <>
      <path d="m12 3 7.5 4.1v9.8L12 21l-7.5-4.1V7.1zM4.5 7.1 12 11l7.5-3.9M12 11v10" />
      <circle cx="12" cy="3" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  explore: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="m15.7 8.3-2.3 5.1-5.1 2.3 2.3-5.1z" />
    </>
  ),
  gallery: (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
      <circle cx="9" cy="9" r="1.4" />
      <path d="m5 17 4.7-4.7 2.8 2.7 2-2 4.5 4.2" />
    </>
  ),
  projects: (
    <>
      <path d="M3.8 7.2h6l1.7 2H20v8.3a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
      <path d="M4 7.2V6.5A2.5 2.5 0 0 1 6.5 4h3l1.7 2H17a2.5 2.5 0 0 1 2.4 1.8" />
    </>
  ),
  parts: (
    <>
      <path d="M4 8.5h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7z" />
      <path d="M6.2 6.5v2M8.8 6.5v2M15.2 2v2M17.8 2v2M15.2 11v2M17.8 11v2" />
    </>
  ),
  share: (
    <>
      <circle cx="7" cy="12" r="3" />
      <circle cx="17.5" cy="6" r="2.5" />
      <circle cx="17.5" cy="18" r="2.5" />
      <path d="m9.7 10.5 5.4-3.1M9.7 13.5l5.4 3.1" />
    </>
  ),
  presence: (
    <>
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.7 4.7a10.3 10.3 0 0 0 0 14.6M19.3 4.7a10.3 10.3 0 0 1 0 14.6" />
    </>
  ),
  commands: (
    <>
      <path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="m8 9 2.5 3L8 15M13 15h3" />
    </>
  ),
  timeline: (
    <>
      <path d="M7 5h13M7 12h13M7 19h13" />
      <circle cx="3.5" cy="5" r="1" />
      <circle cx="3.5" cy="12" r="1" />
      <circle cx="3.5" cy="19" r="1" />
    </>
  ),
  render: (
    <>
      <path d="m12 3 8 4.3-8 4.3-8-4.3z" />
      <path d="m4 11.8 8 4.3 8-4.3M4 16.3l8 4.3 8-4.3" />
    </>
  ),
  focus: (
    <>
      <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4" />
      <path d="M8.2 8.4h7.6v7.2H8.2zM10 6.6h4M10 17.4h4" />
    </>
  ),
  ground: (
    <>
      <path d="m12 3.5 6 3.2v7.1L12 17l-6-3.2V6.7zM6 6.7l6 3.1 6-3.1M12 9.8V17" />
      <path d="M3.5 20.5h17M6 17.8v2.7M18 17.8v2.7" />
    </>
  ),
  duplicate: (
    <>
      <rect x="4" y="7" width="10" height="10" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4M7 12h4M9 10v4" />
    </>
  ),
  iso: (
    <>
      <path d="m12 3 7 3.8v8.4L12 19l-7-3.8V6.8zM5 6.8l7 3.7 7-3.7M12 10.5V19" />
      <path d="M9.2 2.2 12 3.7l2.8-1.5" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9a2.5 2.5 0 1 1 3.2 2.4c-.9.4-.9 1-.9 1.8M12 17h.01" />
    </>
  ),
}
