import { useCallback, useEffect, useState } from 'react'

/**
 * Sharing affordances.
 *
 * Three paths, in the order a browser is likely to support them:
 *
 *   1. **Web Share**, when the platform offers it — on a phone this is the
 *      native sheet, and nothing a web page builds will ever be as good.
 *   2. **Clipboard**, the desktop default.
 *   3. **A readable, selectable input**, which always works. It is not a
 *      fallback that appears after a failure; it is on the page from the start,
 *      because a copy button that silently does nothing is worse than no button.
 *
 * Every state change is announced, so somebody using a screen reader is told the
 * link was copied rather than watching a button caption they cannot see change.
 */

export interface ShareBarProps {
  url: string
  title: string
  /** When present, the embed snippet is offered alongside the link. */
  embedUrl?: string
}

type Status = { kind: 'idle' } | { kind: 'copied'; what: string } | { kind: 'failed'; what: string }

export function ShareBar({ url, title, embedUrl }: ShareBarProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [canShare, setCanShare] = useState(false)

  useEffect(() => {
    // Feature-detected on mount rather than at module scope: `navigator.share`
    // is absent during server rendering and in jsdom.
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function')
  }, [])

  useEffect(() => {
    if (status.kind === 'idle') return
    const timer = setTimeout(() => setStatus({ kind: 'idle' }), 2600)
    return () => clearTimeout(timer)
  }, [status])

  const copy = useCallback(async (value: string, what: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(value)
      setStatus({ kind: 'copied', what })
    } catch {
      // Clipboard access is refused in plenty of legitimate contexts. Say so and
      // leave the text selectable rather than claiming a copy that did not
      // happen.
      setStatus({ kind: 'failed', what })
    }
  }, [])

  const share = useCallback(async () => {
    try {
      await navigator.share({ title, url })
    } catch (cause) {
      // A cancelled share sheet rejects; that is not an error worth reporting.
      if ((cause as Error)?.name !== 'AbortError') await copy(url, 'link')
    }
  }, [copy, title, url])

  const embedSnippet = embedUrl
    ? `<iframe src="${embedUrl}" width="640" height="480" style="border:0" loading="lazy" title="${title.replace(/"/g, '')}"></iframe>`
    : null

  return (
    <section className="bw-share-bar" aria-label="Share this model">
      <label className="bw-share-field">
        <span>Link</span>
        <input type="text" readOnly value={url} onFocus={(event) => event.currentTarget.select()} data-testid="share-url" />
      </label>
      <div className="bw-share-bar-actions">
        {canShare ? (
          <button type="button" onClick={share} data-testid="share-native">
            Share…
          </button>
        ) : null}
        <button type="button" onClick={() => copy(url, 'link')} data-testid="share-copy">
          Copy link
        </button>
        {embedSnippet ? (
          <button type="button" onClick={() => copy(embedSnippet, 'embed code')} data-testid="share-copy-embed">
            Copy embed code
          </button>
        ) : null}
      </div>
      <p className="bw-share-status" role="status" aria-live="polite">
        {status.kind === 'copied'
          ? `Copied the ${status.what}.`
          : status.kind === 'failed'
            ? `This browser would not let the page write to the clipboard. Select the ${status.what} above and copy it.`
            : ''}
      </p>
    </section>
  )
}
