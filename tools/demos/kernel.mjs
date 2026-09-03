/**
 * The CAD kernel, loaded once for the whole demo build.
 *
 * The kernel is TypeScript and imports without file extensions, so the modules
 * come through Vite's own module runner rather than Node's strip-only
 * TypeScript support: the tool then sees byte-for-byte the same kernel the
 * browser does, with no second transpiler to drift against.
 *
 * Everything here is process-wide and side-effecting — one Vite server, one
 * installed catalog, one mesh cache — so this module is imported, never copied.
 */
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CATALOG_ROOT = path.join(ROOT, 'public')

/**
 * Every timestamp the demos carry.
 *
 * A generated document that stamps `new Date()` is not reproducible, and a
 * manifest whose bytes change on every run cannot be diffed, cached or verified.
 * The demos are content, so they are dated by the catalog build they were
 * authored against rather than by when the script happened to run.
 */
export const AUTHORED_AT = '2026-07-01T00:00:00.000Z'

/**
 * The build is only reproducible on the pinned Node — and on CI's platform.
 *
 * `encodePng` compresses through `node:zlib`, and deflate output for the same
 * pixels follows whichever zlib the running Node was linked against. The Node
 * version alone is not enough: on 2026-09-02 the whole collection was rebuilt on
 * Homebrew's Node 24.19.0 and rejected by CI running Node 24.19.0, because
 * macOS arm64 and Linux x64 disagree on every PNG while producing identical
 * documents. `--platform linux/amd64` is not pedantry either; zlib-ng selects
 * SIMD match finders per architecture.
 *
 * This guard can only see the major, so it is a floor, not a guarantee.
 * Regenerate committed assets the way CI will read them:
 *
 *   docker run --rm --platform linux/amd64 -v "$PWD":/w -v /w/node_modules \
 *     -w /w node:24.19.0 bash -c "npm ci && node tools/build-demos.mjs"
 */
const PINNED_NODE = Number(readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim())
const RUNNING_NODE = Number(process.versions.node.split('.')[0])
if (RUNNING_NODE !== PINNED_NODE) {
  console.error(
    `This build must run on Node ${PINNED_NODE} (.nvmrc); this is Node ${RUNNING_NODE}.\n` +
      "Its PNG bytes come from that version's zlib, so another major silently\n" +
      'regenerates every asset and fails the determinism gate in CI.',
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Kernel access
// ---------------------------------------------------------------------------

const server = await createServer({
  root: ROOT,
  configFile: false,
  server: { middlewareMode: true, watch: null },
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
})
const runner = server.environments.ssr.runner
const load = (module) => runner.import(`/src/cad/${module}.ts`)

const [
  catalogModule,
  assemblyModule,
  collisionModule,
  geometryModule,
  instructionsModule,
  mathModule,
  meshModule,
  placementModule,
  rasterModule,
  snappingModule,
  staticsModule,
  validationModule,
] = await Promise.all([
  load('catalog'),
  load('assembly'),
  load('collision'),
  load('geometry'),
  load('instructions'),
  load('math'),
  load('mesh'),
  load('placement'),
  load('raster'),
  load('snapping'),
  load('statics'),
  load('validation'),
])

export const { catalog, getColor, originForSurface, surfaceAbove, STUD_LDU, PLATE_LDU, BRICK_LDU } = catalogModule
export const {
  planEnclosure,
  planBrickField,
  planWall,
  planLattice,
  planClockFaces,
  planHingedFlap,
  planCrane,
  planSnotHull,
  elementLibrary,
} = assemblyModule
export const { findCollisions, geometryFromArrays } = collisionModule
export const { getPartBounds } = geometryModule
export const { computeBuildOrder, verifyBuildOrder } = instructionsModule
export const { basisFromEulerDegrees, cleanBasis } = mathModule
export const { decodeMesh } = meshModule
export const { QUARTER_TURN_BASES } = placementModule
export const { frameScene, renderScene, rgbFromHex } = rasterModule
export const { bestSnapTransform, deriveConnectionEdges } = snappingModule
export const { analyseStatics, describeMass, describeSupport } = staticsModule
export const { validateDocument, findWeakAttachments } = validationModule

// ---------------------------------------------------------------------------
// Catalog + compiled geometry
// ---------------------------------------------------------------------------

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

const pointer = await readJson(path.join(CATALOG_ROOT, 'catalog', 'latest.json'))
export const catalogVersion = pointer.catalogVersion
const versionRoot = path.join(CATALOG_ROOT, 'catalog', catalogVersion)
export const catalogManifest = await readJson(path.join(versionRoot, 'manifest.json'))
const [parts, search, colors, aliases] = await Promise.all([
  readJson(path.join(versionRoot, 'parts.json')),
  readJson(path.join(versionRoot, 'search.json')),
  readJson(path.join(versionRoot, 'colors.json')),
  readJson(path.join(versionRoot, 'aliases.json')),
])
catalog.install({ manifest: catalogManifest, parts, search, colors, aliases })

/** Decoded compiled meshes, keyed by definition id, loaded on first request. */
export const meshCache = new Map()
export async function meshFor(definitionId) {
  if (meshCache.has(definitionId)) return meshCache.get(definitionId)
  const definition = catalog.get(definitionId)
  const asset = definition?.geometryAsset
  if (!asset) {
    meshCache.set(definitionId, null)
    return null
  }
  const buffer = await readFile(path.join(CATALOG_ROOT, asset.file))
  const decoded = decodeMesh(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  meshCache.set(definitionId, decoded)
  return decoded
}

/** Warms every mesh a document references, so the checks below are synchronous. */
export async function warmGeometry(document) {
  await Promise.all([...new Set(Object.values(document.parts).map((part) => part.definitionId))].map(meshFor))
}

const threeCache = new Map()
/**
 * Triangle geometry for the collision kernel.
 *
 * Without this the collision pass falls back to bounding boxes and reports
 * `unknown` certainty, and a demo that ships on an unverified verdict is exactly
 * what the gate exists to prevent.
 */
export const geometryProvider = (definitionId) => {
  if (threeCache.has(definitionId)) return threeCache.get(definitionId)
  const mesh = meshCache.get(definitionId)
  const geometry = mesh ? geometryFromArrays(mesh.positions, mesh.indices, mesh.normals) : null
  threeCache.set(definitionId, geometry)
  return geometry
}

/** Releases the module runner once a build has finished with the kernel. */
export const closeKernel = () => server.close()
