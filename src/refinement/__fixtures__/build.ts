import { catalog, originForSurface, surfaceAbove } from '../../cad/catalog'
import { basisFromEulerDegrees, cleanBasis } from '../../cad/math'
import { createEmptyDocument } from '../../cad/sample'
import { deriveConnectionEdges } from '../../cad/snapping'
import type { ModelDocument, PartInstance, Vec3 } from '../../cad/types'

/**
 * Fixture construction, from the real compiled catalog.
 *
 * Every fixture is built the way the showcase is: parts are *rested on a
 * surface*, and the surface the next course sits on is read back from the part's
 * own compiled connectors. Nothing here assumes a brick is 24 LDU tall or that a
 * plate's origin is at its underside, because for a slope, a curve or a hinge
 * neither is true — and a fixture whose geometry is subtly wrong would make every
 * assertion built on it meaningless.
 *
 * The stud-grid rule these fixtures follow, which is where hand-built LEGO
 * coordinates usually go wrong: an element with an *even* stud count along an
 * axis is centred on a stud boundary, and one with an *odd* count is centred on a
 * stud. Getting it backwards produces a model that renders and connects to
 * nothing.
 */

export interface PlaceOptions {
  readonly rotationY?: number
  readonly sub?: string
  readonly step?: string
  readonly protectedPart?: boolean
}

export class FixtureBuilder {
  readonly parts: PartInstance[] = []
  private sequence = 0

  constructor(private readonly defaults: PlaceOptions = {}) {}

  private push(definitionId: string, color: number, position: Vec3, options: PlaceOptions): PartInstance {
    this.sequence += 1
    const merged = { ...this.defaults, ...options }
    const part: PartInstance = {
      id: `p${String(this.sequence).padStart(3, '0')}`,
      definitionId,
      color,
      transform: {
        position,
        basis: cleanBasis(basisFromEulerDegrees([0, merged.rotationY ?? 0, 0])),
      },
      subassemblyId: merged.sub ?? 'hull',
      stepId: merged.step ?? 'step_1',
      provenance: 'human',
      protected: merged.protectedPart ?? false,
    }
    this.parts.push(part)
    return part
  }

  /** Rests a part's underside on `surfaceY`; returns the stud plane it exposes. */
  place(definitionId: string, color: number, x: number, z: number, surfaceY: number, options: PlaceOptions = {}): number {
    const definition = catalog.get(definitionId)
    if (!definition) throw new Error(`Fixture references ${definitionId}, which is not in the compiled catalog pack.`)
    const y = originForSurface(definition, surfaceY)
    this.push(definitionId, color, [x, y, z], options)
    return surfaceAbove(definition, y) ?? surfaceY
  }

  /** Places at an explicit origin, for parts that mate rather than rest. */
  placeAt(definitionId: string, color: number, x: number, y: number, z: number, options: PlaceOptions = {}): number {
    const definition = catalog.get(definitionId)
    if (!definition) throw new Error(`Fixture references ${definitionId}, which is not in the compiled catalog pack.`)
    this.push(definitionId, color, [x, y, z], options)
    return surfaceAbove(definition, y) ?? y
  }

  /** Places the same part at several positions on one surface. */
  row(definitionId: string, color: number, xs: readonly number[], z: number, surfaceY: number, options: PlaceOptions = {}): number {
    let exposed = surfaceY
    for (const x of xs) exposed = this.place(definitionId, color, x, z, surfaceY, options)
    return exposed
  }

  /** Ids of the last `count` parts placed, for building a scope. */
  recent(count: number): string[] {
    return this.parts.slice(-count).map((part) => part.id)
  }

  idsOf(predicate: (part: PartInstance) => boolean): string[] {
    return this.parts.filter(predicate).map((part) => part.id)
  }
}

/**
 * Wraps the built parts in a document with a real connection graph.
 *
 * The subassembly and step scaffold comes from `createEmptyDocument`, so the ids
 * a fixture places parts into are the ones the kernel already validates against —
 * including the deliberately locked `cockpit` assembly, which one fixture uses to
 * exercise refusal.
 */
export function fixtureDocument(parts: readonly PartInstance[], name: string): ModelDocument {
  const document = createEmptyDocument()
  document.id = `doc_${name.toLowerCase().replace(/\W+/g, '_')}`
  document.name = name
  document.revision = 1
  document.parts = Object.fromEntries(parts.map((part) => [part.id, part]))
  for (const subassembly of Object.values(document.subassemblies)) {
    subassembly.partIds = parts.filter((part) => part.subassemblyId === subassembly.id).map((part) => part.id)
  }
  document.steps = document.steps.map((step) => ({
    ...step,
    partIds: parts.filter((part) => part.stepId === step.id).map((part) => part.id),
  }))
  document.connections = deriveConnectionEdges(document, document.revision, 'import-inferred')
  return document
}
