import { catalog } from '../../../cad/catalog'
import { verifyAsset } from '../../../cad/integrity'
import { decodeMesh } from '../../../cad/mesh'
import type { ShareMesh } from '../render/scene'

/**
 * Raw geometry for the read-only viewer.
 *
 * `src/cad/mesh.ts` already has a cache, but it hands back `THREE.BufferGeometry`
 * for the WebGL editor and drops the plain typed arrays on the way. The viewer
 * rasterises in software and needs the arrays, so it keeps its own cache over
 * the same immutable, content-addressed assets — the bytes are identical and
 * verified by the same hash, so nothing diverges.
 *
 * Verification is not optional here. A published page is the one surface a
 * stranger reaches, and geometry that failed its hash is geometry this build
 * cannot vouch for.
 */

const meshes = new Map<string, ShareMesh | null>()
const inFlight = new Map<string, Promise<ShareMesh | null>>()

export interface GeometryProgress {
  loaded: number
  total: number
  /** Definition ids this build cannot draw at all. */
  unavailable: string[]
  failed: Array<{ definitionId: string; reason: string }>
}

async function loadOne(definitionId: string, baseUrl: string): Promise<ShareMesh | null> {
  const asset = catalog.get(definitionId)?.geometryAsset
  if (!asset) return null
  const response = await fetch(`${baseUrl}/${asset.file}`)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  await verifyAsset(buffer, asset, `Geometry ${definitionId}`)
  const decoded = decodeMesh(buffer)
  return { positions: decoded.positions, indices: decoded.indices, slices: decoded.slices }
}

/**
 * Loads every definition a publication references.
 *
 * Failures are collected rather than thrown: one unreadable asset should cost
 * the viewer one part, not the whole page, and the caller is told exactly which
 * parts are missing so it can say so instead of quietly drawing a gap.
 */
export async function loadPublicationGeometry(
  definitionIds: readonly string[],
  options: { baseUrl?: string; onProgress?: (progress: GeometryProgress) => void } = {},
): Promise<GeometryProgress> {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '')
  const unique = [...new Set(definitionIds)]
  const progress: GeometryProgress = { loaded: 0, total: unique.length, unavailable: [], failed: [] }

  await Promise.all(
    unique.map(async (definitionId) => {
      try {
        if (!meshes.has(definitionId)) {
          let pending = inFlight.get(definitionId)
          if (!pending) {
            pending = loadOne(definitionId, baseUrl)
            inFlight.set(definitionId, pending)
          }
          const mesh = await pending
          meshes.set(definitionId, mesh)
          inFlight.delete(definitionId)
        }
        if (meshes.get(definitionId) === null) progress.unavailable.push(definitionId)
      } catch (cause) {
        inFlight.delete(definitionId)
        meshes.set(definitionId, null)
        progress.failed.push({
          definitionId,
          reason: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        progress.loaded += 1
        options.onProgress?.({ ...progress })
      }
    }),
  )

  progress.unavailable.sort()
  progress.failed.sort((a, b) => a.definitionId.localeCompare(b.definitionId))
  return progress
}

/** The resolver the rasteriser takes. Resident geometry only; never fetches. */
export const residentGeometry = (definitionId: string): ShareMesh | null => meshes.get(definitionId) ?? null

/** Test and navigation affordance: forget everything loaded so far. */
export function clearGeometryCache(): void {
  meshes.clear()
  inFlight.clear()
}
