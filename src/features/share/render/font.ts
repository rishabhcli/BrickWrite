/**
 * A 5×7 stencil font, drawn directly into the pixel buffer.
 *
 * The watermark has to render identically in a browser, in Node and in a
 * Worker, so it cannot come from a canvas: text measurement and hinting differ
 * between platforms, and two runs of the same preset would produce different
 * bytes. A bitmap font is the only way a rendered caption stays part of a
 * deterministic artifact.
 *
 * 5×7 is also the right *look*. Brickwright's display face is Chakra Petch and
 * its surfaces are instrument panels; a scaled stencil mark reads as stamped
 * equipment marking rather than as a missing webfont.
 *
 * Coverage is uppercase Latin, digits and the punctuation an attribution line
 * actually needs. Anything outside it renders as a blank cell rather than a
 * substitution glyph, because a wrong character is worse than an absent one.
 */

export const GLYPH_WIDTH = 5
export const GLYPH_HEIGHT = 7

/** Each glyph is seven rows of five cells; `#` paints, `.` does not. */
const GLYPH_ROWS: Record<string, readonly string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '.##..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  ';': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.#...'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '"': ['.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
  '(': ['..##.', '.#...', '.#...', '.#...', '.#...', '.#...', '..##.'],
  ')': ['.##..', '...#.', '...#.', '...#.', '...#.', '...#.', '.##..'],
  '[': ['.###.', '.#...', '.#...', '.#...', '.#...', '.#...', '.###.'],
  ']': ['.###.', '...#.', '...#.', '...#.', '...#.', '...#.', '.###.'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '@': ['.###.', '#...#', '#.###', '#.#.#', '#.###', '#....', '.###.'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '×': ['.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '.....'],
  '°': ['.##..', '#..#.', '.##..', '.....', '.....', '.....', '.....'],
  '•': ['.....', '.....', '.###.', '.###.', '.###.', '.....', '.....'],
}

const GLYPHS: Record<string, string> = {}
for (const [character, rows] of Object.entries(GLYPH_ROWS)) {
  if (rows.length !== GLYPH_HEIGHT || rows.some((row) => row.length !== GLYPH_WIDTH)) {
    throw new Error(`Stencil glyph "${character}" is not ${GLYPH_WIDTH}×${GLYPH_HEIGHT}.`)
  }
  GLYPHS[character] = rows.join('')
}

/** True when the glyph paints the cell at (column, row). */
export function glyphPixel(character: string, column: number, row: number): boolean {
  const rows = GLYPHS[character]
  return rows ? rows[row * GLYPH_WIDTH + column] === '#' : false
}

/** Whether a character has a glyph at all; callers substitute a space. */
export const hasGlyph = (character: string) => character in GLYPHS

/** Folds a caption to the characters this font can actually draw. */
export function normaliseCaption(text: string): string {
  return [...text.toUpperCase()].map((character) => (hasGlyph(character) ? character : ' ')).join('')
}

/** Rendered width in pixels, including inter-glyph tracking. */
export function measureCaption(text: string, scale: number, tracking = 1): number {
  const characters = [...normaliseCaption(text)]
  if (!characters.length) return 0
  return characters.length * GLYPH_WIDTH * scale + (characters.length - 1) * tracking * scale
}

export interface CaptionTarget {
  rgba: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Draws a caption, alpha-compositing it over whatever is already there.
 *
 * The caption is painted last, so it survives the background and the model. It
 * blends rather than replaces so a watermark at low opacity reads as a mark on
 * the image rather than as a hole cut through it.
 */
export function drawCaption(
  target: CaptionTarget,
  text: string,
  options: {
    x: number
    y: number
    scale: number
    rgb: readonly [number, number, number]
    opacity: number
    tracking?: number
  },
): void {
  const tracking = options.tracking ?? 1
  const alpha = Math.max(0, Math.min(1, options.opacity))
  if (alpha === 0) return
  const [r, g, b] = options.rgb
  const scale = Math.max(1, Math.round(options.scale))

  let penX = Math.round(options.x)
  const penY = Math.round(options.y)
  for (const character of [...normaliseCaption(text)]) {
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (!glyphPixel(character, column, row)) continue
        for (let dy = 0; dy < scale; dy += 1) {
          const y = penY + row * scale + dy
          if (y < 0 || y >= target.height) continue
          for (let dx = 0; dx < scale; dx += 1) {
            const x = penX + column * scale + dx
            if (x < 0 || x >= target.width) continue
            const pixel = (y * target.width + x) * 4
            target.rgba[pixel] = Math.round(target.rgba[pixel] * (1 - alpha) + r * 255 * alpha)
            target.rgba[pixel + 1] = Math.round(target.rgba[pixel + 1] * (1 - alpha) + g * 255 * alpha)
            target.rgba[pixel + 2] = Math.round(target.rgba[pixel + 2] * (1 - alpha) + b * 255 * alpha)
            // A watermark drawn over transparency must make its own pixels
            // opaque, or it vanishes from a transparent export.
            target.rgba[pixel + 3] = Math.max(target.rgba[pixel + 3], Math.round(255 * alpha))
          }
        }
      }
    }
    penX += (GLYPH_WIDTH + tracking) * scale
  }
}
