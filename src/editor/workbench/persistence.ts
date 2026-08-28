import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Workspace preferences that outlive a session.
 *
 * Layout, favourites, saved selections and the shortcut map are the operator's
 * own configuration, not model state, so they belong in local storage rather
 * than in the revisioned document. A blocked or full storage context is not a
 * reason to fail an editing session, so every access degrades to in-memory.
 */

const PREFIX = 'brickwright.workbench.'

/** In-memory mirror, so a blocked storage context still behaves consistently. */
const memory = new Map<string, string>()

export function readPreference<T>(key: string, fallback: T): T {
  const full = PREFIX + key
  let raw: string | null | undefined
  try {
    raw = window.localStorage.getItem(full)
  } catch {
    raw = memory.get(full) ?? null
  }
  if (raw === null || raw === undefined) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    // A value written by an older build that no longer parses is discarded
    // rather than allowed to crash the editor on boot.
    return fallback
  }
}

export function writePreference(key: string, value: unknown): void {
  const full = PREFIX + key
  const raw = JSON.stringify(value)
  memory.set(full, raw)
  try {
    window.localStorage.setItem(full, raw)
  } catch {
    // Quota or a private context. The in-memory mirror keeps the session
    // consistent; it simply will not survive a reload.
  }
}

export function clearPreference(key: string): void {
  const full = PREFIX + key
  memory.delete(full)
  try {
    window.localStorage.removeItem(full)
  } catch {
    // Nothing to do; the mirror is already cleared.
  }
}

/**
 * State that writes itself back to local storage.
 *
 * Reads happen once on mount so a re-render never re-parses JSON, and writes
 * are synchronous because these are small values an operator expects to survive
 * a hard reload immediately after changing them.
 */
export function usePersistentState<T>(key: string, fallback: T): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPreference(key, fallback))
  const latest = useRef(value)
  latest.current = value

  const update = useCallback(
    (next: T | ((current: T) => T)) => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(latest.current) : next
      latest.current = resolved
      setValue(resolved)
      writePreference(key, resolved)
    },
    [key],
  )

  // Another tab editing the same preference should not leave this one stale.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PREFIX + key) return
      setValue(readPreference(key, fallback))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
    // `fallback` is only read when the key is absent, so it does not need to
    // participate in the subscription's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return [value, update]
}
