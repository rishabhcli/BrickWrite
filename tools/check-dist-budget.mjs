#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const root = path.resolve(process.argv[2] ?? 'dist')
// 320 MiB, against 299.75 MiB measured. Raised from 200 when the ten demos were
// rebuilt as real models — the collection now carries 112,000+ editable parts,
// and most of its bytes are the stored connection graphs rather than the parts
// themselves. Unlike the file-count and single-file ceilings below, this one
// tracks no platform limit — Pages publishes no aggregate-byte limit — so it is
// ours to set against how big a deploy we are willing to push and wait on. This
// is the largest it should get without the fix described below.
const totalBudget = Number(process.env.DIST_TOTAL_BUDGET_BYTES ?? 320 * 1024 * 1024)
const fileBudget = Number(process.env.DIST_FILE_COUNT_BUDGET ?? 16_000)
// 24 MiB, against a 25 MiB platform ceiling. The margin is thin and the reason
// is worth stating plainly: roughly four fifths of a demo `document.json` is its
// `connections` map, which the kernel *derives* — `deriveConnectionEdges` runs
// over the parts on import, and `src/demos/manifest.test.ts` asserts the derived
// graph matches the stored one edge for edge. Shipping it is therefore shipping
// a cache. Dropping it from the published documents would take every demo back
// under 6 MiB and make this ceiling irrelevant; until that is done, growing a
// demo means checking this number.
const largestBudget = Number(process.env.DIST_SINGLE_FILE_BUDGET_BYTES ?? 24 * 1024 * 1024)
const shippedHeadBudget = Number(process.env.DIST_SHIPPED_HEAD_BUDGET_BYTES ?? 220 * 1024)

const files = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(absolute)
    else if (entry.isFile()) files.push({ path: path.relative(root, absolute), bytes: (await stat(absolute)).size })
  }
}

await walk(root)
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
const largest = files.reduce((current, file) => (file.bytes > current.bytes ? file : current), { path: '', bytes: 0 })
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

const indexHtml = await readFile(path.join(root, 'index.html'), 'utf8')
const headHrefs = [...indexHtml.matchAll(/\b(?:href|src)="(\/assets\/[^"]+)"/g)].map((match) => match[1])
const hexclaveInHead = headHrefs.filter((href) => /hexclave/i.test(href))
let shippedHeadGzip = 0
for (const href of new Set(headHrefs)) {
  const file = files.find((entry) => entry.path.replaceAll('\\', '/') === href.replace(/^\//, ''))
  if (!file) continue
  shippedHeadGzip += gzipSync(await readFile(path.join(root, file.path))).length
}

const report = {
  root,
  totalBytes,
  files: files.length,
  largest,
  shippedHeadGzip,
  hexclaveInHead,
  budgets: { totalBytes: totalBudget, files: fileBudget, largestBytes: largestBudget, shippedHeadGzip: shippedHeadBudget },
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

const failures = []
if (totalBytes > totalBudget) failures.push(`total ${mib(totalBytes)} exceeds ${mib(totalBudget)}`)
if (files.length > fileBudget) failures.push(`${files.length} files exceeds ${fileBudget}`)
if (largest.bytes > largestBudget) failures.push(`${largest.path} is ${mib(largest.bytes)}, exceeding ${mib(largestBudget)}`)
if (hexclaveInHead.length) failures.push(`index.html preloads Hexclave: ${hexclaveInHead.join(', ')}`)
if (shippedHeadGzip > shippedHeadBudget) {
  failures.push(`index.html head is ${(shippedHeadGzip / 1024).toFixed(0)} KiB gzip, exceeding ${(shippedHeadBudget / 1024).toFixed(0)} KiB`)
}
if (failures.length) throw new Error(`Distribution budget exceeded: ${failures.join('; ')}`)

process.stdout.write(
  `dist budget ok — ${mib(totalBytes)}, ${files.length} files, largest ${largest.path} at ${mib(largest.bytes)}, head ${(shippedHeadGzip / 1024).toFixed(0)} KiB gzip\n`,
)
