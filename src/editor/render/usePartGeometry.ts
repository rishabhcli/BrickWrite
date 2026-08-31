import { useEffect, useState } from 'react'
import { geometryCache, type PartGeometry } from '../../cad/mesh'
import type { PartDefinition } from '../../cad/types'

/**
 * Subscribes to the shared geometry cache, and holds what it hands back.
 *
 * The subscription half is why this exists at all: geometry arrives after the
 * component mounts, so a part appears when its mesh lands rather than on the
 * next unrelated render.
 *
 * The `retain` half is why it is one function instead of the two identical
 * copies that used to live in `PartVisual` and `PartBatch`. The cache is
 * bounded now, and a bounded cache that cannot tell which geometry is on screen
 * will eventually dispose something being drawn and blank it. The retention is
 * balanced against unmount, so switching documents releases the old model's
 * parts and leaves them as the first candidates for the next sweep.
 */
export function usePartGeometry(definition: PartDefinition): PartGeometry | null {
  const [geometry, setGeometry] = useState<PartGeometry | null>(() => geometryCache.get(definition))
  useEffect(() => {
    let cancelled = false
    const release = geometryCache.retain(definition)
    setGeometry(geometryCache.get(definition))
    void geometryCache.load(definition).then((loaded) => {
      if (!cancelled) setGeometry(loaded)
    })
    return () => {
      cancelled = true
      release()
    }
  }, [definition])
  return geometry
}
