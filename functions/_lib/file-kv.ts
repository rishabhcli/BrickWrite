import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvNamespace } from '../../src/features/share/backend/adapter'

/**
 * A filesystem-backed `KvNamespace` for local development and the acceptance
 * run.
 *
 * Production is Cloudflare KV. This exists because the alternative for local
 * work is an in-memory map, and an in-memory map is exactly the thing this
 * workstream is not allowed to ship: a publication that disappears when the dev
 * server restarts is not a publication, and an acceptance run that cannot
 * restart the server between publish and fetch is not proving anything.
 *
 * Keys are stored as `encodeURIComponent(key)` filenames, which is reversible
 * and produces no path separators — so a key containing `../` cannot escape the
 * directory. Values are written as raw bytes, so a PNG round-trips unchanged.
 */
export class FileKv implements KvNamespace {
  private ready: Promise<void> | null = null

  constructor(private readonly directory: string) {}

  private ensure(): Promise<void> {
    this.ready ??= mkdir(this.directory, { recursive: true }).then(() => undefined)
    return this.ready
  }

  private path(key: string): string {
    return join(this.directory, encodeURIComponent(key))
  }

  get(key: string, type: 'text'): Promise<string | null>
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>
  async get(key: string, type: 'text' | 'arrayBuffer'): Promise<string | ArrayBuffer | null> {
    await this.ensure()
    try {
      const buffer = await readFile(this.path(key))
      if (type === 'text') return buffer.toString('utf8')
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
  }

  async put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void> {
    await this.ensure()
    const bytes =
      typeof value === 'string'
        ? Buffer.from(value, 'utf8')
        : Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value))
    await writeFile(this.path(key), bytes)
  }

  async delete(key: string): Promise<void> {
    await this.ensure()
    await rm(this.path(key), { force: true })
  }

  async list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    list_complete: boolean
    cursor?: string
  }> {
    await this.ensure()
    const names = (await readdir(this.directory))
      .map((entry) => decodeURIComponent(entry))
      .filter((name) => name.startsWith(options.prefix))
      // Sorted, because the feed index encodes its ordering in the key and KV
      // lists ascending. An unsorted listing would make the gallery order
      // depend on directory entry order, which is not a thing anybody controls.
      .sort()
    const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0
    const page = names.slice(start, start + (options.limit ?? 1000))
    const next = start + page.length
    return {
      keys: page.map((name) => ({ name })),
      list_complete: next >= names.length,
      cursor: next >= names.length ? undefined : String(next),
    }
  }
}
