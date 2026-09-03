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
  // Studs-not-on-top brackets and headlight bricks: the cases a translation-only
  // solver cannot place, so the snap tests need them.
  '4070', '87087', '99781', '11211',
  // Longer runs, so the assembly generators have a realistic set of lengths to
  // partition a course into rather than an artificially short one.
  '3008', '3622', '3666', '3460', '3032', '3037',
  // Windows and door frames, so a generated opening can be tested against a
  // real element seated in it rather than against a hole.
  '60592', '60593', '60594', '60596', '60616b',
  // Panes, so a glazed window can be tested rather than only a frame.
  '60601', '38320',
  // A clip that declares an axial extent, so a *sliding* joint can be derived
  // at all. Without one, `jointFor` clamps every prismatic and cylindrical
  // freedom to a zero-length range, and `articulate`'s translation path — the
  // offset arithmetic, the clamping, the emitted transform — is never once
  // exercised with a real value. Across the whole compiled catalog only clips
  // carry `axial`, and only some of them, so this has to be chosen rather than
  // assumed.
  '60897',

  // The starting document. `createShowcaseDocument` builds a whole site — deck,
  // curtain wall, roof terrace, planting, people — and it throws on a part the
  // pack does not carry, so every one of these is load-bearing for any test
  // that opens the showcase at all.
  '91405', '3036', '3958', '3006', '3007', '2456', '3062b', '3006',
  '6636', '63864', '26603', '69729', '98138', '4150', '14719',
  '3853', '57895', '59349', '30562',
  '2417', '2423', '30176', '4728', '33291', '24866', '32607',
  '3626b', '41879a', '3833', '3901', '62810', '87990', '3624', '11303', '98385',
  '3837', '4449-f1', '3899', '30162', '24093',
  '3633', '3185', '15332', '30374', '58176', '2569', '15210',
  '95343', '30150', '2489',
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
