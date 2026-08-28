import { useEffect, useState } from 'react'

/**
 * Whether the browser believes it can reach the network.
 *
 * `navigator.onLine` is a weak signal — it reports link state, not reachability
 * — so the shell uses it only to explain a degraded account layer, never to
 * block editing. A document that has already booted is entirely local, and an
 * offline browser must keep working on it.
 */
export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  return navigator.onLine !== false
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(isOnline)
  useEffect(() => {
    const update = () => setOnline(isOnline())
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    // Re-read on mount: the browser may have changed state between the initial
    // render and the effect, and the events for that window are already gone.
    update()
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}
