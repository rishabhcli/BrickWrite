import { type ThreeEvent } from '@react-three/fiber'
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { catalog } from '../cad/catalog'
import { MAIN_COLOUR, type PartGeometry } from '../cad/mesh'
import type { PartDefinition, PartInstance, Transform } from '../cad/types'
import { useEdgeLodRegistration } from './render/EdgeLod'
import { usePartGeometry } from './render/usePartGeometry'
import { registerPickable, unregisterPickable } from './render/idPass'
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
 *
 * The same instanced meshes serve the GPU identity pass. `idBase` hands a batch
 * the first identity of a contiguous range, and the id shader adds
 * `gl_InstanceID` to it, so picking a five-thousand-brick model costs the same
 * draw calls as drawing it.
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

const MERGED_EDGE_VERTEX_BUDGET = 600_000

/** Geometric slack buckets; a live batch never shrinks its allocated buffer. */
export function instanceCapacity(required: number, previous = 0): number {
  if (required <= previous) return previous
  let capacity = Math.max(32, previous)
  while (capacity < required) capacity *= 2
  return capacity
}

const matrixOf = (transform: Transform, target: THREE.Matrix4): THREE.Matrix4 => {
  const b = transform.basis
  const [x, y, z] = transform.position
  return target.set(b[0], b[1], b[2], x, b[3], b[4], b[5], y, b[6], b[7], b[8], z, 0, 0, 0, 1)
}

/**
 * Brings a batch's instance buffer up to date, writing only what moved.
 *
 * `planBatches` builds fresh member arrays on every commit, so the effect that
 * uploads them used to rewrite *every* matrix in *every* batch whenever the
 * document changed — adding one brick to a 5,000-part model rebuilt 5,000
 * matrices across 42 batches and recomputed 42 bounding spheres, all to move one
 * of them. Measured on an M3 Max over 5,000 parts in 42 batches: that
 * unconditional path cost 1.43 ms of main-thread time per commit, and this one
 * costs 0.35 ms when nothing moved and 0.44 ms when one brick did.
 *
 * The comparison is against **the buffer itself** rather than against a cached
 * copy of the previous plan, which makes it correct by construction: a write is
 * skipped exactly when `instanceMatrix` already holds the sixteen floats it
 * would receive. A reference check on the `Transform` object is tempting and was
 * measured — it took the unchanged case from 0.35 ms to 0.05 ms — but it reports
 * "unchanged" for a transform mutated in place, and did: the benchmark that
 * measured it also caught it reporting nothing written for a brick that had
 * moved. A silently stale brick is not worth 0.3 ms.
 *
 * `Math.fround` is what makes the comparison honest: the buffer is 32-bit, so a
 * basis element of `cos 45°` is stored rounded, and comparing the stored value
 * against the 64-bit source would report every rotated part as moved on every
 * commit — which is the whole cost this function exists to avoid.
 *
 * Returns the number of matrices written, which is what a test can assert on:
 * "unchanged poses cost no writes" is the property, and a count is the only way
 * to see it from outside.
 */
export function writeInstanceMatrices(mesh: THREE.InstancedMesh, members: readonly BatchMember[]): number {
  const array = mesh.instanceMatrix.array
  let written = 0
  for (let index = 0; index < members.length; index += 1) {
    const b = members[index].transform.basis
    const [x, y, z] = members[index].transform.position
    const at = index * 16
    // Column-major, the layout `Matrix4.set` produces and `InstancedMesh` uploads.
    if (
      array[at] === Math.fround(b[0]) && array[at + 4] === Math.fround(b[1]) && array[at + 8] === Math.fround(b[2]) &&
      array[at + 1] === Math.fround(b[3]) && array[at + 5] === Math.fround(b[4]) && array[at + 9] === Math.fround(b[5]) &&
      array[at + 2] === Math.fround(b[6]) && array[at + 6] === Math.fround(b[7]) && array[at + 10] === Math.fround(b[8]) &&
      array[at + 12] === Math.fround(x) && array[at + 13] === Math.fround(y) && array[at + 14] === Math.fround(z) &&
      array[at + 15] === 1
    ) {
      continue
    }
    array[at] = b[0]; array[at + 4] = b[1]; array[at + 8] = b[2]; array[at + 12] = x
    array[at + 1] = b[3]; array[at + 5] = b[4]; array[at + 9] = b[5]; array[at + 13] = y
    array[at + 2] = b[6]; array[at + 6] = b[7]; array[at + 10] = b[8]; array[at + 14] = z
    array[at + 3] = 0; array[at + 7] = 0; array[at + 11] = 0; array[at + 15] = 1
    written += 1
  }
  return written
}

