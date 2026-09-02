import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import type { Candidate } from './phases'
import { CANDIDATE_METRICS } from './session'
import './panel.css'

/**
 * Candidates, side by side, on every axis the engine measured.
 *
 * The dock is 300 px wide and a real comparison is twenty rows by three columns,
 * so the compact card carries the headline axes and this dialog carries all of
 * them. It is the same `CANDIDATE_METRICS` list either way: two renderings of one
 * vector, not two opinions about it.
 *
 * Focus is trapped and restored here rather than assumed from the shell, because
 * the modal slot renders whatever the active contribution returns.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const GROUPS: Array<{ id: string; label: string }> = [
  { id: 'size', label: 'Size' },
  { id: 'sourcing', label: 'Sourcing' },
  { id: 'physics', label: 'Physics' },
  { id: 'build', label: 'Build order' },
  { id: 'brief', label: 'Against the brief' },
]

export function CompareDialog({
  candidates,
  selectedId,
  onSelect,
  onClose,
}: {
  candidates: readonly Candidate[]
  selectedId: string | null
  onSelect: (candidateId: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  if (returnFocusRef.current === null && typeof document !== 'undefined') {
    returnFocusRef.current = document.activeElement as HTMLElement | null
  }

  useEffect(() => {
    closeRef.current?.focus()
    const restore = returnFocusRef.current
    return () => {
      if (restore && typeof restore.focus === 'function' && restore.isConnected) restore.focus()
    }
  }, [])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  return (
    <div
      className="bw-gen-dialog"
      role="presentation"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="bw-gen-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bw-gen-compare-title"
        ref={panelRef}
      >
        <div className="bw-gen-dialog__head">
          <h2 id="bw-gen-compare-title">Candidates side by side</h2>
          <button ref={closeRef} className="bw-gen__btn" onClick={onClose} aria-label="Close the candidate comparison">
            <X size={12} aria-hidden="true" /> Close
          </button>
        </div>
        <div className="bw-gen-dialog__body">
          {candidates.length === 0 ? (
            <p className="bw-gen__hint" style={{ padding: '12px' }}>
              No candidate passed the hard gates, so there is nothing to compare. The panel lists why each one was
              refused.
            </p>
          ) : (
            <table className="bw-gen-dialog__table">
              <caption>
                Every axis <code>scoreDocument</code> measures, for all {candidates.length} candidates. Nothing here is
                a verdict: which direction is better is a question about the brief.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  {candidates.map((candidate, index) => (
                    <th scope="col" key={candidate.id}>
                      {index + 1} · {candidate.strategy}
                    </th>
                  ))}
                </tr>
              </thead>
              {GROUPS.map((group) => {
                const rows = CANDIDATE_METRICS.filter((row) => row.group === group.id)
                if (!rows.length) return null
                return (
                  <tbody key={group.id}>
                    <tr className="bw-gen-dialog__group">
                      <th scope="rowgroup" colSpan={candidates.length + 1}>
                        {group.label}
                      </th>
                    </tr>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">{row.label}</th>
                        {candidates.map((candidate) => (
                          <td
                            key={candidate.id}
                            data-tone={row.tone?.(candidate.metrics) ?? 'neutral'}
                            data-selected={candidate.id === selectedId}
                          >
                            {row.value(candidate.metrics)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                )
              })}
              <tbody>
                <tr>
                  <th scope="row">Review</th>
                  {candidates.map((candidate, index) => (
                    <td key={candidate.id}>
                      <button
                        className="bw-gen__btn"
                        onClick={() => {
                          onSelect(candidate.id)
                          onClose()
                        }}
                        aria-label={`Review candidate ${index + 1}, ${candidate.strategy}, as a ghost`}
                      >
                        {candidate.id === selectedId ? 'Under review' : 'Review'}
                      </button>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
