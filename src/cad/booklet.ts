import { buildBom, type BomLine } from './bom'
import { catalog, getColor } from './catalog'
import { computeBuildOrder, verifyBuildOrder } from './instructions'
import { frameScene, renderScene, rgbFromHex, type RasterImage, type RasterPart } from './raster'
import type { ModelDocument, PartInstance } from './types'
import type { Vec3 } from './math'

/**
 * Printable instruction booklet.
 *
 * The kernel already guarantees the one property that makes a sequence buildable
 * at all — every step attaches to structure placed earlier — and the booklet's
 * job is to put that guarantee in front of a person holding actual bricks. It is
 * a single self-contained HTML file: images inline as data URLs, print rules in
 * a `@page` block, no network dependency once saved. A PDF would need a
 * generator in the bundle to say less.
 *
 * Two rendering decisions carry most of the legibility:
 *
 *   - **One camera for the whole booklet.** Framing comes from the finished
 *     model, so the assembly grows inside a fixed frame instead of jumping
 *     between pages.
 *   - **Placed parts are washed, new parts are not, and new parts are outlined.**
 *     That is the convention printed instructions use, and it survives a
 *     monochrome printer.
 *
 * What it does not claim: the *grouping* is the kernel's reachable ordering, not
 * an instruction designer's. It will not defer internals until they matter or
 * decide where a sub-model would help.
 */

export interface BookletMesh {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly slices: ReadonlyArray<{ colour: number; start: number; count: number }>
}

export interface BookletInput {
  readonly document: ModelDocument
  /** Resolves compiled geometry; null for a part this build cannot draw. */
  readonly geometry: (definitionId: string) => BookletMesh | null
  /** Turns a rendered buffer into an `<img src>` value. */
  readonly encode: (image: RasterImage) => string
  readonly pageWidth?: number
  readonly pageHeight?: number
  readonly supersample?: number
  /** Overrides the generation timestamp, so output can be byte-compared. */
  readonly generatedAt?: string
}

export interface BookletResult {
  readonly html: string
  readonly steps: number
  readonly parts: number
  /** True when every step after the first attaches to earlier structure. */
  readonly buildOrderVerified: boolean
  readonly bom: BomLine[]
  readonly warnings: string[]
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Union of every part's transformed bounds, in document space. */
function sceneBounds(
  parts: readonly PartInstance[],
  geometry: (definitionId: string) => BookletMesh | null,
): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const part of parts) {
    const mesh = geometry(part.definitionId)
    if (!mesh) continue
    const { position, basis } = part.transform
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const x = mesh.positions[index]
      const y = mesh.positions[index + 1]
      const z = mesh.positions[index + 2]
      const wx = basis[0] * x + basis[1] * y + basis[2] * z + position[0]
      const wy = basis[3] * x + basis[4] * y + basis[5] * z + position[1]
      const wz = basis[6] * x + basis[7] * y + basis[8] * z + position[2]
      if (wx < min[0]) min[0] = wx
      if (wy < min[1]) min[1] = wy
      if (wz < min[2]) min[2] = wz
      if (wx > max[0]) max[0] = wx
      if (wy > max[1]) max[1] = wy
      if (wz > max[2]) max[2] = wz
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [1, 1, 1] }
  return { min, max }
}

const palette = (code: number) => rgbFromHex(getColor(code).hex)

function rasterPartsFor(
  parts: readonly PartInstance[],
  newIds: ReadonlySet<string>,
  geometry: (definitionId: string) => BookletMesh | null,
): RasterPart[] {
  const collected: RasterPart[] = []
  for (const part of parts) {
    const mesh = geometry(part.definitionId)
    if (!mesh) continue
    collected.push({
      positions: mesh.positions,
      indices: mesh.indices,
      slices: mesh.slices,
      transform: part.transform,
      rgb: palette(part.color),
      isNew: newIds.has(part.id),
    })
  }
  return collected
}