interface PartBatchProps {
  descriptor: PartBatchDescriptor
  showEdges: boolean
  silhouette: boolean
  /** False while a placement ghost owns the pointer, so a drop cannot also select. */
  interactive?: boolean
  /**
   * First GPU identity for this batch, or undefined to leave it out of picking.
   *
   * Ghosted context is drawn with no base, which is what makes "what you cannot
   * see, you cannot select" a property of the pass rather than a filter applied
   * to its results.
   */
  idBase?: number
  /** Opacity multiplier for ghosted context. 1 leaves the material untouched. */
  ghostOpacity?: number
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
}

export const PartBatch = memo(function PartBatch({
  descriptor,
  showEdges,
  silhouette,
  interactive = true,
  idBase,
  ghostOpacity = 1,
  onSelect,
}: PartBatchProps) {
  const instances = useRef<THREE.InstancedMesh>(null)
  const geometry = usePartGeometry(descriptor.definition)
  const capacityRef = useRef(0)
  const capacity = instanceCapacity(descriptor.members.length, capacityRef.current)
  useLayoutEffect(() => { capacityRef.current = capacity }, [capacity])

  const materials = useMemo(() => {
    if (!geometry) return []
    // Slice colour 16 takes the instance colour; anything else is baked into the
    // part, such as a black rubber tyre or a printed face.
    return geometry.slices.map((slice) =>
      surfaceMaterialFor(
        slice.colour === MAIN_COLOUR ? (silhouette ? 71 : descriptor.colorCode) : slice.colour,
        descriptor.appearance,
        ghostOpacity < 1 ? { fade: ghostOpacity } : undefined,
      ),
    )
  }, [geometry, descriptor.colorCode, descriptor.appearance, silhouette, ghostOpacity])

  useLayoutEffect(() => {
    const mesh = instances.current
    if (!mesh) return
    const written = writeInstanceMatrices(mesh, descriptor.members)
    const resized = mesh.count !== descriptor.members.length
    mesh.count = descriptor.members.length
    // Uploading a buffer nobody changed, and recomputing a bounding sphere over
    // every instance to arrive at the same sphere, is the per-commit cost this
    // guard exists to skip: one edit touches one batch, not all of them.
    if (written > 0 || resized) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
    }
    // A raycast run outside React — the placement ghost does exactly that — gets
    // back an object and an instance index, so the batch has to say which part
    // each index stands for.
    mesh.userData.members = descriptor.members
  }, [descriptor.members, geometry, capacity])

  // Identity registration follows the batch's own lifetime. Re-running it when
  // the base changes matters: the registry is rebuilt whenever the plan changes,
  // and a mesh still carrying last plan's base would resolve picks to the wrong
  // parts rather than to none, which is the worse of the two failures.
  useLayoutEffect(() => {
    const mesh = instances.current
    if (!mesh) return
    if (idBase === undefined) {
      unregisterPickable(mesh)
      return
    }
    registerPickable(mesh, idBase)
    return () => unregisterPickable(mesh)
  }, [idBase, geometry, capacity, descriptor.members.length])

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
        // The key forces a fresh buffer only when the slack bucket grows, since
        // InstancedMesh capacity is fixed at construction.
        key={`${descriptor.key}:${capacity}`}
        args={[geometry.surface, undefined as unknown as THREE.Material, capacity]}
        material={materials}
        castShadow
        receiveShadow
        onPointerDown={interactive ? handlePointer : undefined}
        onDoubleClick={interactive ? (event) => {
          if (!interactive || event.instanceId === undefined) return
          const member = descriptor.members[event.instanceId]
          if (!member) return
          event.stopPropagation()
          onSelect(member.part.id, false, true)
        } : undefined}
      />
      {showEdges && geometry.edges && !silhouette && (
        <BatchEdges descriptor={descriptor} geometry={geometry} opacity={0.34 * ghostOpacity} />
      )}
    </group>
  )
})

/**
 * A part's own line segments, longest first.
 *
 * The ordering is what makes a shortened `drawRange` survivable. A compiled
 * LDraw brick is mostly *stud* edges — a 2×4 carries about 216 line segments and
 * only twelve of them are the box — so a uniform sample at a quarter density
 * keeps a scatter of stud chords and loses corners, which reads as a brick
 * dissolving. Taking the longest segments first keeps the outline and spends the
 * cut on the chords nobody can resolve anyway.
 *
 * Cached against the source attribute, which the geometry cache shares across
 * every batch and every instance of a definition, so the sort happens once per
 * part shape rather than once per batch.
 */
const segmentOrderCache = new WeakMap<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, Int32Array>()

