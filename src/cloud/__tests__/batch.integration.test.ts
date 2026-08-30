// @vitest-environment edge-runtime
import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { describe, expect, it } from 'vitest'
import schema from '../../../convex/schema'
import { ConvexCloudBackend } from '../convexClient'
import { blankProject, placements } from './harness'
import { snapshotUploadFor, transactionChecksum } from '../serialize'
import type { AppendTransactionArgs, CloudResult } from '../protocol'

const modules = import.meta.glob('../../../convex/**/*.{ts,js}')
const batchRef = makeFunctionReference<'mutation'>('transactions:appendBatch')
const value = <T>(result: CloudResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
async function setup(count = 3) {
  const deployment = convexTest(schema, modules)
  const t = deployment.withIdentity({ subject: 'alice', tokenIdentifier: 'hexclave|alice' })
  const backend = new ConvexCloudBackend(t as unknown as ConstructorParameters<typeof ConvexCloudBackend>[0])
  const base = blankProject('batched-sync')
  const project = value(
    await backend.createProject({
      localProjectId: base.id,
      name: base.name,
      schemaVersion: base.schemaVersion,
      catalogVersion: base.catalogVersion,
      snapshot: snapshotUploadFor(base),
    }),
  )
  const history = placements(
    base,
    Array.from({ length: count }, (_, i) => `part_${i}`),
  )
  const transactions = history.transactions.map((transaction) => ({
    clientTransactionId: transaction.id,
    baseRevision: transaction.baseRevision,
    resultRevision: transaction.resultRevision,
    transaction,
    checksum: transactionChecksum(transaction),
    schemaVersion: base.schemaVersion,
    catalogVersion: base.catalogVersion,
  }))
  const args = { projectId: project.projectId, branchId: project.defaultBranchId, transactions }
  const appendOne = (transaction: (typeof transactions)[number]) =>
    backend.appendTransaction({
      projectId: project.projectId,
      branchId: project.defaultBranchId,
      ...transaction,
    } as AppendTransactionArgs)
  const counts = () =>
    t.run(async (ctx) => ({
      transactions: (await ctx.db.query('transactions').collect()).length,
      audits: (await ctx.db.query('auditEvents').collect()).length,
    }))
  return { deployment, t, backend, base, project, history, transactions, args, appendOne, counts }
}

describe('atomic cloud transaction batches (real Convex functions)', () => {
  it('stores an ordered history in one mutation and acknowledges each original edit', async () => {
    const h = await setup()
    const result = await h.t.mutation(batchRef, h.args)
    expect(result).toMatchObject({
      ok: true,
      value: {
        headRevision: 3,
        transactions: h.transactions.map((entry) => ({
          clientTransactionId: entry.clientTransactionId,
          resultRevision: entry.resultRevision,
          applied: true,
        })),
      },
    })
  })
})
