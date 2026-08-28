import type { KvNamespace } from './adapter'

/**
 * An in-process `KvNamespace`, for tests and for the studio's offline preview.
 *
 * This is a **test double**, and it is named and located so that it cannot be
 * mistaken for the storage layer. Production is Cloudflare KV; local
 * development is the file-backed namespace in `functions/_lib/file-kv.ts`.
 * Nothing in the request path constructs one of these.
 *
 * It exists because the alternative is worse: without an in-process namespace,
 * the immutability, privacy, token and access tests would need a live KV
 * binding, and tests that need infrastructure are tests that stop being run.
 *
 * Bytes are copied on write and on read, so a caller cannot mutate stored data
 * through a retained reference — a real KV cannot be mutated that way either,
 * and a fake that permits it would hide a class of bug the tests exist to find.
 */
export class MemoryKv implements KvNamespace {
  private readonly entries = new Map<string, Uint8Array>()
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()

  get(key: string, type: 'text'): Promise<string | null>
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  async get(key: string, type: 'text' | 'arrayBuffer'): Promise<string | ArrayBuffer | null> {
    const value = this.entries.get(key)
    if (!value) return null
    if (type === 'text') return this.decoder.decode(value)
    return value.slice().buffer as ArrayBuffer
  }

  async put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (typeof value === 'string') {
      this.entries.set(key, this.encoder.encode(value))
      return
    }
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    this.entries.set(key, bytes.slice())
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }> {
    // Sorted, so the feed index's newest-first key ordering behaves the same
    // here as it does in KV. A Map's insertion order would not.
    const matching = [...this.entries.keys()].filter((key) => key.startsWith(options.prefix)).sort()
    const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0
    const limit = options.limit ?? 1000
    const page = matching.slice(start, start + limit)
    const next = start + page.length
    return {
      keys: page.map((name) => ({ name })),
      list_complete: next >= matching.length,
      cursor: next >= matching.length ? undefined : String(next),
    }
  }

  /** Test affordance: how many keys exist under a prefix. */
  count(prefix = ''): number {
    let total = 0
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) total += 1
    return total
  }
}