/**
 * Builds the booklet.
 *
 * Steps come from the document when it has them and are generated otherwise, so
 * exporting never silently produces a one-page booklet for a model whose steps
 * were never sequenced.
 */
export function buildBooklet(input: BookletInput): BookletResult {
  const { document: model, geometry, encode } = input
  const pageWidth = input.pageWidth ?? 760
  const pageHeight = input.pageHeight ?? 470
  const supersample = input.supersample ?? 2
  const warnings: string[] = []

  const allParts = Object.values(model.parts)
  const missing = allParts.filter((part) => !geometry(part.definitionId))
  if (missing.length) {
    const ids = [...new Set(missing.map((part) => part.definitionId))]
    warnings.push(
      `${missing.length} part${missing.length === 1 ? '' : 's'} could not be drawn because this build has no compiled ` +
        `geometry for ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ` and ${ids.length - 6} more` : ''}. ` +
        'They are listed in the parts list but absent from the step images.',
    )
  }

  let steps = model.steps.filter((step) => step.partIds.length)
  if (!steps.length && allParts.length) {
    const generated = computeBuildOrder(model)
    steps = generated.steps
    warnings.push('The document had no sequenced steps, so a build order was generated for this booklet only.')
    for (const warning of generated.warnings) warnings.push(warning.message)
  }
  const verification = verifyBuildOrder(model, steps)
  if (!verification.valid) {
    warnings.push(
      `${verification.violations.length} part${verification.violations.length === 1 ? '' : 's'} in this sequence attach ` +
        'to nothing placed earlier. Each begins a separately-built subassembly, which is legitimate, but the ' +
        'booklet does not tell the builder where to put it down.',
    )
  }

  // One framing for every page, taken from the finished model.
  const framing = frameScene(sceneBounds(allParts, geometry), pageWidth, pageHeight, { supersample })

  const ordered = [...steps].sort((a, b) => a.index - b.index)
  const placed: PartInstance[] = []
  const stepPages: string[] = []
  let runningTotal = 0

  for (const [order, step] of ordered.entries()) {
    const introduced = step.partIds.map((id) => model.parts[id]).filter((part): part is PartInstance => Boolean(part))
    placed.push(...introduced)
    runningTotal += introduced.length

    const image = renderScene(rasterPartsFor(placed, new Set(step.partIds), geometry), framing, {
      palette,
      outlineNew: true,
    })
    const strip = introduced.length ? partStrip(introduced, geometry, encode, supersample) : ''

    stepPages.push(`
      <section class="page step">
        <div class="step-head">
          <span class="step-number">${order + 1}</span>
          <div>
            <h2>${escapeHtml(step.name)}</h2>
            <p>${introduced.length} part${introduced.length === 1 ? '' : 's'} added · ${runningTotal} of ${allParts.length} placed</p>
          </div>
        </div>
        <img class="step-render" src="${encode(image)}" alt="Assembly after step ${order + 1}" />
        ${strip}
      </section>`)
  }

  const bom = buildBom(model)
  const finished = renderScene(rasterPartsFor(allParts, new Set(), geometry), framing, { palette, outlineNew: false })

  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(model.name)} — build instructions</title>
