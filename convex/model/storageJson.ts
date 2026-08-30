/** Check data before recursive canonicalization or schema parsing. Optional
 * object properties may be undefined (the wire serializer omits them), but
 * array holes and non-JSON values must never turn into different saved data. */
export function storageJsonProblem(root: unknown): string | null {
  try {
    return inspectJson(root)
  } catch {
    return 'unreadable object data'
  }
}

function inspectJson(root: unknown): string | null {
  const active = new WeakSet<object>()
  type Frame = { value: unknown; depth: number; leave?: boolean; optional?: boolean }
  const pending: Frame[] = [{ value: root, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const { value, depth, leave, optional } = pending.pop()!
    if (leave) {
      active.delete(value as object)
      continue
    }
    if (++nodes > 1_000_000 || depth > 128) return 'excessive nesting or collection size'
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'a non-finite number'
      continue
    }
    if (value === undefined && optional) continue
    if (typeof value !== 'object') return 'a non-JSON value'
    if (active.has(value)) return 'a cyclic object'
    if (Object.getOwnPropertySymbols(value).length) return 'a symbol-keyed property'
    const array = Array.isArray(value)
    if (!array) {
      const prototype = Object.getPrototypeOf(value)
      if (
        prototype !== null &&
        (Object.getPrototypeOf(prototype) !== null ||
          Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name !== 'Object')
      )
        return 'a non-JSON object'
    }
    active.add(value)
    pending.push({ value, depth, leave: true })
    // Bound width before allocating a traversal frame per entry.
    const keys = Object.keys(value)
    if (keys.length + nodes > 1_000_000) return 'excessive collection size'
    if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))
      return 'a sparse or extended array'
    if (Object.getOwnPropertyNames(value).length !== keys.length + (array ? 1 : 0)) return 'non-enumerable data'
    for (const key of keys) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return 'an unsafe object key'
      const property = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in property)) return 'an accessor instead of stored data'
      pending.push({ value: property.value, depth: depth + 1, optional: !array })
    }
  }
  return null
}
