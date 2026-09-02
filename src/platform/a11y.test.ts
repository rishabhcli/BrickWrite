import { describe, expect, it } from 'vitest'
import { focusableWithin } from './a11y'

describe('focusableWithin', () => {
  it('skips HTML-hidden file pickers so a popover trap cannot land on them', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <button type="button">Visible</button>
      <input type="file" hidden />
      <input type="file" aria-hidden="true" />
      <button type="button">Also visible</button>
    `
    expect(focusableWithin(root).map((node) => node.textContent)).toEqual(['Visible', 'Also visible'])
  })
})
