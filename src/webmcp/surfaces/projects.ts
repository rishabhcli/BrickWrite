import { z } from 'zod'
import { session, type ProjectSwitch } from '../../cad/session'
import { cadEngine } from '../../cad/engine'
import { ContractError, jsonSchemaOf } from '../contract'
import { discardReview } from '../surfaceSnapshot'
import { json, schema, tool } from '../gateway'

const ProjectIdSchema = z.object({
  projectId: z.string().min(1).max(120),
})

const ProjectNameSchema = z.object({
  name: z.string().min(1).max(120).optional(),
})

export function assertProjectSwitch(result: ProjectSwitch): void {
  if (result.ok) return
  if (result.code === 'NOT_FOUND') {
    throw new ContractError('PROJECT_NOT_FOUND', result.message ?? 'That project is no longer in local storage.', 'Call project_list and pick a current id.')
  }
  if (result.code === 'OPEN_PROJECT') {
    throw new ContractError('OPEN_PROJECT', result.message ?? 'The open project cannot be deleted.', 'Switch to another project before deleting this one.')
  }
  if (result.code === 'UNPLACEABLE_PARTS') {
    throw new ContractError(
      'UNPLACEABLE_PARTS',
      result.message ?? 'That project references parts this catalog cannot place.',
      'Stay on the current project; those parts have no compiled geometry in this catalog.',
    )
  }
  throw new ContractError('INVALID_OPERATION', result.message ?? 'The project operation failed.', 'Call project_list and retry.')
}

const compactSwitch = (result: ProjectSwitch) => ({
  ok: true,
  projectId: session.currentProjectId,
  documentRevision: cadEngine.getDocument().revision,
  partCount: Object.keys(cadEngine.getDocument().parts).length,
  restore: result.restore ?? null,
})

export const projectReadTools = [
  tool({
    name: 'project_list',
    description: 'List locally persisted CAD projects (id, name, revision, part count, savedAt). Does not switch the open document.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    execute: async () => {
      const projects = await session.listProjects()
      return json({
        currentProjectId: session.currentProjectId,
        projects: projects.map((project) => ({
          projectId: project.projectId,
          name: project.name,
          revision: project.revision,
          partCount: project.partCount,
          savedAt: project.savedAt,
        })),
      })
    },
  }),
]

export const projectBuildTools = [
  tool({
    name: 'project_open',
    description: 'Flush the open project and switch the editor to another stored project. Withdraws any generation or refinement review first.',
    inputSchema: jsonSchemaOf(ProjectIdSchema),
    execute: async (input) => {
      const request = ProjectIdSchema.parse(input)
      discardReview()
      const result = await session.openProject(request.projectId)
      assertProjectSwitch(result)
      return json(compactSwitch(result))
    },
  }),
  tool({
    name: 'project_create',
    description: 'Checkpoint the open project and start an empty document. Requires Build autonomy.',
    inputSchema: jsonSchemaOf(ProjectNameSchema),
    execute: async (input) => {
      const request = ProjectNameSchema.parse(input ?? {})
      discardReview()
      const result = await session.createProject(request.name)
      assertProjectSwitch(result)
      return json(compactSwitch(result))
    },
  }),
  tool({
    name: 'project_fork',
    description: 'Checkpoint the open project and open a copy under a new id.',
    inputSchema: jsonSchemaOf(ProjectNameSchema),
    execute: async (input) => {
      const request = ProjectNameSchema.parse(input ?? {})
      discardReview()
      const result = await session.forkProject(request.name)
      assertProjectSwitch(result)
      return json(compactSwitch(result))
    },
  }),
  tool({
    name: 'project_delete',
    description: 'Delete a stored project that is not currently open. Refuses OPEN_PROJECT on the live document.',
    inputSchema: jsonSchemaOf(ProjectIdSchema),
    execute: async (input) => {
      const request = ProjectIdSchema.parse(input)
      const result = await session.deleteProject(request.projectId)
      assertProjectSwitch(result)
      return json({ ok: true, projectId: request.projectId, currentProjectId: session.currentProjectId })
    },
  }),
]
