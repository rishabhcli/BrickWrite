import { describe, expect, it, vi } from 'vitest'
import { awaitWithAbort, deadlineSignal, readNdjsonLines, readResponseJson } from './contracts'

const streamFromChunks = (chunks: readonly Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

describe('readNdjsonLines', () => {
  it('preserves UTF-8 code points and records split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"text":"brick 🧱"}\n{"done":true}\n')
    const splitInsideEmoji = bytes.indexOf(0xf0) + 2
    const lines: string[] = []

    await readNdjsonLines(
      streamFromChunks([
        bytes.slice(0, 5),
        bytes.slice(5, splitInsideEmoji),
        bytes.slice(splitInsideEmoji, bytes.length - 3),
        bytes.slice(bytes.length - 3),
      ]),
      (line) => lines.push(line),
    )

    expect(lines).toEqual(['{"text":"brick 🧱"}', '{"done":true}'])
  })

  it('delivers an unterminated final record exactly once', async () => {
    const lines: string[] = []
    await readNdjsonLines(streamFromChunks([new TextEncoder().encode('{"tail":1}')]), (line) => lines.push(line))
    expect(lines).toEqual(['{"tail":1}'])
  })
})

it('cancels and releases a reader after a malformed frame callback', async () => {
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('bad\n'))
    },
    cancel() {
      cancelled += 1
    },
  })
  await expect(
    readNdjsonLines(stream, () => {
      throw new Error('malformed')
    }),
  ).rejects.toThrow('malformed')
  expect(cancelled).toBe(1)
  expect(stream.locked).toBe(false)
})

it.each([
  { text: '🧱🧱', limits: { maxLineBytes: 7 }, message: 'frame' },
  { text: 'a\nb\nc\n', limits: { maxTotalBytes: 5 }, message: 'total' },
])('enforces actual wire-byte limits: $message', async ({ text, limits, message }) => {
  const bytes = new TextEncoder().encode(text)
  const stream = streamFromChunks([...bytes].map((byte) => Uint8Array.of(byte)))
  await expect(readNdjsonLines(stream, () => {}, limits)).rejects.toThrow(message)
  expect(stream.locked).toBe(false)
})

it('rejects invalid UTF-8 rather than silently changing the payload', async () => {
  await expect(readNdjsonLines(streamFromChunks([Uint8Array.of(0xff, 10)]), () => {})).rejects.toThrow()
})

it('releases a reader on a clean EOF', async () => {
  const stream = streamFromChunks([])
  await readNdjsonLines(stream, () => {})
  expect(stream.locked).toBe(false)
})

describe('abortable JSON bodies and promises', () => {
  it('cancels a stalled JSON body and releases its reader', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const abort = new AbortController()
    const reading = readResponseJson(new Response(body), abort.signal)
    const outcome = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await outcome
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('bounds structured/error bodies in bytes and closes the reader on overflow', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"text":"🧱"}'))
      },
      cancel,
    })
    await expect(readResponseJson(new Response(body), undefined, 8)).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('decodes structured JSON split inside a UTF-8 codepoint', async () => {
    const bytes = new TextEncoder().encode('{"text":"🧱"}')
    await expect(
      readResponseJson(new Response(streamFromChunks([...bytes].map((byte) => Uint8Array.of(byte))))),
    ).resolves.toEqual({ text: '🧱' })
  })

  it('stops awaiting an uncooperative promise and absorbs its late rejection', async () => {
    let reject!: (reason: Error) => void
    const work = new Promise<void>((_resolve, fail) => {
      reject = fail
    })
    const abort = new AbortController()
    const awaited = awaitWithAbort(work, abort.signal)
    const outcome = expect(awaited).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await outcome
    reject(new Error('late SDK failure'))
    await Promise.resolve()
  })

  it('cleans up listeners when work completes without aborting its parent', async () => {
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    expect(await awaitWithAbort(Promise.resolve(42), abort.signal)).toBe(42)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(abort.signal.aborted).toBe(false)
  })

  it('disposes deadline timers and parent listeners on successful requests', async () => {
    vi.useFakeTimers()
    try {
      const parent = new AbortController()
      const remove = vi.spyOn(parent.signal, 'removeEventListener')
      const lifetime = deadlineSignal(100, parent.signal)
      lifetime.dispose()
      await vi.advanceTimersByTimeAsync(500)
      parent.abort()
      expect(lifetime.signal.aborted).toBe(false)
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
