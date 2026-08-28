// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AnthropicModelProvider } from './provider.ts'
import { createAssistantRoute } from './handler.ts'
import { ASSISTANT_PROTOCOL, type AssistantEvent } from './protocol.ts'

/**
 * The live smoke test.
 *
 * Guarded by an explicit opt-in *and* the credential. Developer shells often
 * carry a model key for the running application; `npm test` must not turn that
 * ambient credential into a paid, nondeterministic network test. This is the
 * only suite that proves the thing every other test assumes: that this code can
 * actually talk to a model.
 *
 * Run it with:
 *   BRICKWRIGHT_LIVE_TESTS=1 ANTHROPIC_API_KEY=... npm run test:live:assistant
 */

const configured = process.env.BRICKWRIGHT_LIVE_TESTS === '1' && Boolean(process.env.ANTHROPIC_API_KEY?.trim())
const report = (label: string, value: unknown) => {
  process.stdout.write(`\n[live] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

let server: Server | null = null
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
})

describe.skipIf(!configured)('live provider', () => {
  it(
    'satisfies the ModelProvider contract against the real API',
    async () => {
      const Schema = z.object({
        summary: z.string().min(1).max(200),
        studsPerBrickLength: z.number().int().min(1).max(16),
        confident: z.boolean(),
      })

      const provider = new AnthropicModelProvider()
      expect(provider.configured).toBe(true)

      const result = await provider.complete({
        system:
          'You answer questions about LEGO geometry precisely and briefly. Reply with JSON matching the schema and nothing else.',
        prompt: 'How many studs long is a standard 2 x 4 LEGO brick? Set studsPerBrickLength to that number.',
        schema: z.toJSONSchema(Schema, { io: 'output' }) as Record<string, unknown>,
        parse: (raw) => Schema.parse(raw),
        maxTokens: 512,
      })

      report('model', provider.model)
      report('structured value', result.value)
      report('provenance', result.provenance)
      report('usage', result.usage)

      expect(result.value.studsPerBrickLength).toBe(4)
      expect(result.provenance.provider).toBe('anthropic')
      expect(result.provenance.model).toBe(provider.model)
      expect(result.usage.inputTokens).toBeGreaterThan(0)
      expect(result.usage.outputTokens).toBeGreaterThan(0)
    },
    120_000,
  )

  it(
    'streams a grounded turn through the real route and asks for a real tool',
    async () => {
      const route = createAssistantRoute({ timeoutMs: 90_000 })
      server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
        void route.handle(request, response, url)
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (typeof address === 'string' || address === null) throw new Error('no port')
      const base = `http://127.0.0.1:${address.port}`

      const response = await fetch(`${base}/api/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: ASSISTANT_PROTOCOL,
          kind: 'chat',
          mode: 'propose',
          grounding: {
            documentRevision: 7,
            documentName: 'Survey rover',
            catalogVersion: '2026-07',
            autonomy: 'propose',
            partCount: 33,
            selection: ['part_0001'],
            subassemblies: [
              { id: 'chassis', name: 'Chassis', partCount: 9, locked: false },
              { id: 'cockpit', name: 'Cockpit', partCount: 3, locked: true },
            ],
            constraints: [{ id: 'c_size', kind: 'dimensions', label: 'Envelope <= 10 x 14 studs', hard: true }],
            openNotes: [],
            validation: { healthy: true, collisions: 0, components: 1 },
          },
          messages: [{ role: 'user', text: 'Which parts are in the chassis, and what is currently selected? Use a tool to check.' }],
        }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/x-ndjson')

      const raw = await response.text()
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AssistantEvent)

      report(
        'event types',
        events.map((event) => event.type),
      )
      report(
        'assistant text',
        events
          .filter((event): event is Extract<AssistantEvent, { type: 'text' }> => event.type === 'text')
          .map((event) => event.text)
          .join(''),
      )
      report(
        'tool calls',
        events.filter((event) => event.type === 'tool_call').map((event) => (event as Extract<AssistantEvent, { type: 'tool_call' }>).call),
      )
      report('usage', events.find((event) => event.type === 'usage'))
      report('stop', events.at(-1))

      expect(events[0].type).toBe('start')
      expect(events.some((event) => event.type === 'usage')).toBe(true)
      expect(events.at(-1)?.type).toBe('done')
      expect(events.some((event) => event.type === 'error')).toBe(false)

      // Grounded, not guessing: it asked the document rather than answering
      // from the summary in the system prompt.
      const toolCalls = events.filter(
        (event): event is Extract<AssistantEvent, { type: 'tool_call' }> => event.type === 'tool_call',
      )
      expect(toolCalls.length).toBeGreaterThan(0)
      expect(['scene_query', 'scene_overview', 'selection_geometry']).toContain(toolCalls[0].call.name)
      expect((events.at(-1) as Extract<AssistantEvent, { type: 'done' }>).stop).toBe('tool_use')
    },
    120_000,
  )
})

describe.skipIf(configured)('live provider (skipped)', () => {
  it('is skipped unless live tests are explicitly enabled with a credential', () => {
    expect(configured).toBe(false)
  })
})
