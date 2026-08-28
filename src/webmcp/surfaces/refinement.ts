import { z } from 'zod'
import { jsonSchemaOf } from '../contract'
import { withChromeReveal } from '../chrome'
import { json, schema, tool } from '../gateway'

const AnalyseSchema = z.object({
  partIds: z.array(z.string().min(1).max(80)).max(500).optional(),
})

const ProposeSchema = z.object({
  instruction: z.string().max(800).optional(),
  effort: z.enum(['quick', 'standard', 'thorough']).optional(),
  partIds: z.array(z.string().min(1).max(80)).max(500).optional(),
})

const SelectSchema = z.object({
  proposalId: z.string().min(1).max(120),
})

const ApplySchema = z.object({
  proposalId: z.string().min(1).max(120).optional(),
  expectedRevision: z.number().int().min(0).optional(),
})

const host = () => import('../../refinement/mcpHost')

export const refinementReadTools = [
  tool({
    name: 'refinement_analyse',
    description:
      'Measure issues in a region (selection, or partIds). Compact: issue kinds, seam count, weak attachments. Does not mutate the document.',
    inputSchema: jsonSchemaOf(AnalyseSchema),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = AnalyseSchema.parse(input ?? {})
      return json((await host()).analyseSelection(request.partIds))
    },
  }),
  tool({
    name: 'refinement_propose',
    description:
      'Search for ranked refinement proposals over the selection or partIds. Does not write the document until refinement_apply.',
    inputSchema: jsonSchemaOf(ProposeSchema),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = ProposeSchema.parse(input ?? {})
      return json(withChromeReveal('refinement', await (await host()).proposeRefinements(request)))
    },
  }),
  tool({
    name: 'refinement_state',
    description: 'Read the compact refinement session: status, ranked proposals, outcome. Never includes operation arrays.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    execute: async () => json((await host()).refinementState()),
  }),
  tool({
    name: 'refinement_cancel',
    description: 'Cancel an in-flight refinement search. The document is unchanged.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    execute: async () => json((await host()).cancelRefinement()),
  }),
]

export const refinementProposeTools = [
  tool({
    name: 'refinement_select',
    description: 'Select a ranked refinement proposal for review. Does not mutate the document.',
    inputSchema: jsonSchemaOf(SelectSchema),
    execute: async (input) => {
      const request = SelectSchema.parse(input)
      return json(withChromeReveal('refinement', (await host()).selectRefinement(request.proposalId)))
    },
  }),
]

export const refinementBuildTools = [
  tool({
    name: 'refinement_apply',
    description:
      'Commit the selected (or named) refinement proposal as one agent transaction at its base revision.',
    inputSchema: jsonSchemaOf(ApplySchema),
    execute: async (input) => {
      const request = ApplySchema.parse(input ?? {})
      return json((await host()).applyRefinementProposal(request))
    },
  }),
]
