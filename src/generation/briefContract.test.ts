import { describe, expect, it } from 'vitest'
import { compileBrief, DESIGN_BRIEF_SCHEMA } from './brief'
import { BRIEF_SCHEMA, BRIEF_SYSTEM, type ModelProvider, type ModelRequest } from '../platform/contracts'

/**
 * Both brief compilers ask for the same thing.
 *
 * There are two: `POST /api/brief` in the API process, and this one in the
 * browser through whatever `ModelProvider` it was handed. Each held its own
 * prompt and its own schema, and each carried a comment saying the two must not
 * drift into disagreeing about what a brief means — with nothing anywhere
 * checking that they had not.
 *
 * The schema is the half that would have hurt. `briefProvenance` hashes it, so
 * two copies that disagreed would not merely ask for different things: the same
 * request compiled either way would be identified as a different brief.
 *
 * There is one definition now, in the dependency-free contract module the API
 * process can load without pulling the catalogue into Node. These assert both
 * callers still reach for it, so re-inlining either fails here.
 */

const answer = {
  subject: 'red pickup truck',
  envelopeWidthStuds: 14,
  envelopeHeightStuds: 6,
  envelopeDepthStuds: 8,
  scale: 'minifig',
  functions: [],
  paletteColourNames: [],
  symmetry: 'mirror-x',
  partBudget: null,
  style: [],
  evidence: [{ field: 'subject', phrase: 'a red pickup truck' }],
  conflicts: [],
}

/** Records what the compiler asked for, then answers it. */
function recordingProvider() {
  const asked: Array<ModelRequest<unknown>> = []
  const provider: ModelProvider = {
    id: 'recording',
    model: 'test',
    async complete(request) {
      asked.push(request as ModelRequest<unknown>)
      return {
        value: request.parse(answer),
        provenance: {
          provider: 'recording',
          model: 'test',
          promptHash: 'test',
          seed: 0,
          createdAt: new Date(0).toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
  }
  return { asked, provider }
}

describe('the brief contract', () => {
  it('is asked for by the browser compiler, not restated by it', async () => {
    const { asked, provider } = recordingProvider()
    const result = await compileBrief('Build a red pickup truck 14 x 8 studs', { provider })

    expect(result.method).toBe('model')
    expect(asked).toHaveLength(1)
    expect(asked[0].system).toBe(BRIEF_SYSTEM)
    expect(asked[0].schema).toBe(BRIEF_SCHEMA)
  })

  it('exposes the shared schema under the name its callers already use', () => {
    // `src/generation/index.ts` re-exports this, and the provenance hash reads
    // it. Keeping the name means one definition without moving that surface.
    expect(DESIGN_BRIEF_SCHEMA).toBe(BRIEF_SCHEMA)
  })

  it('describes the fields the compiler actually reads back', () => {
    // A schema that stopped requiring a field the parser needs would show up as
    // the model omitting it, which reads as the model getting worse.
    const required = (BRIEF_SCHEMA as { required: readonly string[] }).required
    for (const field of ['subject', 'scale', 'symmetry', 'evidence', 'conflicts', 'paletteColourNames']) {
      expect(required).toContain(field)
    }
  })
})