${STYLE}
</head>
<body>
<section class="page cover">
  <header>
    <span class="eyebrow">BRICKWRIGHT BUILD INSTRUCTIONS</span>
    <h1>${escapeHtml(model.name)}</h1>
  </header>
  <img class="cover-render" src="${encode(finished)}" alt="Finished model" />
  <dl class="facts">
    <div><dt>Parts</dt><dd>${allParts.length}</dd></div>
    <div><dt>Steps</dt><dd>${ordered.length}</dd></div>
    <div><dt>Distinct elements</dt><dd>${bom.length}</dd></div>
    <div><dt>Revision</dt><dd>r${model.revision}</dd></div>
    <div><dt>Catalog</dt><dd>${escapeHtml(catalog.version)}</dd></div>
    <div><dt>Generated</dt><dd>${escapeHtml(generatedAt.slice(0, 10))}</dd></div>
  </dl>
  <p class="claim ${verification.valid ? 'good' : 'warn'}">
    ${
      verification.valid
        ? 'Verified: every part after the first step attaches to structure placed in an earlier step.'
        : 'Not fully verified: some parts attach to nothing placed earlier — see the notes below.'
    }
  </p>
  ${
    warnings.length
      ? `<ul class="notes">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
      : ''
  }
</section>

<section class="page">
  <h2 class="sheet-title">Parts list</h2>
  <table class="bom">
    <thead><tr><th></th><th>Qty</th><th>Part</th><th>Colour</th><th>LDraw</th></tr></thead>
    <tbody>
      ${bom.map((line) => bomRow(line, geometry, encode)).join('')}
    </tbody>
  </table>
</section>
${stepPages.join('\n')}
<footer class="colophon">
  Generated by Brickwright from catalog ${escapeHtml(catalog.version)}. Part geometry from the LDraw Parts
  Library (CC BY 4.0); connection metadata derived from the LDCad Shadow Library by Roland Melkert
  (CC BY-SA 4.0). LEGO® is a trademark of the LEGO Group, which does not sponsor, endorse or authorise
  LDraw or Brickwright.
</footer>
</body>
</html>
`

  return {
    html,
    steps: ordered.length,
    parts: allParts.length,
    buildOrderVerified: verification.valid,
    bom,
    warnings,
  }
}

/** Thumbnails of the parts a step introduces, grouped by element and colour. */
function partStrip(
  introduced: readonly PartInstance[],
  geometry: (definitionId: string) => BookletMesh | null,
  encode: (image: RasterImage) => string,
  supersample: number,
): string {
  const grouped = new Map<string, { part: PartInstance; count: number }>()
  for (const part of introduced) {
    const key = `${part.definitionId}:${part.color}`
    const existing = grouped.get(key)
    if (existing) existing.count += 1
    else grouped.set(key, { part, count: 1 })
  }
  const cells = [...grouped.values()].map(({ part, count }) => {
    const definition = catalog.get(part.definitionId)
    const image = renderPart(part, geometry, supersample)
    return `<li>
      ${image ? `<img src="${encode(image)}" alt="" />` : '<span class="no-render">no geometry</span>'}
      <strong>${count}×</strong>
      <small>${escapeHtml(definition?.name ?? part.definitionId)}<br />${escapeHtml(getColor(part.color).name)}</small>
    </li>`
  })
  return `<ul class="part-strip">${cells.join('')}</ul>`
}

