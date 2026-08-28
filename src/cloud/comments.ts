import type { ModelDocument } from '../cad/types'
import type { CloudCommentRecord, CommentAnchor } from './protocol'
import { poseChecksumOf } from './serialize'

/**
 * Revision-anchored spatial comments, resolved against the open document.
 *
 * A comment is pinned to a part id, the revision it was pinned at, and a
 * checksum of that part's pose at the time. Those three facts are stored once
 * and never rewritten, which is what makes a comment survive later edits: the
 * server is not trying to keep the anchor current, so it cannot get it wrong.
 *
 * The interesting question — "is this note still about what it was about?" —
 * can only be answered where the document is, so it is answered here. Three
 * outcomes, and the middle one is the point of the whole design:
 *
 *   intact   the part is there and has not moved since the comment was made
 *   moved    the part is there but its pose or colour changed after revision N
 *   removed  the part is gone
 *
 * A `moved` anchor is still shown, at the part's current position, labelled as
 * moved. Silently retargeting it would make a review comment point confidently
 * at something nobody wrote it about.
 */

export type AnchorState = 'intact' | 'moved' | 'removed'

export interface AnchorReport {
  commentId: string
  partId: string
  state: AnchorState
  /** The revision the comment was pinned at. */
  anchoredAtRevision: number
  /** The revision it is being resolved against. */
  documentRevision: number
  /** True when the document has advanced past the anchor revision. */
  documentAdvanced: boolean
  /** Present while the part exists. */
  currentPoseChecksum?: string
  anchorPoseChecksum: string
  /** What to tell the reader, in one sentence. */
  explanation: string
}

/**
 * Builds an anchor for a part in the document as it stands.
 *
 * Returns null for a part that is not in the document: an anchor to a part that
 * does not exist is not a comment anybody can act on, and creating one would
 * put a permanently broken pin in the model.
 */
export function anchorFor(
  document: ModelDocument,
  partId: string,
  pointLdu?: { x: number; y: number; z: number },
): CommentAnchor | null {
  const part = document.parts[partId]
  if (!part) return null
  return {
    partId,
    revision: document.revision,
    poseChecksum: poseChecksumOf(part),
    pointLdu,
  }
}

export function resolveAnchor(
  document: ModelDocument,
  comment: Pick<CloudCommentRecord, 'commentId' | 'anchor'>,
): AnchorReport {
  const part = document.parts[comment.anchor.partId]
  const base = {
    commentId: comment.commentId,
    partId: comment.anchor.partId,
    anchoredAtRevision: comment.anchor.revision,
    documentRevision: document.revision,
    documentAdvanced: document.revision > comment.anchor.revision,
    anchorPoseChecksum: comment.anchor.poseChecksum,
  }

  if (!part) {
    return {
      ...base,
      state: 'removed',
      explanation: `The part this note was about was removed after revision ${comment.anchor.revision}.`,
    }
  }
  const currentPoseChecksum = poseChecksumOf(part)
  if (currentPoseChecksum === comment.anchor.poseChecksum) {
    return {
      ...base,
      state: 'intact',
      currentPoseChecksum,
      explanation: 'The part this note is about has not changed since the note was written.',
    }
  }
  return {
    ...base,
    state: 'moved',
    currentPoseChecksum,
    explanation: `The part this note is about changed after revision ${comment.anchor.revision}; the note is shown at its current position.`,
  }
}

export function resolveAnchors(
  document: ModelDocument,
  comments: readonly CloudCommentRecord[],
): AnchorReport[] {
  return comments.map((comment) => resolveAnchor(document, comment))
}

export interface CommentThread {
  root: CloudCommentRecord
  replies: CloudCommentRecord[]
  anchor: AnchorReport
}

/** Groups a flat comment list into threads, oldest root first. */
export function threadsOf(
  document: ModelDocument,
  comments: readonly CloudCommentRecord[],
): CommentThread[] {
  const roots = comments.filter((comment) => !comment.replyToId)
  const repliesFor = new Map<string, CloudCommentRecord[]>()
  for (const comment of comments) {
    if (!comment.replyToId) continue
    const bucket = repliesFor.get(comment.replyToId) ?? []
    bucket.push(comment)
    repliesFor.set(comment.replyToId, bucket)
  }
  return roots.map((root) => ({
    root,
    replies: (repliesFor.get(root.commentId) ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
    anchor: resolveAnchor(document, root),
  }))
}

/** Counts by anchor state, for a "3 notes need re-pinning" badge. */
export function anchorSummary(reports: readonly AnchorReport[]): Record<AnchorState, number> {
  const summary: Record<AnchorState, number> = { intact: 0, moved: 0, removed: 0 }
  for (const report of reports) summary[report.state] += 1
  return summary
}
