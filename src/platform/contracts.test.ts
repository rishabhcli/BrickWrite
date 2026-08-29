import { describe, expect, it } from 'vitest'
import { readNdjsonLines } from './contracts'

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
