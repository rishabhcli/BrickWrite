/**
 * Caret handoff into catalogue search.
 *
 * `panel.search` (Mod+K) promises the operator can type a part number. The
 * field lives inside the left dock, which is unmounted while that dock is a
 * rail and while another left tab is selected. A single animation frame after
 * asking the dock to reopen is not a wait: React often commits the field after
 * that frame has already queried the document and given up.
 *
 * Claim the field if it is already there; otherwise watch the tree until it
 * appears. No timer, no frame budget.
 */

export function catalogSearchField(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('[data-catalog-search]')
}

/** Put the caret in catalogue search. Unlike Generate, this is an explicit reach, so it takes focus. */
export function claimCatalogSearch(): boolean {
  const field = catalogSearchField()
  if (!field) return false
  field.focus()
  return true
}

/**
 * Claim now if the field is already there; otherwise wait for the node.
 * The returned function cancels the wait.
 */
export function watchCatalogSearch(): () => void {
  if (claimCatalogSearch()) return () => {}

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    observer.disconnect()
  }

  const host = document.querySelector('.app-shell') ?? document.body
  const observer = new MutationObserver(() => {
    if (claimCatalogSearch()) stop()
  })
  observer.observe(host, { childList: true, subtree: true })
  return stop
}
