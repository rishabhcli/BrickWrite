# Spec 01 — BrickLink wanted-list export, and a portable project archive

**Status:** proposed
**Touches:** `src/cad/bom.ts`, a new `src/cad/bricklink.ts`, a new `src/cad/archive.ts`, `src/editor/ExportCenter.tsx`, `tools/catalog-compiler.mjs`, plus a new checked-in colour table
**Prerequisites:** two identifier gaps, both blocking, both described in §2

---

## 1. Why

`PROGRESS.md`'s own ordered-next-work item 2 names both halves of this:

> BrickLink XML and project archives, so a verified design can move between
> browsers and into a purchasing workflow without manual CSV conversion.

Two distinct problems.

**A BOM that cannot be ordered from.** `src/cad/bom.ts` emits CSV with columns
`Quantity, LDraw ID, BrickLink ID, Part name, LDraw color, Color name`. BrickLink's
wanted-list XML is the standard path from a validated model to a real multi-store
order with quantities and colours pre-filled. Today every export needs manual
CSV-to-XML conversion by hand.

**A verified document that loses its verification when it leaves.** `exportLDraw`
and `exportMpd` serialise only `parts` and `steps`. `ModelDocument` also holds
`connections`, `notes`, `constraints` and `modules` (`src/cad/types.ts:305-325`) —
none are written, and `parseLDraw` explicitly zeroes connections on import
(`src/cad/ldraw.ts:162`, `next.connections = {}`). So every hand-tuned
`ConnectionEdge` with `source: 'explicit-connect'`, every `BuilderNote`, every hard
`Constraint`, every captured `ModuleDefinition` is unrecoverable the moment a
document is exported.

---

## 2. Two blocking prerequisites

**Neither of these is a caveat to note in the export. Both must be closed first,
or the feature emits confidently wrong data into a purchasing workflow.**

### 2a. No part carries a BrickLink id

`tools/catalog-compiler.mjs:726` is `bricklinkIds: []`, unconditional. There is no
branch, no data source and no CLI flag anywhere in the ~1,100-line compiler that
ever writes a non-empty value.

Measured against the shipped catalog:

```
total records in parts.json:        900
with non-empty bricklinkIds:          0
identityConfidence tally:  { exact: 900 }
```

`crosswalkIdentity` (`tools/catalog-compiler.mjs:561-571`) resolves LDraw →
**Rebrickable** only, from five bulk CSVs. None of Rebrickable's bulk exports carry
a BrickLink column; that mapping exists only behind their per-part REST endpoint
(`external_ids.BrickLink`), which the compiler never calls.

The consequence today is quiet and bad: `bom.ts:25`'s fallback chain is
`bricklinkIds[0] ?? rebrickableId ?? canonicalId`. Since the first is *never*
defined, **the CSV column labelled "BrickLink ID" always actually contains the
Rebrickable part number.**

> A second subsystem independently hit this and documented it:
> `docs/integration/part-intelligence.md:282-287` records that BrickLink number
> resolution "never fires in production", and `src/intelligence/parts/resolve.test.ts:50-64`
> has to hand-patch two records to get any coverage at all.

**Remediation, pick one:**

| Option | Mechanism | Cost |
|---|---|---|
| A | Add per-part Rebrickable REST calls to the compiler for `external_ids.BrickLink` | Turns an offline bulk-CSV compile into a network-dependent, rate-limited one |
| B | Check in a curated BrickLink↔LDraw crosswalk table | Manual sourcing; needs a refresh policy |

Option B is recommended for the 900-part placeable pack — it is a bounded,
reviewable artifact, and the placeable set changes rarely. Option A becomes
attractive only if the pack widens substantially.

### 2b. No BrickLink colour mapping exists

`ColorDefinition` (`src/cad/types.ts:226-234`) carries `code`, `name`, `hex`,
`edge`, `alpha`, `finish` — no BrickLink field, and no Rebrickable field either.
The compiler's `crosswalkColours` (`tools/catalog-compiler.mjs:143-163`) maps
Rebrickable colour ids → LDraw codes transiently, and **discards the mapping after
compilation.**

