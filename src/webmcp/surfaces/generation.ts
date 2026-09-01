import { z } from 'zod'
import { jsonSchemaOf } from '../contract'
import { withChromeReveal } from '../chrome'
import { json, schema, tool } from '../gateway'

const PromptSchema = z.object({
  prompt: z.string().max(4000).optional(),
})

/**
 * `generation_run` already spells the same choice `useModel`. Compiling used to
 * spell it as a second tool the caller was told to reach for after the first
 * one failed, which is a worse contract for an agent: it has to notice an error
 * code and know the name of the fallback, and it doubles the surface for one
 * decision.
 */
const CompileSchema = PromptSchema.extend({
  useModel: z.boolean().default(true),
})

const GenerationSetSchema = z.object({
  prompt: z.string().max(4000).optional(),
  candidateCount: z.number().int().min(1).max(6).optional(),
  reason: z.string().min(1).max(200).optional(),
  brief: z.object({
    subject: z.string().min(1).max(200).optional(),
    envelopeStuds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).nullable().optional(),
    scale: z.enum(['micro', 'minifig', 'midi', 'large', 'unspecified']).optional(),
    functions: z.array(z.string().min(1).max(80)).max(16).optional(),
    palette: z.array(z.number().int().min(0).max(9999)).max(16).optional(),
    symmetry: z.enum(['none', 'mirror-x', 'mirror-z', 'radial']).optional(),
    partBudget: z.number().int().min(1).max(4000).nullable().optional(),
    style: z.array(z.string().min(1).max(40)).max(12).optional(),
  }).optional(),
  conflict: z.object({
    field: z.string().min(1).max(40),
    choice: z.enum(['compiler', 'operator']),
  }).optional(),
})

const GenerationRunSchema = z.object({
  useModel: z.boolean().optional(),
})

const GenerationPreviewSchema = z.object({
  candidateId: z.string().min(1).max(120),
})

const GenerationApplySchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
})

const host = () => import('../../generation/mcpHost')

export const generationReadTools = [
  tool({
    name: 'generation_compile',
    description:
      'Compile the current prompt into a DesignBrief. useModel=true (the default) goes through /api/brief; '
      + 'useModel=false compiles from rules in this browser, which is the path to take when the model reports '
      + 'MODEL_UNAVAILABLE. Does not mutate the CAD document.',
    inputSchema: jsonSchemaOf(CompileSchema),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = CompileSchema.parse(input ?? {})
      const surface = await host()
      return json(
        request.useModel
          ? await surface.compileBriefFromServer(request.prompt)
          : surface.compileBriefLocal(request.prompt),
      )
    },
  }),
  tool({
    name: 'generation_set',
    description:
      'Update the generation prompt, candidate count, brief fields or a conflict resolution. Does not write the CAD document.',
    inputSchema: jsonSchemaOf(GenerationSetSchema),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = GenerationSetSchema.parse(input ?? {})
      return json((await host()).setGeneration(request))
    },
  }),
  tool({
    name: 'generation_run',
    description:
      'Run the generation pipeline against the current document. useModel=false is the deterministic path. Does not write the document until generation_apply.',
    inputSchema: jsonSchemaOf(GenerationRunSchema),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = GenerationRunSchema.parse(input ?? {})
      return json(withChromeReveal('generation', await (await host()).runGeneration(request.useModel)))
    },
  }),
  tool({
    name: 'generation_state',
    description: 'Read the compact generation session: brief, candidates, ghost and outcome. Never includes full graphs or operation arrays.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    execute: async () => json((await host()).generationState()),
  }),
  tool({
    name: 'generation_cancel',
    description: 'Cancel an in-flight generation. Nothing was written to the document.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    execute: async () => json((await host()).cancelGeneration()),
  }),
]

export const generationProposeTools = [
  tool({
    name: 'generation_preview',
    description: 'Preview one generated candidate as a kernel ghost proposal without mutating the document.',
    inputSchema: jsonSchemaOf(GenerationPreviewSchema),
    execute: async (input) => {
      const request = GenerationPreviewSchema.parse(input)
      return json(withChromeReveal('generation', (await host()).previewCandidate(request.candidateId)))
    },
  }),
]

export const generationBuildTools = [
  tool({
    name: 'generation_apply',
    description:
      'Commit the previewed generation candidate as one agent transaction. Requires Build autonomy and a collision-free ghost from generation_preview.',
    inputSchema: jsonSchemaOf(GenerationApplySchema),
    execute: async (input) => {
      const request = GenerationApplySchema.parse(input ?? {})
      return json((await host()).applyGeneration(request.expectedRevision))
    },
  }),
]
