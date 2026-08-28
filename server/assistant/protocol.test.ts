// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ASSISTANT_EVENT_TYPES as CLIENT_EVENTS, ASSISTANT_PROTOCOL as CLIENT_PROTOCOL, DEFAULT_MAX_TOOL_TURNS as CLIENT_TURNS } from '../../src/agent/protocol'
import {
  ASSISTANT_EVENT_TYPES,
  ASSISTANT_PROTOCOL,
  ChatRequestSchema,
  DEFAULT_MAX_TOOL_TURNS,
  DEFAULT_MODEL,
  StructuredRequestSchema,
  WireMessageSchema,
} from './protocol.ts'

const grounding = {
  documentRevision: 4,
  documentName: 'Survey rover',
  catalogVersion: '2026-07',
  autonomy: 'propose' as const,
  partCount: 33,
  selection: ['part_0001'],
  subassemblies: [{ id: 'hull', name: 'Hull', partCount: 11, locked: false }],
  constraints: [{ id: 'c_size', kind: 'dimensions', label: 'Envelope', hard: true }],
  openNotes: [],
  validation: { healthy: true, collisions: 0, components: 1 },
}

describe('wire protocol', () => {
  it('agrees with the browser’s copy of the vocabulary', () => {
    // The browser restates these because it may not import from server/. This
    // test is the reason that restatement is safe.
    expect(ASSISTANT_PROTOCOL).toBe(CLIENT_PROTOCOL)
    expect([...ASSISTANT_EVENT_TYPES]).toEqual([...CLIENT_EVENTS])
    expect(DEFAULT_MAX_TOOL_TURNS).toBe(CLIENT_TURNS)
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5')
  })

  it('accepts a well-formed chat request', () => {
    const parsed = ChatRequestSchema.safeParse({
      protocol: ASSISTANT_PROTOCOL,
      kind: 'chat',
      mode: 'propose',
      grounding,
      messages: [{ role: 'user', text: 'What am I looking at?' }],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a request from a protocol it does not speak', () => {
    expect(
      ChatRequestSchema.safeParse({ protocol: 'something-else', kind: 'chat', mode: 'propose', grounding, messages: [] }).success,
    ).toBe(false)
  })

  it('bounds the transcript, the tool results and the images', () => {
    const many = Array.from({ length: 200 }, () => ({ role: 'user' as const, text: 'x' }))
    expect(ChatRequestSchema.safeParse({ protocol: ASSISTANT_PROTOCOL, kind: 'chat', mode: 'propose', grounding, messages: many }).success).toBe(false)

    expect(WireMessageSchema.safeParse({ role: 'tool', results: [] }).success).toBe(false)
    expect(
      WireMessageSchema.safeParse({
        role: 'tool',
        results: [{ id: 't1', name: 'scene_overview', ok: true, content: 'x'.repeat(70_000) }],
      }).success,
    ).toBe(false)
    expect(
      WireMessageSchema.safeParse({
        role: 'user',
        text: 'look',
        images: Array.from({ length: 9 }, () => ({ mediaType: 'image/png', dataBase64: 'AAAA' })),
      }).success,
    ).toBe(false)
  })

  it('carries the model’s own blocks back verbatim so a tool turn can be replayed', () => {
    const parsed = WireMessageSchema.safeParse({
      role: 'assistant',
      text: 'Reading the model.',
      toolCalls: [{ id: 'tu_1', name: 'scene_overview', input: {} }],
      raw: [{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'tool_use', id: 'tu_1', name: 'scene_overview', input: {} }],
    })
    expect(parsed.success).toBe(true)
  })

  it('bounds a structured request the same way', () => {
    expect(
      StructuredRequestSchema.safeParse({
        protocol: ASSISTANT_PROTOCOL,
        kind: 'structured',
        system: 'be exact',
        prompt: 'extract',
        schema: { type: 'object' },
      }).success,
    ).toBe(true)
    expect(
      StructuredRequestSchema.safeParse({
        protocol: ASSISTANT_PROTOCOL,
        kind: 'structured',
        system: 'x',
        prompt: 'y',
        schema: { type: 'object' },
        maxTokens: 900_000,
      }).success,
    ).toBe(false)
  })
})
