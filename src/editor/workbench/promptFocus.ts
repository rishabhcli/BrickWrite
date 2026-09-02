/**
 * Caret handoff into the Generate prompt.
 *
 * `?intent=describe` (and the `brickwright:intent-describe` event) promise that
 * the operator can start typing. Generate is a lazily imported contribution, so
 * the field often does not exist when the shell first hears the intent. Waiting
 * on animation frames with a four-second deadline made that race both slow and
 * flaky: a late mount after the deadline missed the caret, and a test had to
 * pump frames hoping the field had appeared.
 *
 * The field announces itself. The shell claims it then, or when the node lands
 * in the tree. No timer, no frame budget.
 */

export const GENERATION_PROMPT_READY = 'brickwright:generation-prompt-ready'

export function generationPromptField(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('textarea[data-generation-prompt], .bw-gen textarea')
}

/** The Generate surface fires this once the prompt is in the document. */
export function announceGenerationPromptReady(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(GENERATION_PROMPT_READY))
}

/**
 * Put the caret in the prompt if nobody else has it.
 *
 * Returns whether the field exists. Presence stops the wait even when focus is
 * left alone — the operator may have moved since the intent was recorded, and
 * this must not yank them back.
 */
export function claimGeneratePrompt(): boolean {
  const field = generationPromptField()
  if (!field) return false
  const active = document.activeElement
  if (active === field) return true
  // `?intent=describe` lands after the canvas is already tabbable. Treating
  // that default focus as an operator choice left the caret in an empty
  // viewport instead of the prompt the route promised.
  const operatorHeld =
    active instanceof HTMLElement &&
    (active.matches('input, textarea, select, [contenteditable="true"]') ||
      Boolean(active.closest('[role="dialog"][aria-modal="true"]')))
  if (!operatorHeld) field.focus()
  return true
}

/**
 * Claim now if the field is already there; otherwise wait for the ready event
 * or the node appearing. The returned function cancels the wait.
 */
export function watchGeneratePrompt(): () => void {
  if (claimGeneratePrompt()) return () => {}

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    observer.disconnect()
    window.removeEventListener(GENERATION_PROMPT_READY, onReady)
  }

  const onReady = () => {
    if (claimGeneratePrompt()) stop()
  }

  const host = document.querySelector('.app-shell') ?? document.body
  const observer = new MutationObserver(() => {
    if (claimGeneratePrompt()) stop()
  })
  observer.observe(host, { childList: true, subtree: true })
  window.addEventListener(GENERATION_PROMPT_READY, onReady)
  return stop
}
