import { z } from 'zod'
import { jsonSchemaOf } from '../contract'
import { json, tool } from '../gateway'

const PrepareSchema = z.object({
  title: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(16).optional(),
})

const ForkSchema = z.object({
  name: z.string().min(1).max(120).optional(),
})

const host = () => import('./shareHost')

export const shareReadTools = [
  tool({
    name: 'share_prepare',
    description:
      'Freeze the current document into an immutable local publication (slug, contentHash, compact summary). Does not upload. Does not mutate the live document.',
    inputSchema: jsonSchemaOf(PrepareSchema),
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const request = PrepareSchema.parse(input ?? {})
      return json(await (await host()).prepareShare(request))
    },
  }),
]

export const shareBuildTools = [
  tool({
    name: 'share_fork_to_project',
    description:
      'Fork the last share_prepare snapshot into a new local project and open it. Notes, constraints and history are not inherited because they were never published.',
    inputSchema: jsonSchemaOf(ForkSchema),
    execute: async (input) => {
      const request = ForkSchema.parse(input ?? {})
      return json(await (await host()).forkShareToProject(request.name))
    },
  }),
]
