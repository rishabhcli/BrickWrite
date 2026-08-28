import { z } from 'zod'
import { jsonSchemaOf } from '../contract'
import { json, tool } from '../gateway'

const PartIntentSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).optional(),
  semantic: z.boolean().optional(),
})

export const intelligenceReadTools = [
  tool({
    name: 'part_intent_resolve',
    description:
      'Resolve free-form language to catalog identities with calibrated confidence, tier and placeability. Does not place parts. Pass semantic=false to skip the latent index.',
    inputSchema: jsonSchemaOf(PartIntentSchema),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = PartIntentSchema.parse(input)
      const { resolvePartIntent, resolvePartIntentSync } = await import('../../intelligence/parts/resolve')
      const semantic = request.semantic ?? true
      const result = semantic
        ? await resolvePartIntent(request.query, { limit: request.limit, semantic: true })
        : resolvePartIntentSync(request.query, { limit: request.limit, semantic: false })
      return json({
        query: result.query,
        interpretation: result.interpretation,
        elapsedMs: result.elapsedMs,
        matches: result.matches.map((match) => ({
          canonicalId: match.canonicalId,
          confidence: match.confidence,
          explanation: match.explanation,
          tier: match.tier,
          placeable: match.placeable,
        })),
      })
    },
  }),
]
