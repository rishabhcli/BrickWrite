#!/usr/bin/env node
/**
 * Downloads the three source datasets the catalog compiler consumes into
 * `.sources/` (gitignored). Each dataset stays in its own directory so
 * provenance and licensing remain separable.
 *
 *   LDraw Parts Library   library.ldraw.org  ~145 MB
 *   LDCad Shadow Library  github.com          ~2 MB
 *   Rebrickable bulk CSV  cdn.rebrickable.com ~140 MB uncompressed
 *
 * Rebrickable data is fetched for local compilation only. Review the current
 * Rebrickable terms before redistributing anything derived from it.
 */
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'

const run = promisify(execFile)
const ROOT = path.resolve('.sources')

const REBRICKABLE_TABLES = ['parts', 'part_categories', 'colors', 'elements', 'inventory_parts', 'part_relationships']

async function exists(target) {
  try { await stat(target); return true } catch { return false }
}

async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`${url} → ${response.status} ${response.statusText}`)
  await pipeline(response.body, createWriteStream(destination))
}

async function downloadGzip(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`${url} → ${response.status} ${response.statusText}`)
  await pipeline(response.body, createGunzip(), createWriteStream(destination))
}

async function main() {
  const force = process.argv.includes('--force')
  await mkdir(ROOT, { recursive: true })

  if (force || !(await exists(path.join(ROOT, 'ldraw', 'LDConfig.ldr')))) {
    console.log('LDraw Parts Library …')
    const zip = path.join(ROOT, 'ldraw-complete.zip')
    await download('https://library.ldraw.org/library/updates/complete.zip', zip)
    await rm(path.join(ROOT, 'ldraw'), { recursive: true, force: true })
    await run('unzip', ['-q', '-o', zip, '-d', ROOT])
  } else {
    console.log('LDraw Parts Library … cached')
  }

  if (force || !(await exists(path.join(ROOT, 'LDCadShadowLibrary-main', 'LICENSE.md')))) {
    console.log('LDCad Shadow Library …')
    const zip = path.join(ROOT, 'shadow.zip')
    await download('https://codeload.github.com/RolandMelkert/LDCadShadowLibrary/zip/refs/heads/main', zip)
    await run('unzip', ['-q', '-o', zip, '-d', ROOT])
  } else {
    console.log('LDCad Shadow Library … cached')
  }

  const rebrickable = path.join(ROOT, 'rebrickable')
  await mkdir(rebrickable, { recursive: true })
  for (const table of REBRICKABLE_TABLES) {
    const csv = path.join(rebrickable, `${table}.csv`)
    if (!force && (await exists(csv))) {
      console.log(`Rebrickable ${table} … cached`)
      continue
    }
    console.log(`Rebrickable ${table} …`)
    await downloadGzip(`https://cdn.rebrickable.com/media/downloads/${table}.csv.gz`, csv)
  }

  console.log('\nSources ready. Compile with:\n  npm run catalog:build')
}

await main()
