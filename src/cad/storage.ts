import { catalog } from './catalog'
import { basisFromEulerDegrees, type Vec3 } from './math'
import type { ModelDocument } from './types'

const STORAGE_KEY = 'brickwright.document.v1'

export function saveLocalDocument(document: ModelDocument) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document))
  } catch {
    // Local persistence is best-effort; the editable document remains in memory.
  }
}

export function loadLocalDocument(): ModelDocument | null {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = migrate(JSON.parse(raw) as Record<string, unknown>)
    if (!parsed || !parsed.parts || !parsed.subassemblies) return null
    // A document authored against a different catalog revision may reference
    // parts, colours or transforms this build cannot reproduce exactly. Rather
    // than render it approximately, drop it and start from the showcase.
    if (parsed.catalogVersion !== catalog.version) return null
    if (Object.values(parsed.parts).some((part) => !catalog.get(part.definitionId))) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Brings a stored document up to the current schema.
 *
 * Schema 1 stored orientation as Euler degrees and had no connection edges.
 * Rather than discarding those documents, the angles are converted to the exact
 * basis the kernel now stores and the edges are re-derived on load.
 */
function migrate(raw: Record<string, unknown>): ModelDocument | null {
  const version = Number(raw.schemaVersion)
  if (version === 2) return raw as unknown as ModelDocument
  if (version !== 1) return null

  const document = raw as unknown as ModelDocument & { parts: Record<string, { transform: { position: Vec3; rotation?: Vec3; basis?: unknown } }> }
  for (const part of Object.values(document.parts ?? {})) {
    const legacy = part.transform as { position: Vec3; rotation?: Vec3 }
    if (legacy.rotation) {
      part.transform = { position: legacy.position, basis: basisFromEulerDegrees(legacy.rotation) }
    }
  }
  document.connections = {}
  document.schemaVersion = 2
  return document
}

export function clearLocalDocument() {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // No-op in privacy modes that block localStorage.
  }
}