function segmentsByLength(source: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Int32Array {
  const cached = segmentOrderCache.get(source)
  if (cached) return cached
  const count = Math.floor(source.count / 2)
  const lengths = new Float32Array(count)
  for (let segment = 0; segment < count; segment += 1) {
    const a = segment * 2
    const dx = source.getX(a + 1) - source.getX(a)
    const dy = source.getY(a + 1) - source.getY(a)
    const dz = source.getZ(a + 1) - source.getZ(a)
    lengths[segment] = dx * dx + dy * dy + dz * dz
  }
  const order = new Int32Array(count)
  for (let segment = 0; segment < count; segment += 1) order[segment] = segment
  // Ties break on index so two identical parts order their edges identically and
  // a still camera cannot produce a different buffer from one commit to the next.
  order.sort((a, b) => lengths[b] - lengths[a] || a - b)
  segmentOrderCache.set(source, order)
  return order
}

/**
 * Bakes a batch's member transforms into one merged line buffer.
 *
 * Line geometry has no instanced equivalent without a custom shader, so drawing
 * edges per part costs one call each — which measurably dominated the frame once
 * batching had flattened the surface calls. Merging restores one draw call per
 * batch. Samples complete segments when over budget, keeping bounded edges even
 * for very large batches. Returns null only for empty geometry or zero budget.
 *
 * The emission order has two jobs, and they are independent:
 *
 *   - **Across members**, a coprime stride, so a prefix covers the whole batch
 *     rather than its first few parts. This is what keeps a shortened
 *     `drawRange` spatially distributed.
 *   - **Within a member**, longest edge first, so a shortened `drawRange` costs
 *     each part its stud chords and not its corners.
 *
 * A full draw contains exactly the segments it always did, in a different order,
 * so nothing changes for a model inside its budget.
 *
 * Exported so the benchmark builds its scene from the same code the viewport
 * does; an edge path that only the editor exercised would be the first thing to
 * drift out of the measurement.
 */
export function buildMergedEdgeGeometry(
  members: readonly BatchMember[],
  edges: THREE.BufferGeometry | null,
  vertexBudget = MERGED_EDGE_VERTEX_BUDGET,
): THREE.BufferGeometry | null {
  const source = edges?.getAttribute('position')
  if (!source) return null
  const perInstance = source.count
  const availableSegments = Math.floor(perInstance / 2) * members.length
  const segments = Math.min(availableSegments, Math.max(0, Math.floor(vertexBudget / 2)))
  const total = segments * 2
  if (total === 0) return null

  const positions = new Float32Array(total * 3)
  const matrix = new THREE.Matrix4()
  const vertex = new THREE.Vector3()
  const order = segmentsByLength(source)
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b)
  let stride = Math.max(1, Math.floor(members.length * 0.6180339887498949))
  while (gcd(stride, members.length) !== 1) stride += 1
  for (let segment = 0; segment < segments; segment += 1) {
    // Rank-major: every member contributes its longest edge before any member
    // contributes its second longest. Within a rank the coprime stride walks the
    // members so a prefix shorter than the batch still spans it, and no
    // (member, edge) pair can repeat because indices within one rank are
    // distinct modulo the member count.
    const rank = order[Math.floor(segment / members.length)]
    const member = members[(segment * stride) % members.length]
    matrixOf(member.transform, matrix)
    const start = rank * 2
    for (let endpoint = 0; endpoint < 2; endpoint += 1) {
      vertex.fromBufferAttribute(source, start + endpoint).applyMatrix4(matrix)
      vertex.toArray(positions, (segment * 2 + endpoint) * 3)
    }
  }
  const buffer = new THREE.BufferGeometry()
  buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return buffer
}

/**
 * Hard edges for a whole batch, merged into one buffer.
 *
 * The buffer is rebuilt only when the batch's membership or poses change, which
 * happens on commit rather than per frame.
 */
function BatchEdges({
  descriptor,
  geometry,
  opacity,
}: {
  descriptor: PartBatchDescriptor
  geometry: PartGeometry
  opacity: number
}) {
  const material = useMemo(() => {
    const base = catalog.color(descriptor.colorCode)
    return new THREE.LineBasicMaterial({ color: base.edge, transparent: true, opacity, depthWrite: false })
  }, [descriptor.colorCode, opacity])
  useEffect(() => () => material.dispose(), [material])

  // `planBatches` builds fresh member arrays on every commit, so memoizing on
  // array identity rebuilt every merged buffer in the model for an edit that
  // touched one brick. The signature is what actually decides the buffer's
  // contents, and computing it is O(members) arithmetic against O(members ×
  // edge vertices) of matrix work.
  const signature = useMemo(() => contentSignature(descriptor.members), [descriptor.members])

  const merged = useMemo(
    () => buildMergedEdgeGeometry(descriptor.members, geometry.edges),
     
    [signature, geometry],
  )

  const lines = useRef<THREE.LineSegments>(null)
  useEdgeLodRegistration(descriptor.key, lines, merged)

  // Merged buffers are owned by this component, so they are disposed with it.
  useEffect(() => () => merged?.dispose(), [merged])

  if (!merged) return null
  return <lineSegments ref={lines} geometry={merged} material={material} userData={{ partBatchEdges: true }} />
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
