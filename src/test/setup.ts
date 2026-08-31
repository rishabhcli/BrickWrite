import '@testing-library/jest-dom/vitest'
import fixture from '../cad/__fixtures__/catalog.fixture.json'
import { catalog, type CatalogPayload } from '../cad/catalog'

// Node 24 exposes `localStorage` on globalThis only with `--localstorage-file`.
// jsdom's `window.localStorage` is fine; Hexclave's session recorder reads the
// global one and crashes the tree if it is undefined.
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null
    },
    key(index) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key) {
      store.delete(key)
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
  }
}

if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage == null) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() })
}
if (typeof globalThis.sessionStorage === 'undefined' || globalThis.sessionStorage == null) {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() })
}

// jsdom implements no layout and therefore no ResizeObserver. The liquid
// material uses one to cache each lensed surface's box, so that reading it on
// every pointer frame does not force a synchronous layout. A stub that never
// fires is the honest shape here: jsdom has no resize to report, and the
// geometry it would carry is exactly what a layout-free DOM cannot answer.
if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })
}

// Tests run against a real slice of the compiled catalog — genuine LDraw
// bounds, LDCad connectors and Rebrickable colour evidence — so kernel
// behaviour is exercised against actual parts rather than a convenient stub.
catalog.install(fixture as unknown as CatalogPayload)
