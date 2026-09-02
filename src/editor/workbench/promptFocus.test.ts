import { afterEach, describe, expect, it } from 'vitest'
import { announceGenerationPromptReady, claimGeneratePrompt, watchGeneratePrompt } from './promptFocus'

function mountPrompt() {
  const wrap = document.createElement('div')
  wrap.className = 'bw-gen'
  const field = document.createElement('textarea')
  field.setAttribute('data-generation-prompt', '')
  wrap.appendChild(field)
  document.body.appendChild(wrap)
  return field
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.focus()
})

describe('generate prompt focus', () => {
  it('claims a prompt that is already in the document', () => {
    const field = mountPrompt()
    expect(claimGeneratePrompt()).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  it('focuses when the field announces itself instead of polling frames', () => {
    const stop = watchGeneratePrompt()
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true)

    const field = mountPrompt()
    announceGenerationPromptReady()

    expect(document.activeElement).toBe(field)
    stop()
  })

  it('focuses when the field appears in the tree without an announcement', async () => {
    const stop = watchGeneratePrompt()
    const field = mountPrompt()
    // jsdom delivers MutationObserver records as a microtask, not a 4s rAF poll.
    await Promise.resolve()
    await Promise.resolve()
    expect(document.activeElement).toBe(field)
    stop()
  })

  it('does not pull focus out of a control the operator already reached', () => {
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    mountPrompt()
    expect(claimGeneratePrompt()).toBe(true)
    expect(document.activeElement).toBe(other)
  })
})