BrickLink numbers colours independently: BrickLink colour `11` is Black, LDraw
colour `0` is Black. The codes do not correspond. Emitting `BomLine.colorCode`
into `<COLOR>` would write a wrong, unrelated integer into a purchase order —
strictly worse than omitting the element.

**Remediation:** a checked-in LDraw-code → BrickLink-colour-id table, curated from
BrickLink's public colour guide, carrying the same report-what-is-unmapped
discipline the compiler already applies at `tools/catalog-compiler.mjs:935`
(`unmatchedRebrickableColors`). Where a mapping is absent, omit `<COLOR>` and say
so — BrickLink then treats the line as "any colour", which is a materially
different purchase and must be disclosed rather than defaulted past.

---

## 3. The wanted-list XML format

Verified against `bricklink.com/help.asp?helpID=207`.

Root `<INVENTORY>`, one `<ITEM>` per wanted line.

| Field | Required | Values | Notes |
|---|---|---|---|
| `ITEMTYPE` | **yes** | `S P M B G C I O` | Always `P` for us |
| `ITEMID` | **yes** | string | Must be a genuine BrickLink catalog number — see §2a |
| `COLOR` | no | BrickLink colour id | Omit when unmapped — see §2b |
| `MINQTY` | no | integer > 0 | **This is the wanted quantity.** There is no separate quantity tag |
| `QTYFILLED` | no | integer | Quantity already owned; irrelevant to a fresh export |
| `MAXPRICE` | no | decimal > 0 | Price ceiling per unit |
| `CONDITION` | no | `N` / `U` | Defaults to account preference |
| `REMARKS` | no | free text | Private annotation |
| `NOTIFY` | no | `Y` / `N` | |
| `WANTEDLISTID` | no | id | Omitted → account's main list |

### Mapping

One `<ITEM>` per `BomLine` — reuse `buildBom(document)` directly rather than
re-aggregating, so the CSV and XML can never drift.

```
ITEMTYPE  ← "P"                       (constant)
ITEMID    ← resolved BrickLink id     (§2a)
COLOR     ← mapped BrickLink colour   (§2b; omit when unmapped)
MINQTY    ← BomLine.quantity
CONDITION ← "N"                       (sane default for a from-scratch build)
REMARKS   ← `${document.name} r${document.revision}`
```

**XML escaping is new work.** Nothing in this codebase escapes XML today —
`ldraw.ts` writes a line-oriented text format and `bom.ts:35`'s `csv()` doubles
quotes. `REMARKS` carries a user-supplied document name, so `&`, `<`, `>`, `"` and
`'` must be escaped. There is no helper to reuse.

---

## 4. Design — export surface

New module `src/cad/bricklink.ts`, sibling to `bom.ts`:

```ts
/** Which tier of the identifier fallback actually supplied an id. */
export type BrickLinkIdSource = 'bricklink' | 'rebrickable-fallback' | 'ldraw-fallback'

export interface BrickLinkLine {
  readonly bomLine: BomLine
  readonly itemId: string
  readonly idSource: BrickLinkIdSource
  /** Absent when no LDraw→BrickLink colour mapping exists for this code. */
  readonly colorId: number | null
}

export interface BrickLinkExportReport {
  readonly lines: number
  readonly unverifiedIds: number
  readonly unmappedColors: number
  readonly totalPieces: number
}

export function buildBrickLinkLines(document: ModelDocument): BrickLinkLine[]
export function exportBrickLinkXml(document: ModelDocument): {
  xml: string
  report: BrickLinkExportReport
}
```

Returning a report alongside the string — rather than a bare string like the other
exporters — is the deliberate difference. It is what lets the UI say *"142 lines,
142 with unverified item numbers, 8 with no colour mapping"* instead of handing
over a file that looks authoritative and is not. This matches the codebase's
existing `ImportReport` shape (`src/cad/ldraw.ts:118-124`).

