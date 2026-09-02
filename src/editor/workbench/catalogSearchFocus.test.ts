import { afterEach, describe, expect, it } from 'vitest'
import { claimCatalogSearch, watchCatalogSearch } from './catalogSearchFocus'

function mountSearch() {
  const field = document.createElement('input')
  field.setAttribute('data-catalog-search', '')
  document.body.appendChild(field)
  return field
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.focus()
})

describe('catalog search focus', () => {
  it('claims a search field that is already in the document', () => {
    const field = mountSearch()
    expect(claimCatalogSearch()).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  it('focuses when the field appears in the tree instead of a single frame', async () => {
    const stop = watchCatalogSearch()
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true)

    const field = mountSearch()
    // jsdom queues MutationObserver delivery; a macrotask is enough to see it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(field)
    stop()
  })

  it('takes focus even when another control already has it', () => {
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    mountSearch()
    expect(claimCatalogSearch()).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('[data-catalog-search]'))
  })
})
