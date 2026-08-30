import { v } from 'convex/values'
import { query } from './_generated/server'
import { authoriseProject, iso, readIdentity, UNAUTHENTICATED } from './model/auth'
import { indexedPage, pageArguments } from './model/discovery'
import { branchRecord, commentRecord, invitationRecord, memberRecord, versionRecord } from './model/records'
import type { CloudPage, CloudProjectSummary, CloudResult } from './model/protocol'

/** Explicit page endpoints for agents and complete-list traversal in the UI. */
export const projects = query({
  args: pageArguments,
  handler: async (ctx, args): Promise<CloudResult<CloudPage<CloudProjectSummary>>> => {
    const identity = await readIdentity(ctx)
    if (!identity) return { ok: false, error: UNAUTHENTICATED }
    const memberships = ctx.db.query('members').withIndex('by_subject', q => q.eq('subject', identity.subject))
    return indexedPage(memberships, args, JSON.stringify(['projects', identity.subject]), async membership => {
      const project = await ctx.db.get(membership.projectId)
      if (!project || project.deletedAt !== undefined) return null
      const branch = project.defaultBranchId ? await ctx.db.get(project.defaultBranchId) : null
      return { projectId: project._id, localProjectId: project.localProjectId, name: project.name,
        ownerSubject: project.ownerSubject, visibility: project.visibility, role: membership.role,
        defaultBranchId: branch?._id ?? '', headRevision: branch?.headRevision ?? 0,
        schemaVersion: project.schemaVersion, catalogVersion: project.catalogVersion,
        createdAt: iso(project.createdAt), updatedAt: iso(project.updatedAt) }
    // Each membership fans out into two more document reads. Keep the window
    // safe even for legacy metadata rows near Convex's per-document ceiling.
    }, 5)
  },
})

export const branches = query({
  args: { projectId: v.string(), ...pageArguments },
  handler: async (ctx, args) => {
    const auth = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!auth.ok) return auth
    return indexedPage(ctx.db.query('branches').withIndex('by_project', q => q.eq('projectId', auth.value.project._id)),
      args, JSON.stringify(['branches', auth.value.identity.subject, args.projectId]), branchRecord)
  },
})

export const versions = query({
  args: { projectId: v.string(), ...pageArguments },
  handler: async (ctx, args) => {
    const auth = await authoriseProject(ctx, args.projectId, 'project.read')
    if (!auth.ok) return auth
    return indexedPage(ctx.db.query('versions').withIndex('by_project_created', q => q.eq('projectId', auth.value.project._id)).order('desc'),
      args, JSON.stringify(['versions', auth.value.identity.subject, args.projectId]), versionRecord)
  },
})

export const members = query({
  args: { projectId: v.string(), ...pageArguments },
  handler: async (ctx, args) => {
    const auth = await authoriseProject(ctx, args.projectId, 'member.list')
    if (!auth.ok) return auth
    return indexedPage(ctx.db.query('members').withIndex('by_project', q => q.eq('projectId', auth.value.project._id)),
      args, JSON.stringify(['members', auth.value.identity.subject, args.projectId]), memberRecord)
  },
})

export const invitations = query({
  args: { projectId: v.string(), ...pageArguments },
  handler: async (ctx, args) => {
    const auth = await authoriseProject(ctx, args.projectId, 'member.invite')
    if (!auth.ok) return auth
    return indexedPage(ctx.db.query('invitations').withIndex('by_project', q => q.eq('projectId', auth.value.project._id)).order('desc'),
      args, JSON.stringify(['invitations', auth.value.identity.subject, args.projectId]), invitationRecord)
  },
})

export const comments = query({
  args: { projectId: v.string(), status: v.optional(v.union(v.literal('open'), v.literal('resolved'))),
    partId: v.optional(v.string()), ...pageArguments },
  handler: async (ctx, args) => {
    const auth = await authoriseProject(ctx, args.projectId, 'comment.read')
    if (!auth.ok) return auth
    const projectId = auth.value.project._id
    const comments = args.partId !== undefined
      ? ctx.db.query('comments').withIndex('by_project_anchor', q => q.eq('projectId', projectId).eq('anchor.partId', args.partId!))
      : args.status !== undefined
        ? ctx.db.query('comments').withIndex('by_project_status', q => q.eq('projectId', projectId).eq('status', args.status!))
        : ctx.db.query('comments').withIndex('by_project_created', q => q.eq('projectId', projectId))
    // Filter after the bounded read, not after a truncated result list. An empty
    // filtered page still carries its continuation and is not end-of-list.
    return indexedPage(comments, args,
      JSON.stringify(['comments', auth.value.identity.subject, args.projectId, args.status ?? null, args.partId ?? null]),
      row => args.status && row.status !== args.status ? null : commentRecord(row))
  },
})
