import { catalog } from './catalog'
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
    const parsed = JSON.parse(raw) as ModelDocument
    if (parsed.schemaVersion !== 1 || !parsed.parts || !parsed.subassemblies) return null
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

export function clearLocalDocument() {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // No-op in privacy modes that block localStorage.
  }
}
