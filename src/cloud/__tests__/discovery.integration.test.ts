// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import schema from '../../../convex/schema'
import { ConvexCloudBackend } from '../convexClient'
import type { CloudResult } from '../protocol'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
type Collection = 'projects' | 'branches' | 'versions' | 'members' | 'invitations' | 'comments'
async function seed(collection: Collection, count: number) {
  const deployment = convexTest(schema, modules)
  const t = deployment.withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const backend = new ConvexCloudBackend(t as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const projectId = await t.run(async ctx => {
    const project = (index: number) => ({ name: `Project ${index}`, localProjectId: `doc_${index}`,
      ownerSubject: 'hexclave|alice', visibility: 'private' as const, schemaVersion: 2,
      catalogVersion: 'fixture', createdAt: 1, updatedAt: index + 1 })
    const id = await ctx.db.insert('projects', project(0))
    const branch = (index: number) => ({ projectId: id, name: `Branch ${index}`, kind: 'named' as const,
      headRevision: 0, baseRevision: 0, createdBySubject: 'hexclave|alice', createdAt: 1, updatedAt: 1 })
    const main = await ctx.db.insert('branches', { ...branch(0), kind: 'main' })
    await ctx.db.patch(id, { defaultBranchId: main })
    await ctx.db.insert('members', { projectId: id, subject: 'hexclave|alice', role: 'owner', addedAt: 1 })
    const start = ['projects', 'branches', 'members'].includes(collection) ? 1 : 0
    for (let i = start; i < count; i++) {
      if (collection === 'projects') {
        const other = await ctx.db.insert('projects', project(i))
        await ctx.db.insert('members', { projectId: other, subject: 'hexclave|alice', role: 'owner', addedAt: 1 })
      }
      if (collection === 'branches') await ctx.db.insert('branches', branch(i))
      if (collection === 'members') await ctx.db.insert('members', { projectId: id,
        subject: `hexclave|member_${i}`, role: 'commenter', addedAt: 1 })
      if (collection === 'versions') await ctx.db.insert('versions', { projectId: id, branchId: main,
        revision: 0, label: `Version ${i}`, snapshotGroupId: `fixture-${i}`, documentChecksum: 'fixture',
        createdBySubject: 'hexclave|alice', createdAt: i })
      if (collection === 'invitations') await ctx.db.insert('invitations', { projectId: id, email: `person_${i}@example.test`,
        role: 'editor', token: `private-token-${i}`, invitedBySubject: 'hexclave|alice', createdAt: i,
        expiresAt: Date.now() + 86_400_000, status: 'pending', deliveryStatus: 'not-configured' })
      if (collection === 'comments') await ctx.db.insert('comments', { projectId: id, branchId: main,
        authorSubject: 'hexclave|alice', body: `Comment ${i}`, status: 'open',
        anchor: { partId: 'part_1', revision: 0, poseChecksum: 'fixture' }, createdAt: i, updatedAt: i })
    }
    return id
  })
  return { t, deployment, backend, projectId }
}

describe('complete cloud discovery', () => {
  it.each([
    ['projects', 201], ['branches', 65], ['versions', 201], ['members', 201], ['invitations', 101], ['comments', 501],
  ] as const)('returns every %s record beyond the old silent cap', async (collection, count) => {
    const h = await seed(collection, count)
    const args = { projectId: h.projectId }
    const result = collection === 'projects' ? await h.backend.listProjects()
      : collection === 'branches' ? await h.backend.listBranches(args)
      : collection === 'versions' ? await h.backend.listVersions(args)
      : collection === 'members' ? await h.backend.listMembers(args)
      : collection === 'invitations' ? await h.backend.listInvitations(args)
      : await h.backend.listComments(args)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toHaveLength(count)
  })

  it('returns all comments for a selected part, not the first 200', async () => {
    const h = await seed('comments', 201)
    expect(value(await h.backend.commentsForPart({ projectId: h.projectId, partId: 'part_1' }))).toHaveLength(201)
  })
})
