import fixture from '../../cad/__fixtures__/catalog.fixture.json'
import { catalog, type CatalogPayload } from '../../cad/catalog'

/**
 * Extra BUILDABLE rows so the palette pager has a second page.
 *
 * The fixture pack sits one short of PAGE_SIZE. Cloning a real pack identity
 * (search row *and* definition) keeps those fillers placeable: they carry the
 * donor's mesh, thumbnail and connectors instead of a `g: 1` flag with nothing
 * behind it. Production PAGE_SIZE is left alone.
 */
const EXTRA = 12

export function overflowBuildableSearch() {
  const payload = fixture as unknown as CatalogPayload
  const donorPart = payload.parts.find((part) => !part.helper)
  const donorSearch = donorPart
    ? (payload.search ?? []).find((entry) => entry.id === donorPart.canonicalId && entry.g === 1)
    : undefined
  if (!donorPart || !donorSearch) {
    throw new Error('Fixture pack has no placeable identity to clone')
  }
  catalog.install({
    ...payload,
    parts: [
      ...payload.parts,
      ...Array.from({ length: EXTRA }, (_, index) => ({
        ...donorPart,
        canonicalId: `placeExtra${index}`,
        ldrawId: `placeExtra${index}`,
        name: `${donorPart.name} (overflow ${index})`,
      })),
    ],
    search: [
      ...(payload.search ?? []),
      ...Array.from({ length: EXTRA }, (_, index) => ({
        ...donorSearch,
        id: `placeExtra${index}`,
        n: `${donorSearch.n} overflow ${index}`,
      })),
    ],
  } as CatalogPayload)
}

export function restoreCatalogFixture() {
  catalog.install(fixture as unknown as CatalogPayload)
}
