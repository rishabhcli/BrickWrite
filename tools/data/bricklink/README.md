# BrickLink crosswalk snapshot

These reviewable tables are a **column projection of BrickLink's own Studio 2.0
catalog data**, not a number-pattern guess and not a scrape of search results.
They close the purchasing-export identifier prerequisite while keeping gaps and
one-to-many mappings explicit.

- Source: BrickLink Studio 2.0 `2.26.7_1`
- First-party package: <https://studio.download.bricklink.info/Studio2.0/Archive/2.26.7_1/Studio+2.0.pkg>
- Verified package SHA-256: `526d727e85ab9104429a41c63bc1d3ace63f76353843d98a2fab9d6f7c5ff95d`
- `parts.tsv`: `LDraw ItemNo` -> all non-empty `BL ItemNo` values from
  `data/StudioPartDefinition2.txt`
- `colors.tsv`: `LDraw Color Code` -> non-empty `BL Color Code` from
  `data/StudioColorDefinition.txt`

Rows are sorted and contain only the identifiers needed by the compiler. The
source package version, hash, selected columns, and extraction counts are also
machine-readable in `source.json`. Rebuilding against a newer Studio release is
a deliberate review step: do not infer missing mappings from similar-looking
numbers.