function bomRow(
  line: BomLine,
  geometry: (definitionId: string) => BookletMesh | null,
  encode: (image: RasterImage) => string,
): string {
  const sample: PartInstance = {
    id: `bom_${line.definitionId}`,
    definitionId: line.definitionId,
    color: line.colorCode,
    transform: { position: [0, 0, 0], basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    subassemblyId: '',
    stepId: '',
    provenance: 'human',
    protected: false,
  }
  const image = renderPart(sample, geometry, 2)
  return `<tr>
    <td class="cell-thumb">${image ? `<img src="${encode(image)}" alt="" />` : ''}</td>
    <td class="cell-qty">${line.quantity}×</td>
    <td>${escapeHtml(line.name)}</td>
    <td>${escapeHtml(line.colorName)}</td>
    <td class="cell-id">${escapeHtml(line.ldrawId)}</td>
  </tr>`
}

/**
 * Renders one part in its own frame, at its own colour.
 *
 * Framed on the part rather than the model, and drawn as "new" so it appears at
 * full saturation: this is a picture of a brick to find in a pile, not a picture
 * of where it goes.
 */
function renderPart(
  part: PartInstance,
  geometry: (definitionId: string) => BookletMesh | null,
  supersample: number,
): RasterImage | null {
  const mesh = geometry(part.definitionId)
  if (!mesh) return null
  const identity: PartInstance = {
    ...part,
    transform: { position: [0, 0, 0], basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  }
  const framing = frameScene(sceneBounds([identity], geometry), 108, 84, { supersample, padding: 0.06 })
  return renderScene(rasterPartsFor([identity], new Set([identity.id]), geometry), framing, {
    palette,
    outlineNew: false,
  })
}

const STYLE = `<style>
  @page { size: A4 portrait; margin: 13mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #16211f; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { padding: 6mm 0 10mm; page-break-after: always; break-after: page; }
  .page:last-of-type { page-break-after: auto; break-after: auto; }
  h1 { font-size: 30px; margin: 4px 0 0; letter-spacing: -.01em; }
  h2 { font-size: 17px; margin: 0; }
  .eyebrow { font-size: 9px; letter-spacing: .19em; color: #6d7b78; font-weight: 700; }
  .cover-render { display: block; width: 100%; max-width: 100%; margin: 14px 0 6px; }
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 14px; margin: 14px 0; padding: 12px 0; border-top: 1px solid #dfe4e3; border-bottom: 1px solid #dfe4e3; }
  .facts div { margin: 0; }
  .facts dt { font-size: 8.5px; letter-spacing: .13em; text-transform: uppercase; color: #7d8a87; }
  .facts dd { margin: 3px 0 0; font-size: 15px; font-weight: 600; }
  .claim { font-size: 11px; padding: 8px 10px; border-left: 3px solid #4f9b57; background: #f2f8f2; margin: 0; }
  .claim.warn { border-left-color: #c98a2c; background: #fdf6ec; }
  .notes { margin: 10px 0 0; padding-left: 18px; font-size: 10.5px; color: #4b5754; }
  .notes li { margin-bottom: 4px; }
  .sheet-title { margin-bottom: 10px; }
  table.bom { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.bom th { text-align: left; font-size: 8.5px; letter-spacing: .11em; text-transform: uppercase; color: #7d8a87; border-bottom: 1px solid #dfe4e3; padding: 0 6px 5px; }
  table.bom td { border-bottom: 1px solid #eef1f0; padding: 4px 6px; vertical-align: middle; }
  table.bom tr { break-inside: avoid; }
  .cell-thumb { width: 62px; }
  .cell-thumb img { display: block; width: 58px; height: auto; }
  .cell-qty { width: 40px; font-weight: 700; }
  .cell-id { width: 62px; color: #6d7b78; font-family: ui-monospace, monospace; font-size: 10px; }
  .step { break-inside: avoid; }
  .step-head { display: flex; align-items: center; gap: 12px; }
  .step-number { flex: none; width: 34px; height: 34px; border-radius: 50%; background: #16211f; color: #fff; display: grid; place-items: center; font-size: 15px; font-weight: 700; }
  .step-head p { margin: 3px 0 0; font-size: 10.5px; color: #6d7b78; }
  .step-render { display: block; width: 100%; margin: 10px 0 8px; }
  .part-strip { list-style: none; display: flex; flex-wrap: wrap; gap: 10px; margin: 0; padding: 8px 0 0; border-top: 1px solid #dfe4e3; }
  .part-strip li { display: flex; align-items: center; gap: 6px; font-size: 10px; }
  .part-strip img { width: 46px; height: auto; }
  .part-strip strong { font-size: 12px; }
  .part-strip small { color: #55625f; line-height: 1.3; }
  .no-render { font-size: 8px; color: #a2adaa; }
  .colophon { font-size: 8.5px; line-height: 1.55; color: #7d8a87; padding-top: 8px; border-top: 1px solid #dfe4e3; }
  @media screen {
    body { background: #eef1f0; padding: 20px; }
    .page, .colophon { max-width: 860px; margin: 0 auto 20px; background: #fff; padding: 26px 30px; box-shadow: 0 2px 14px rgba(0,0,0,.09); }
  }
</style>`
