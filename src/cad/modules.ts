import { catalog, STUD_LDU } from './catalog'
import { getPartBounds } from './geometry'
import { applyMat3, multiplyMat3 } from './math'
import { QUARTER_TURN_BASES } from './placement'
import type { Actor, ModelDocument, ModuleDefinition, PartInstance, Transform, Vec3 } from './types'

/**
 * Named sub-builds: author a bay once, place it everywhere.
 *
 * A modular building is repetition — the same window bay across a facade, the
 * same balcony on every storey, the same shop front on four sides of a block.
 * Copying a selection by hand works once; by the twelfth copy the offsets have
 * drifted and the repetition that was supposed to read as deliberate reads as
 * sloppy instead.
 *
 * A module is captured into its own frame, with its origin at its minimum
 * corner on its base plane, so a stamp is an exact translation and a quarter
 * turn — never a re-derivation, and never subject to accumulated float error.
 * Stamps go through the ordinary command bus as `part.add` operations, so a
 * stamped bay is checked for collisions and can be undone like anything else.
 */

export class ModuleError extends Error {
  constructor(readonly code: 'EMPTY' | 'NOT_FOUND' | 'RESOURCE_LIMIT', message: string, readonly repair: string) {
    super(message)
    this.name = 'ModuleError'
  }
}

/** Hard ceiling on one stamp command, mirroring the assembly generators. */
export const MAX_STAMPED_PARTS = 4000

/**
 * Captures parts into a module, rebasing them onto the module's own origin.
 *
 * The origin is the minimum corner of the captured footprint at its *base*
 * plane. In LDraw's Y-down frame the base is the maximum Y, which is why the
 * vertical rebase subtracts the maximum rather than the minimum: a module
 * captured from the fourth storey has to stamp onto the ground without
 * remembering how high it happened to be built.
 */
export function captureModule(
  document: ModelDocument,
  partIds: readonly string[],
  name: string,
  author: Actor,
  id: string,
): ModuleDefinition {
  const parts = partIds.map((partId) => document.parts[partId]).filter(Boolean)
  if (!parts.length) {
    throw new ModuleError('EMPTY', 'A module needs at least one part.', 'Select the parts to capture, or pass explicit partIds.')
  }
  const bounds = parts.map(getPartBounds)
  const measured = bounds.filter((item) => item.measured)
  if (!measured.length) {
    throw new ModuleError('EMPTY', 'None of the selected parts have compiled geometry to measure.', 'Capture a module from parts this build can place.')
  }
  const originX = Math.min(...measured.map((item) => item.min[0]))
  const originZ = Math.min(...measured.map((item) => item.min[2]))
  const baseY = Math.max(...measured.map((item) => item.max[1]))
  const topY = Math.min(...measured.map((item) => item.min[1]))
  const spanX = Math.max(...measured.map((item) => item.max[0])) - originX
  const spanZ = Math.max(...measured.map((item) => item.max[2])) - originZ

  return {
    id,
    name,
    parts: parts.map((part) => ({
      definitionId: part.definitionId,
      color: part.color,
      transform: {
        position: [
          part.transform.position[0] - originX,
          part.transform.position[1] - baseY,
          part.transform.position[2] - originZ,
        ],
        basis: part.transform.basis,
      },
    })),
    sizeLdu: [spanX, baseY - topY, spanZ],
    createdAtRevision: document.revision,
    author,
  }
}

export interface StampRequest {
  /** Document-space corner to stamp onto: minimum X, minimum Z, base-plane Y. */
  readonly atLdu: Vec3
  /** Quarter turns about the vertical axis, applied about the module's own footprint. */
  readonly quarterTurns?: number
  readonly copies?: number
  /** Offset between successive copies, in LDU. */
  readonly spacingLdu?: Vec3
  /** Recolour every stamped part, leaving the module itself untouched. */
  readonly color?: number
}

export interface StampResult {
  readonly parts: PartInstance[]
  readonly footprintLdu: Vec3
}

/**
 * Places one or more copies of a module.
 *
 * A quarter turn rotates the module about its own footprint rather than about
 * the world origin, so a bay turned onto the next face of a building lands
 * against that face instead of somewhere across the model.
 */
export function stampModule(
  module: ModuleDefinition,
  request: StampRequest,
  context: { subassemblyId: string; stepId: string; actor: Actor; nextId: () => string },
): StampResult {
  const copies = Math.max(1, Math.trunc(request.copies ?? 1))
  const turns = ((Math.trunc(request.quarterTurns ?? 0) % 4) + 4) % 4
  const rotation = QUARTER_TURN_BASES[turns]
  const spacing = request.spacingLdu ?? [module.sizeLdu[0], 0, 0]

  // A quarter turn swaps the footprint's X and Z extents, and the rotated
  // corner has to be pulled back so the stamp still starts where it was asked
  // to. Both are exact: the bases hold only 0, 1 and -1.
  const [sizeX, , sizeZ] = module.sizeLdu
  const corner: Vec3 = turns === 0
    ? [0, 0, 0]
    : turns === 1
      ? [0, 0, sizeX]
      : turns === 2
        ? [sizeX, 0, sizeZ]
        : [sizeZ, 0, 0]

  const parts: PartInstance[] = []
  for (let copy = 0; copy < copies; copy += 1) {
    for (const entry of module.parts) {
      const rotated = applyMat3(rotation, entry.transform.position)
      const transform: Transform = {
        position: [
          request.atLdu[0] + corner[0] + rotated[0] + spacing[0] * copy,
          request.atLdu[1] + rotated[1] + spacing[1] * copy,
          request.atLdu[2] + corner[2] + rotated[2] + spacing[2] * copy,
        ],
        basis: multiplyMat3(rotation, entry.transform.basis),
      }
      parts.push({
        id: context.nextId(),
        definitionId: entry.definitionId,
        color: request.color ?? entry.color,
        transform,
        subassemblyId: context.subassemblyId,
        stepId: context.stepId,
        provenance: context.actor,
        protected: false,
      })
    }
    if (parts.length > MAX_STAMPED_PARTS) {
      throw new ModuleError(
        'RESOURCE_LIMIT',
        `Stamping ${copies} copies of ${module.name} would place ${copies * module.parts.length} parts.`,
        `Stamp fewer copies; the ceiling is ${MAX_STAMPED_PARTS} parts per command.`,
      )
    }
  }

  return {
    parts,
    footprintLdu: turns % 2 === 0 ? [sizeX, module.sizeLdu[1], sizeZ] : [sizeZ, module.sizeLdu[1], sizeX],
  }
}

/** Modules a document holds, newest last. */
export const documentModules = (document: ModelDocument): ModuleDefinition[] => document.modules ?? []

export function findModule(document: ModelDocument, idOrName: string): ModuleDefinition | undefined {
  const modules = documentModules(document)
  const wanted = idOrName.trim().toLowerCase()
  return modules.find((module) => module.id === idOrName) ?? modules.find((module) => module.name.toLowerCase() === wanted)
}

/** Human-facing footprint, e.g. "6 × 4 studs · 3 bricks tall". */
export function describeModule(module: ModuleDefinition): string {
  const [x, y, z] = module.sizeLdu
  const studs = (value: number) => Math.round((value / STUD_LDU) * 10) / 10
  const placeable = module.parts.filter((entry) => catalog.get(entry.definitionId)).length
  return `${studs(x)} × ${studs(z)} studs · ${Math.round(y)} LDU tall · ${placeable} part${placeable === 1 ? '' : 's'}`
}
