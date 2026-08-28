import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The index is fetched by digest, so two builds of the same catalog that differ
 * by a single byte would invalidate every cache and turn the manifest into a
 * false claim. Determinism is therefore a correctness property, not a
 * convenience, and it is checked the only way that means anything: by running
 * the tool twice and comparing the files it wrote.
 *
 * The CLI is driven as a CLI rather than imported, because the reproducibility
 * being asserted belongs to the command a release runs.
 */

const run = promisify(execFile)
const TOOL = path.resolve('tools/semantic-index.mjs')
const FIXTURE = path.resolve('src/cad/__fixtures__/catalog.fixture.json')
const PUBLIC = path.resolve('public')

let workspace: string

interface BuiltIndex {
  binary: Buffer
  manifest: {
    schemaVersion: number
    version: string
    dims: number
    vocabSize: number
    docCount: number
    file: string
    bytes: number
    sha256: string
    builtAt: string
    analyzer: { ngram: number; charGramWeight: number; minDocFrequency: number; probeHash: number }
  }
}

async function build(out: string): Promise<BuiltIndex> {
  await run(process.execPath, [TOOL, '--input', FIXTURE, '--out', out, '--quiet'])
  const manifest = JSON.parse(await readFile(path.join(out, 'semantic-index.2026-07-fixture.json'), 'utf8'))
  return { binary: await readFile(path.join(out, manifest.file)), manifest }
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'brickwright-semantic-'))
}, 120_000)

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('semantic index builder', () => {
  it('produces byte-identical output from the same input', async () => {
    const first = await build(path.join(workspace, 'a'))
    const second = await build(path.join(workspace, 'b'))

    expect(second.binary.equals(first.binary)).toBe(true)
    expect(second.manifest).toEqual(first.manifest)
    console.log(
      `\nsemantic index rebuild: ${first.binary.byteLength} bytes, ` +
        `${first.manifest.dims} dims, ${first.manifest.vocabSize} terms, identical digest ${first.manifest.sha256.slice(7, 19)}`,
    )
  }, 120_000)

  it('binds the artefact to its own digest and shape', async () => {
    const built = await build(path.join(workspace, 'c'))
    const digest = createHash('sha256').update(built.binary).digest('hex')
    expect(built.manifest.sha256).toBe(`sha256:${digest}`)
    expect(built.manifest.bytes).toBe(built.binary.byteLength)
    expect(built.manifest.docCount).toBeGreaterThan(0)
    expect(built.manifest.vocabSize).toBeGreaterThan(0)
  }, 120_000)

  it('stamps the catalog build rather than the wall clock', async () => {
    const first = await build(path.join(workspace, 'd'))
    const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'))
    // A timestamp here would make every rebuild a different artefact.
    expect(first.manifest.builtAt).toBe(fixture.manifest.generatedAt)
  }, 120_000)

  it('leaves the shipped index matching the manifest beside it', async () => {
    const pointer = JSON.parse(await readFile(path.join(PUBLIC, 'catalog', 'latest.json'), 'utf8'))
    const manifest = JSON.parse(
      await readFile(path.join(PUBLIC, `semantic-index.${pointer.catalogVersion}.json`), 'utf8'),
    )
    const binary = await readFile(path.join(PUBLIC, manifest.file))
    expect(manifest.sha256).toBe(`sha256:${createHash('sha256').update(binary).digest('hex')}`)
    expect(manifest.bytes).toBe(binary.byteLength)
    expect(manifest.version).toBe(pointer.catalogVersion)
  })
})