### UI

`src/editor/ExportCenter.tsx`, inside the existing `.export-grid` at `:179`,
following the exact three-line pattern of the LDR/MPD/CSV buttons:

```tsx
<button onClick={handleBrickLink}>
  <FileSpreadsheet size={17} />
  <span><strong>BrickLink wanted list</strong><small>.xml · for ordering</small></span>
</button>
```

**Do not disable the button on unverified ids.** Every other partial-knowledge case
in this codebase degrades to a reported caveat rather than a refusal — virtual
colours, heuristic identity, missing connections. Surface the report through the
existing `onNotice` prop (already threaded into `ExportCenterProps`, used today only
by `generateGuide`'s catch at `:124-137`).

Notice copy, when ids are unverified:

> Exported 142 lines. **None carry a verified BrickLink item number** — they use
> LDraw/Rebrickable numbers, which usually but not always match. Check the list on
> BrickLink before ordering.

---

## 5. Design — project archive

New module `src/cad/archive.ts`.

```jsonc
{
  "brickwrightArchive": 1,          // envelope version, independent of schemaVersion
  "exportedAt": "2026-08-28T00:00:00.000Z",
  "catalogVersion": "2026-07",      // restated for a fast pre-check
  "checkpoint": { /* StoredCheckpoint verbatim — persistence.ts:22-27 */ },
  "transactions": [ /* StoredTransaction[] above checkpoint.revision, ascending */ ],
  "lastValidation": {               // attestation only, never trusted on import
    "asOfRevision": 8,
    "healthy": true,
    "collisionCount": 0,
    "unverifiedCollisions": 0,
    "componentCount": 1
  }
}
```

Three decisions, each grounded in an existing convention rather than invented:

**The checkpoint document is the source of truth.** Exactly what
`ProjectRepository.loadProject` already treats as truth
(`src/cad/persistence.ts:221`). Import never depends on the log replaying.

**The transaction log is an audit annex, not a replay requirement.** `loadProject`
already stops at the first revision gap rather than applying a log out of order
(`persistence.ts:228`). An imported log that does not chain cleanly still imports
for history and authorship display; it degrades to "history partially available"
and never fails the import.

**`lastValidation` is stamped and re-verified, never trusted.** This codebase
consistently refuses to assume derived facts survive a round trip — `session.ts`
re-checks every part is placeable on load rather than trusting a stored flag. The
importer recomputes `ValidationReport` immediately and displays `lastValidation`
only as *"what the exporting browser last saw."*

### Import path

1. **Envelope validation** before touching engine state — check `brickwrightArchive`, `checkpoint.document.schemaVersion === 2`, required fields. Mirrors `src/cad/storage.ts:16-32`.
2. **Placeability check** via `session.ts:146-149`'s `usable()` predicate; report unplaceable ids explicitly rather than the current binary refuse-or-accept.
3. **Fresh project id** via `session.ts:246-252`'s `uniqueProjectId(name)`, so an import can never silently clobber a same-named local project.
4. **Persist through existing primitives** — `saveCheckpoint` (`persistence.ts:187-202`) then `appendTransaction` (`:204-208`) per entry, best-effort.
5. **Adopt into the engine** the way `session.ts:178-188`'s `adopt()` already does: `replaceDocument`, `autosave.reset()`, set `restore`.
6. **Structured report**, not a boolean:
   ```ts
   interface ArchiveImportReport {
     importedRevision: number
     transactionsAvailable: number
     transactionsImported: number
     catalogVersionMatch: boolean
     unplaceableParts: string[]
   }
   ```
7. **A file input** mirroring `ExportCenter.tsx:207-223` with `accept=".json"` and a handler distinct from `onImport`/`parseLDraw`.

> **Plumbing note.** `ExportCenter` receives only `state: EngineSnapshot` and has no
> access to the transaction log. Exporting an archive needs either a new prop or a
> `session.exportArchive()` method threaded down alongside the existing `onImport`.

---

## 6. Edge cases

| Case | Expected behaviour |
|---|---|
| Part has no BrickLink id (**all of them today**) | Fall back through Rebrickable → canonical; mark `idSource`; count in report; still export |
| Colour has no BrickLink mapping | Omit `<COLOR>`; count in report; disclose that BrickLink will treat it as any-colour |
| Document name contains `&`, `<`, `"` | Escaped in `REMARKS` |
| Empty document | Emit a valid empty `<INVENTORY></INVENTORY>`; report 0 lines |
| Archive with a broken transaction chain | Import the checkpoint; report `transactionsImported < transactionsAvailable`; do not fail |
| Archive from a different `catalogVersion` | Import; report the mismatch and list unplaceable parts; do not silently discard as `storage.ts` does |
| Archive whose `lastValidation.healthy` is true but recompute disagrees | Trust the recompute; show the stored value as historical only |
| Importing an archive of a project already open locally | New id via `uniqueProjectId`; never overwrite |

---

## 7. Tests

Following the house pattern in `src/cad/bom.test.ts` and `src/cad/ldraw.test.ts` —
invariants over magic numbers, a real fixture (`createShowcaseDocument()`), and
literal output assertions.

**`src/cad/bricklink.test.ts`**
- `emits one ITEM per BOM line` — `<ITEM>` count equals `buildBom(document).length`
- `MINQTY sums to the document part count` — the invariant `bom.test.ts` already uses
- `emits a well-formed document` — parse the output, assert root is `INVENTORY`
- `matches the literal item block for a known part` — full `<ITEM>` string, catching format regressions the way `ldraw.test.ts:30` does
- `reports unverified item numbers rather than claiming them` — assert `report.unverifiedIds === lines` against today's catalog
- `omits COLOR when unmapped and counts it` — hand-built document with an unmapped colour
- `escapes XML metacharacters in REMARKS` — document named `Rock & <Roll>`

**`src/cad/archive.test.ts`**
- `round-trips connections, notes, constraints and modules` — the four things `.ldr` loses; `toEqual` on each
- `imports the checkpoint when the transaction log is broken` — deliberately gapped log, assert document intact and report partial
- `assigns a fresh project id on import` — assert no clobber
- `reports a catalog version mismatch instead of discarding`
- `recomputes validation rather than trusting the attestation` — archive claiming `healthy: true` for a colliding document

---

## 8. Work breakdown

Ordered, because §2 genuinely blocks the rest.

1. **Curate the BrickLink colour table** (§2b) and add it to the catalog payload with an unmapped count in the manifest.
2. **Source BrickLink item ids** (§2a, option B) for the 900-part placeable pack; populate `bricklinkIds`; keep `identityConfidence` semantics.
3. **`src/cad/bricklink.ts`** — `buildBrickLinkLines`, `exportBrickLinkXml`, XML escaping helper, report shape.
4. **`ExportCenter` button** plus notice wiring.
5. **`src/cad/archive.ts`** — export half, with the session plumbing for the transaction log.
6. **Archive import** — validation, placeability, persist, adopt, report.
7. **Import UI** — file input and report surfacing.
8. Tests alongside each step.

**Steps 3–4 can ship before 1–2** and are still useful: the export works, and the
report tells the truth about what the ids are. That is strictly better than the
status quo, where the CSV already emits Rebrickable numbers under a column headed
"BrickLink ID" and says nothing.

---

## 9. Open questions

1. Is manual curation of ~900 BrickLink ids acceptable, or should the compiler take a network dependency?
2. Should the archive be plain JSON or gzipped? A 5,000-part document's log is large; `downloadText` takes a string, so gzip needs a different download path.
3. Should archive export include the *full* log or truncate to the last N transactions?
4. Does `CONDITION: N` belong in the export at all, or should it be a user choice at export time?
