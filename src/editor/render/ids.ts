/**
 * Identity codec and registry for the GPU picking pass.
 *
 * Picking a part used to run through React's pointer system: every instanced
 * mesh raycast on the CPU, every hit walked back to a `userData.members` entry.
 * That is O(triangles) per pick and it competes with the frame, which is why a
 * five-thousand-part model felt like it was ignoring the cursor.
 *
 * The replacement draws the scene a second time into an off-screen buffer where
 * each part writes its own integer identity instead of its colour, then reads
 * back the pixels it cares about. The read is the only CPU work, and it is
 * proportional to the *region the operator drew*, not to the model.
 *
 * Identities are 24-bit, packed one byte per channel. Zero is reserved for
 * "nothing", so the cleared buffer decodes to no part rather than to part 0 —
 * a distinction the whole pass depends on, because the clear colour is read
 * back exactly like any other pixel.
 */

/** Reserved: a cleared id pixel decodes to this, meaning "background". */
export const NO_ID = 0

/** 24 bits, minus the reserved zero. Far past any model this tool can hold. */
export const MAX_ID = 0xffffff

/** Packs an identity into the three bytes the id shader writes. */
export function encodeId(id: number): [number, number, number] {
  return [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]
}

/** Reads an identity back out of a pixel. Alpha is ignored; the pass writes 1. */
export function decodeId(r: number, g: number, b: number): number {
  return ((r << 16) | (g << 8) | b) >>> 0
}

/**
 * The drawn-object side of the id pass.
 *
 * One entry per *draw*, not per part: an instanced batch of 900 bricks is a
 * single entry whose ids run `[base, base + 900)`, because the shader adds
 * `gl_InstanceID` to the base the uniform supplies. That is what keeps the id
 * pass at the same draw-call count as the beauty pass.
 */
export interface PickBlock {
  /** First identity this draw owns. */
  readonly base: number
  /** Part ids in instance order, so `base + i` resolves to `partIds[i]`. */
  readonly partIds: readonly string[]
}

/**
 * Assigns identity ranges to drawn objects and resolves them back to parts.
 *
 * Rebuilt whenever the batch plan changes, which is on commit rather than per
 * frame. A flat lookup array is used instead of a Map because the read path
 * runs once per covered pixel during a lasso — hundreds of thousands of times
 * for a full-screen region — and a Map lookup there is measurable.
 */
export class PickRegistry {
  private blocks: PickBlock[] = []
  /** `table[id]` is the part it belongs to; index 0 stays undefined. */
  private table: string[] = []
  private next = 1

  /** Discards every assignment. Called when the plan is rebuilt. */
  reset() {
    this.blocks = []
    this.table = []
    this.next = 1
  }

  /**
   * Reserves a contiguous identity range for one draw.
   *
   * Returns the base the shader should be handed. A caller that reserves more
   * identities than the 24-bit space allows gets `NO_ID`, which draws as
   * background rather than as somebody else's part — silently colliding two
   * parts onto one identity would make picking wrong instead of merely absent.
   */
  reserve(partIds: readonly string[]): number {
    if (!partIds.length) return NO_ID
    if (this.next + partIds.length > MAX_ID) return NO_ID
    const base = this.next
    this.next += partIds.length
    this.blocks.push({ base, partIds })
    for (let index = 0; index < partIds.length; index += 1) this.table[base + index] = partIds[index]
    return base
  }

  /** The part an identity belongs to, or null for background and stale ids. */
  resolve(id: number): string | null {
    if (id === NO_ID) return null
    return this.table[id] ?? null
  }

  /** Identity assigned to a part, or `NO_ID`. Linear; used by tests and probes. */
  idOf(partId: string): number {
    for (const block of this.blocks) {
      const index = block.partIds.indexOf(partId)
      if (index >= 0) return block.base + index
    }
    return NO_ID
  }

  get size(): number {
    return this.next - 1
  }

  get drawCount(): number {
    return this.blocks.length
  }
}
