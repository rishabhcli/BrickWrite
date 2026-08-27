#!/usr/bin/env node
/**
 * Deterministic local bootstrap.
 *
 * The runtime catalog is committed, so a normal contributor should not need to
 * download three upstream datasets merely to open the editor. Bootstrap pins
 * the supported runtime, installs exactly from package-lock, then verifies the
 * committed catalog JSON, geometry and thumbnail bytes against their hashes.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const verifyOnly = process.argv.includes('--verify-only')
// A floor, not an exact match. Node 24 is the pinned and tested runtime (see
// .nvmrc), but refusing anything newer blocks contributors — and the whole
// suite, build and browser acceptance run pass on later majors — while the
// features this repository relies on are the ones 24 introduced.
const major = Number(process.versions.node.split('.')[0])
if (!Number.isFinite(major) || major < 24) {
  console.error(`Brickwright needs Node 24 or newer; this process is ${process.version}.`)
  console.error('Run `nvm use` to activate the pinned runtime, then rerun npm run bootstrap.')
  process.exit(1)
}

if (!verifyOnly) {
  const install = spawnSync('npm', ['ci'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (install.status !== 0) process.exit(install.status ?? 1)
}

const publicRoot = path.resolve('public')
const json = async (file) => JSON.parse(await readFile(path.join(publicRoot, file), 'utf8'))
const checked = new Set()
async function verify(relative, descriptor) {
  const target = path.resolve(publicRoot, relative)
  if (!target.startsWith(`${publicRoot}${path.sep}`)) throw new Error(`Catalog path escapes public/: ${relative}`)
  if (checked.has(target)) return
  const bytes = await readFile(target)
  if (bytes.length !== descriptor.bytes) {
    throw new Error(`${relative}: expected ${descriptor.bytes} bytes, found ${bytes.length}.`)
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  const expected = descriptor.hash.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase()
  if (!expected || actual !== expected) throw new Error(`${relative}: SHA-256 verification failed.`)
  checked.add(target)
}

const pointer = await json('catalog/latest.json')
if (pointer.manifest) await verify(pointer.manifest.path, pointer.manifest)
const manifest = await json(`catalog/${pointer.catalogVersion}/manifest.json`)
if (manifest.catalogVersion !== pointer.catalogVersion) {
  throw new Error(`latest.json points to ${pointer.catalogVersion}, but the manifest says ${manifest.catalogVersion}.`)
}

for (const descriptor of Object.values(manifest.files)) await verify(descriptor.path, descriptor)
const parts = await json(manifest.files.parts.path)
for (const part of parts) {
  if (part.geometryAsset) await verify(part.geometryAsset.file, part.geometryAsset)
  if (part.thumbnail) await verify(part.thumbnail.file, part.thumbnail)
}

console.log(
  `Brickwright bootstrap verified Node ${process.versions.node}, catalog ${pointer.catalogVersion}, ` +
    `${parts.length} placeable definitions and ${checked.size.toLocaleString()} immutable assets.`,
)
