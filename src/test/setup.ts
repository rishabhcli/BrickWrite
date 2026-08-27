import '@testing-library/jest-dom/vitest'
import fixture from '../cad/__fixtures__/catalog.fixture.json'
import { catalog, type CatalogPayload } from '../cad/catalog'

// Tests run against a real slice of the compiled catalog — genuine LDraw
// bounds, LDCad connectors and Rebrickable colour evidence — so kernel
// behaviour is exercised against actual parts rather than a convenient stub.
catalog.install(fixture as unknown as CatalogPayload)
