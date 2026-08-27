import { type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { catalog } from '../cad/catalog'
import { geometryCache, MAIN_COLOUR, type PartGeometry } from '../cad/mesh'
import type { PartDefinition, PartInstance, Transform } from '../cad/types'
import { surfaceMaterialFor, type PartAppearance } from './PartVisual'

/**
 * Instanced rendering for the bulk of a model.
 *
 * Parts that share a definition and a colour differ only by transform, which is
 * exactly what `InstancedMesh` exists for. Batching by that key turns one draw
 * call per part into one per material group, so scene cost tracks the number of
 * distinct part/colour combinations a model uses — typically a few dozen — rather
 * than the number of bricks.
 *
 * Selected, ghosted and flagged parts are deliberately *not* batched. Pulling an
 * instance out of a batch to highlight it would rebuild the batch on every
 * hover; rendering those few parts individually in an overlay costs a handful of
 * draw calls and leaves the batches untouched.
 */

export interface BatchMember {
  readonly part: PartInstance
  /** Pose to draw at, which differs from the stored pose in exploded view. */
  readonly transform: Transform
}

export interface PartBatchDescriptor {
  readonly key: string
  readonly definition: PartDefinition
  readonly colorCode: number
  readonly appearance: PartAppearance
  readonly members: readonly BatchMember[]
}

/**
 * Selection size at which highlighted parts stay out of the batches.
 *
 * Below it, drawing them individually keeps the batches stable while an
 * operator picks around — which is what they are for. Above it the trade
 * inverts sharply: box-selecting a stamped city block put 732 parts on their
 * own draw calls and took a 1,464-part scene from 106 calls a frame to 3,278.
 * Past this many, selection gets its own batches instead.
 */
export const INDIVIDUAL_SELECTION_LIMIT = 24

/**
 * Above this many batched parts, hard edges are dropped entirely.
 *
 * Edges are merged per batch rather than drawn per part (see `BatchEdges`), so
 * draw calls stay flat, but the merged buffers still cost memory proportional to
 * brick count. This is the ceiling at which that trade stops being worthwhile.
 * It is a quality tier, not a correctness one: the CAD kernel is unaffected and
 * the UI reports it.
 */
export const EDGE_RENDER_BUDGET = 6000

/**
 * Vertex ceiling for one batch's merged edge buffer, ~7 MB at three floats per
 * vertex. A batch past this limit renders without edges rather than allocating
 * without bound.
 */
const MERGED_EDGE_VERTEX_BUDGET = 600_000

const matrixOf = (transform: Transform, target: THREE.Matrix4): THREE.Matrix4 => {
  const b = transform.basis
  const [x, y, z] = transform.position
  return target.set(b[0], b[1], b[2], x, b[3], b[4], b[5], y, b[6], b[7], b[8], z, 0, 0, 0, 1)
}

/** Subscribes to the shared cache so a batch appears as soon as its mesh lands. */
function useBatchGeometry(definition: PartDefinition): PartGeometry | null {
  const [geometry, setGeometry] = useState<PartGeometry | null>(() => geometryCache.get(definition))
  useEffect(() => {
    let cancelled = false
    setGeometry(geometryCache.get(definition))
    void geometryCache.load(definition).then((loaded) => {
      if (!cancelled) setGeometry(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [definition])
  return geometry
}

interface PartBatchProps {
  descriptor: PartBatchDescriptor
  showEdges: boolean
  silhouette: boolean
  /** False while a placement ghost owns the pointer, so a drop cannot also select. */
  interactive?: boolean
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
}

export function PartBatch({ descriptor, showEdges, silhouette, interactive = true, onSelect }: PartBatchProps) {
  const instances = useRef<THREE.InstancedMesh>(null)
  const geometry = useBatchGeometry(descriptor.definition)
  const scratch = useMemo(() => new THREE.Matrix4(), [])

  const materials = useMemo(() => {
    if (!geometry) return []
    // Slice colour 16 takes the instance colour; anything else is baked into the
    // part, such as a black rubber tyre or a printed face.
    return geometry.slices.map((slice) =>
      surfaceMaterialFor(
        slice.colour === MAIN_COLOUR ? (silhouette ? 71 : descriptor.colorCode) : slice.colour,
        descriptor.appearance,
      ),
    )
  }, [geometry, descriptor.colorCode, descriptor.appearance, silhouette])

  useLayoutEffect(() => {
    const mesh = instances.current
    if (!mesh) return
    descriptor.members.forEach((member, index) => {
      mesh.setMatrixAt(index, matrixOf(member.transform, scratch))
    })
    mesh.count = descriptor.members.length
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    // A raycast run outside React — the placement ghost does exactly that — gets
    // back an object and an instance index, so the batch has to say which part
    // each index stands for.
    mesh.userData.members = descriptor.members
  }, [descriptor.members, geometry, scratch])

  if (!geometry) return null

  const handlePointer = (event: ThreeEvent<PointerEvent>) => {
    if (!interactive || event.instanceId === undefined) return
    const member = descriptor.members[event.instanceId]
    if (!member) return
    event.stopPropagation()
    onSelect(member.part.id, event.nativeEvent.shiftKey, event.nativeEvent.detail > 1)
  }

  return (
    <group>
      <instancedMesh
        ref={instances}
        // The key forces a fresh instance buffer when the batch grows, since
        // InstancedMesh capacity is fixed at construction.
        key={`${descriptor.key}:${descriptor.members.length}`}
        args={[geometry.surface, undefined as unknown as THREE.Material, Math.max(1, descriptor.members.length)]}
        material={materials}
        castShadow
        receiveShadow
        onPointerDown={handlePointer}
        onDoubleClick={(event) => {
          if (!interactive || event.instanceId === undefined) return
          const member = descriptor.members[event.instanceId]
          if (!member) return
          event.stopPropagation()
          onSelect(member.part.id, false, true)
        }}
      />
      {showEdges && geometry.edges && !silhouette && (
        <BatchEdges descriptor={descriptor} geometry={geometry} />
      )}
    </group>
  )
}

/**
 * Hard edges for a whole batch, merged into one buffer.
 *
 * Line geometry has no instanced equivalent without a custom shader, so drawing
 * edges per part costs one call each — which measurably dominated the frame once
 * batching had flattened the surface calls. Baking each member's transform into
 * a single merged buffer restores one draw call per batch. The buffer is rebuilt
 * only when the batch's membership or poses change, which happens on commit
 * rather than per frame.
 */
function BatchEdges({ descriptor, geometry }: { descriptor: PartBatchDescriptor; geometry: PartGeometry }) {
  const material = useMemo(() => {
    const base = catalog.color(descriptor.colorCode)
    return new THREE.LineBasicMaterial({ color: base.edge, transparent: true, opacity: 0.34, depthWrite: false })
  }, [descriptor.colorCode])

  // `planBatches` builds fresh member arrays on every commit, so memoizing on
  // array identity rebuilt every merged buffer in the model for an edit that
  // touched one brick. The signature is what actually decides the buffer's
  // contents, and computing it is O(members) arithmetic against O(members ×
  // edge vertices) of matrix work.
  const signature = useMemo(() => contentSignature(descriptor.members), [descriptor.members])

  const merged = useMemo(() => {
    const source = geometry.edges?.getAttribute('position')
    if (!source) return null
    const perInstance = source.count
    const total = perInstance * descriptor.members.length
    if (total === 0 || total > MERGED_EDGE_VERTEX_BUDGET) return null

    const positions = new Float32Array(total * 3)
    const matrix = new THREE.Matrix4()
    const vertex = new THREE.Vector3()
    descriptor.members.forEach((member, instance) => {
      matrixOf(member.transform, matrix)
      const base = instance * perInstance * 3
      for (let index = 0; index < perInstance; index += 1) {
        vertex.fromBufferAttribute(source, index).applyMatrix4(matrix)
        positions[base + index * 3] = vertex.x
        positions[base + index * 3 + 1] = vertex.y
        positions[base + index * 3 + 2] = vertex.z
      }
    })
    const buffer = new THREE.BufferGeometry()
    buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return buffer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, geometry])

  // Merged buffers are owned by this component, so they are disposed with it.
  useEffect(() => () => merged?.dispose(), [merged])

  if (!merged) return null
  return <lineSegments geometry={merged} material={material} />
}

/**
 * A cheap, order-sensitive digest of a batch's poses.
 *
 * FNV-1a over the quantized transforms: two batches with the same members in
 * the same poses produce the same number, and any real change to a pose or to
 * membership changes it. Quantizing to a hundredth of an LDU is far finer than
 * anything the kernel can place and immune to float noise.
 */
function contentSignature(members: readonly BatchMember[]): number {
  let hash = 0x811c9dc5
  const mix = (value: number) => {
    hash ^= Math.round(value * 100) | 0
    hash = Math.imul(hash, 0x01000193)
  }
  for (const member of members) {
    const { position, basis } = member.transform
    mix(position[0]); mix(position[1]); mix(position[2])
    for (let index = 0; index < 9; index += 1) mix(basis[index])
  }
  return hash >>> 0
}

/**
 * Groups drawable parts into batches keyed by definition and colour.
 *
 * Parts needing individual treatment — selection, collision flags, an active
 * transform gizmo — are returned separately so the batches stay stable while the
 * operator interacts.
 */
export function planBatches(
  members: readonly BatchMember[],
  excludedPartIds: ReadonlySet<string>,
  appearanceOf: (partId: string) => PartAppearance = () => 'solid',
): { batches: PartBatchDescriptor[]; individual: BatchMember[] } {
  const grouped = new Map<string, { definition: PartDefinition; colorCode: number; appearance: PartAppearance; members: BatchMember[] }>()
  const individual: BatchMember[] = []

  for (const member of members) {
    const definition = catalog.get(member.part.definitionId)
    if (!definition) continue
    if (excludedPartIds.has(member.part.id)) {
      individual.push(member)
      continue
    }
    // Appearance is part of the key, so a highlighted run of parts batches with
    // the other highlighted parts rather than falling out of batching entirely.
    const appearance = appearanceOf(member.part.id)
    const key = `${definition.canonicalId}:${member.part.color}:${appearance}`
    const bucket = grouped.get(key)
    if (bucket) bucket.members.push(member)
    else grouped.set(key, { definition, colorCode: member.part.color, appearance, members: [member] })
  }

  return {
    batches: [...grouped.entries()]
      .map(([key, value]) => ({ key, ...value }))
      // Stable order keeps the React tree from reshuffling between frames.
      .sort((a, b) => a.key.localeCompare(b.key)),
    individual,
  }
}
