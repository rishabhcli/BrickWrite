#!/usr/bin/env node
/**
 * Extracts a small slice of the compiled catalog for unit tests.
 *
 * Tests run against real compiled records — real bounds, real LDCad connectors,
 * real colour evidence — so a kernel test that passes means the kernel handles
 * actual LDraw parts, not a convenient stand-in.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const IDS = [
  '3001', '3002', '3003', '3004', '3005', '3009', '3010',
  '3020', '3021', '3022', '3023b', '3024', '3031', '3034', '3035', '3623', '3710', '3795',
  '3068b', '3069b', '3070b', '2431', '4162', '87079', '2412b',
  '3039', '3040b', '3298', '4286', '30363', '54200', '15068', '11477',
  '62360', '3937', '3938', '32524', '3706', '2780', '55982', '4032a',
]

const [, , catalogRoot = 'public', version = '2026-07', out = 'src/cad/__fixtures__/catalog.fixture.json'] = process.argv

const base = path.join(catalogRoot, 'catalog', version)
const parts = JSON.parse(await readFile(path.join(base, 'parts.json'), 'utf8'))
const search = JSON.parse(await readFile(path.join(base, 'search.json'), 'utf8'))
const colors = JSON.parse(await readFile(path.join(base, 'colors.json'), 'utf8'))
const manifest = JSON.parse(await readFile(path.join(base, 'manifest.json'), 'utf8'))
const allAliases = JSON.parse(await readFile(path.join(base, 'aliases.json'), 'utf8'))

const wanted = new Set(IDS)
const selectedParts = parts.filter((part) => wanted.has(part.canonicalId))
const missing = IDS.filter((id) => !selectedParts.some((part) => part.canonicalId === id))
if (missing.length) throw new Error(`Fixture parts absent from the compiled pack: ${missing.join(', ')}`)

// Keep only the renames that land on a fixture part, so alias resolution is
// exercised without shipping the whole rename table.
const aliases = Object.fromEntries(Object.entries(allAliases).filter(([, to]) => wanted.has(to)))
if (!Object.keys(aliases).length) throw new Error('Fixture contains no renamed LDraw aliases to test against')

const payload = {
  manifest: {
    ...manifest,
    catalogVersion: `${manifest.catalogVersion}-fixture`,
    counts: { ...manifest.counts, packParts: selectedParts.length },
  },
  parts: selectedParts,
  search: search.filter((entry) => wanted.has(entry.id)),
  colors,
  aliases,
}

await writeFile(out, `${JSON.stringify(payload)}\n`)
console.log(`${out}: ${selectedParts.length} parts, ${payload.search.length} search records, ${colors.length} colours, ${Object.keys(aliases).length} aliases`)
