import { cadEngine } from '../../cad/engine'
import { session } from '../../cad/session'
import { ContractError } from '../contract'
import { discardReview, registerSurfaceDisposer, surfaceSnapshot } from '../surfaceSnapshot'
import type { Publication } from '../../features/share/types'
import { assertProjectSwitch } from './projects'

let last: Publication | null = null
let disposeRegistered = false

function ensureDispose() {
  if (disposeRegistered) return
  disposeRegistered = true
  registerSurfaceDisposer(() => {
    last = null
    disposeRegistered = false
  })
}

const compactPublication = (publication: Publication) => ({
  slug: publication.slug,
  id: publication.id,
  title: publication.title,
  visibility: publication.visibility,
  capabilities: publication.capabilities,
  revision: publication.revision,
  contentHash: publication.contentHash,
  publishedAt: publication.publishedAt,
  summary: {
    partCount: publication.summary.partCount,
    uniquePartCount: publication.summary.uniquePartCount,
    stepCount: publication.summary.stepCount,
    envelopeStuds: publication.summary.envelopeStuds,
    validation: publication.summary.validation,
  },
})

export async function prepareShare(input: { title?: string; description?: string; tags?: string[] }) {
  const { createPublication } = await import('../../features/share/publish')
  const snapshot = cadEngine.getSnapshot()
  let publication: Publication
  try {
    publication = await createPublication({
      document: snapshot.document,
      validation: snapshot.validation,
      title: input.title,
      description: input.description,
      tags: input.tags,
    })
  } catch (cause) {
    const { ShareError } = await import('../../features/share/types')
    if (cause instanceof ShareError) {
      throw new ContractError('INVALID_INPUT', cause.message, 'Fix the document or the share arguments and retry.')
    }
    throw cause
  }
  last = publication
  ensureDispose()
  surfaceSnapshot.share = { slug: publication.slug, contentHash: publication.contentHash }
  return compactPublication(publication)
}

export function peekPreparedPublication(): Publication | null {
  return last
}

export async function forkShareToProject(name?: string) {
  if (!last) {
    throw new ContractError(
      'INVALID_INPUT',
      'No publication has been prepared in this session.',
      'Call share_prepare first.',
    )
  }
  const { forkPublication } = await import('../../features/share/fork')
  discardReview()
  const forked = forkPublication(last, { name })
  const result = await session.importDocument(forked.document)
  assertProjectSwitch(result)
  return {
    projectId: session.currentProjectId,
    documentRevision: cadEngine.getDocument().revision,
    partCount: Object.keys(cadEngine.getDocument().parts).length,
    provenance: forked.provenance,
    sourceSlug: last.slug,
  }
}

export function clearPreparedShare() {
  last = null
  surfaceSnapshot.share = { slug: null, contentHash: null }
}
