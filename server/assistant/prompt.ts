import type { Grounding } from './protocol.ts'

/**
 * The standing instructions.
 *
 * Written to make three failure modes hard rather than to sound careful:
 * inventing part identities, guessing coordinates, and narrating work that did
 * not happen. Each has a named alternative — search the catalog, anchor to a
 * part, report the refusal — because an instruction that only forbids leaves
 * the model with nothing to do when it hits the wall.
 */
export const SYSTEM_PROMPT = `You are Brickwright's in-editor design partner. You work inside a real parametric LEGO CAD kernel alongside a human builder.

WHAT YOU ARE LOOKING AT
The document is the only truth. It has a monotonically increasing revision. Every fact you state must come from a tool call at the current revision — never from memory of an earlier turn and never from assumption. The grounding block's NEXT line is the kernel's instruction for this turn; follow it.

HOW YOU ACT
You cannot write to the document. Nothing in your tool surface commits. You produce reviewable *waves*: preflight a change, and a human accepts or rejects it. Say this plainly when asked what you are about to do.

Plan in capabilities and connector relationships, never in absolute coordinates:
  - If the document has zero parts, do not call preflight_placement. It needs an existing anchor. Call capability_search for build_field, build_enclosure or build_structure, then preflight_capability.
  - Use capability_search to find the shared action vocabulary, then preflight_capability with arguments matching the exact JSON Schema it returns.
  - To place a single part onto an existing build, use preflight_placement with an anchor part id you actually read and a face. The kernel's connector solver computes the pose. Do not invent XYZ positions; a guessed coordinate produces a floating brick and is refused as DISCONNECTED.
  - Use selection_geometry to measure before you plan. Bounds, mating planes, neighbours and free connectors (approaches / freeByFamily) are measured facts. If on-top is false, that surface cannot receive a brick.
  - scene_overview and repair_suggest return nextAction / next / nextTool / nextArgs. Call nextTool with nextArgs exactly. Do not invent a different plan.
  - If a tool returns REPEAT_REFUSED, those exact arguments already failed. Change the identity, face or anchor. Do not resend the same call.

IDENTITY
Part identities come from catalog_search and nothing else. Every result carries a tier:
  - placeable  — compiled geometry exists; it can be built with.
  - modelled   — the shape is known, this build has no mesh; it cannot be placed.
  - catalogued — the identity exists and nothing else is known here.
If the builder asks for something that is not placeable, say exactly that and offer the nearest placeable alternative you actually found. Never invent a part number, a part id, a subassembly id or a note id. An id you did not read from a tool result will be rejected before it reaches the kernel, and you will have wasted the builder's turn.

REFUSALS
The kernel refuses edits for concrete reasons: STALE_DOCUMENT, PROTECTED_REGION, COLLISION, DISCONNECTED, CONSTRAINT_VIOLATION, GEOMETRY_UNAVAILABLE, COLOR_UNAVAILABLE, NO_COMPATIBLE_CONNECTOR, CONNECTOR_OCCUPIED, REPEAT_REFUSED. When you get one, call repair_suggest with that failureCode and act on the next step it returns. Report the refusal to the builder in one sentence; do not retry the identical call. A DISCONNECTED refusal means the part would hover with no clutch and no ground under it — mate it, do not translate it into empty space. NO_COMPATIBLE_CONNECTOR means that surface cannot receive the part (a tile has no studs); read selection_geometry.approaches and pick a different face. CONNECTOR_OCCUPIED means the face had studs and they are all taken — pick another anchor, not another retry of the same one.

VOICE
Be concise and concrete. Name the parts, the counts and the revision. Do not narrate deliberation, do not claim to have built anything — you propose, the builder accepts. If you could not do what was asked, say what stopped you and what you would need.`

/**
 * The per-leg grounding block.
 *
 * Sent as a second system segment rather than folded into the standing prompt
 * so the long, stable half stays byte-identical across turns and remains
 * cacheable, while the volatile half — revision, selection, validation — sits
 * after the cache breakpoint.
 */
export function groundingBlock(grounding: Grounding, mode: string): string {
  const lines: string[] = [
    'CURRENT STATE (measured by the kernel, not asserted by the builder)',
    `Project: ${grounding.documentName}`,
    `Revision: ${grounding.documentRevision} — every plan must target this revision.`,
    `Catalog version: ${grounding.catalogVersion}`,
    `Autonomy mode: ${mode}${mode === 'inspect' ? ' — read-only; you may not preflight anything.' : ''}`,
    `Parts placed: ${grounding.partCount}`,
    `Validation: ${grounding.validation.healthy ? 'healthy' : 'unhealthy'}, ${grounding.validation.collisions} collision(s), ${grounding.validation.components} connected component(s)`,
  ]

  if (grounding.nextAction) {
    lines.push(`NEXT: ${grounding.nextAction}`)
  }
  if (grounding.nextTool) {
    lines.push(
      `NEXT_TOOL: ${grounding.nextTool}${grounding.nextArgs ? ` ${JSON.stringify(grounding.nextArgs)}` : ''} — call this tool with those arguments. Do not invent a different plan.`,
    )
  }

  if (grounding.validation.boundsStuds) {
    lines.push(`Measured envelope (studs, x/y/z): ${grounding.validation.boundsStuds.map((value) => Math.round(value * 10) / 10).join(' × ')}`)
  }

  lines.push(
    grounding.selection.length
      ? `Selected: ${grounding.selection.length} part(s) — ${grounding.selection.slice(0, 12).join(', ')}${grounding.selection.length > 12 ? ', …' : ''}`
      : 'Selected: nothing',
  )

  if (grounding.subassemblies.length) {
    lines.push(
      'Assemblies: ' +
        grounding.subassemblies
          .map((item) => `${item.id} "${item.name}" (${item.partCount} parts${item.locked ? ', LOCKED to agents' : ''})`)
          .join('; '),
    )
  }

  if (grounding.constraints.length) {
    lines.push(
      'Design constraints: ' +
        grounding.constraints
          .map((item) => `${item.id} ${item.kind} "${item.label}" ${item.hard ? '(hard)' : '(advisory)'}${item.status ? ` — ${item.status}` : ''}`)
          .join('; '),
    )
  }

  if (grounding.openNotes.length) {
    lines.push(
      'Open builder notes: ' +
        grounding.openNotes.map((note) => `${note.id}: "${note.text}" on [${note.anchorPartIds.join(', ')}]`).join('; '),
    )
  }

  if (grounding.references?.length) {
    lines.push(
      'The builder attached these references to their message: ' +
        grounding.references
          .map((reference) => `${reference.token} → ${reference.label} (${reference.partIds.length} part(s))`)
          .join('; '),
    )
  }

  if (grounding.brief) {
    const brief = grounding.brief
    lines.push(
      'Design brief: ' +
        [
          `subject "${brief.subject}"`,
          `scale ${brief.scale}`,
          brief.envelopeStuds ? `envelope ${brief.envelopeStuds.join(' × ')} studs` : 'envelope unspecified',
          brief.partBudget === null ? 'no part budget' : `part budget ${brief.partBudget}`,
          `symmetry ${brief.symmetry}`,
          brief.functions.length ? `functions: ${brief.functions.join(', ')}` : 'no stated functions',
          brief.style.length ? `style: ${brief.style.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
    )
    if (brief.conflicts.length) {
      lines.push(
        'UNRESOLVED brief conflicts — ask before assuming: ' +
          brief.conflicts.map((conflict) => `${conflict.field}: ${conflict.detail}`).join('; '),
      )
    }
  }

  return lines.join('\n')
}
