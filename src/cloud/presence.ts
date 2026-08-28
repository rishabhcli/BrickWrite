import type { ModelDocument } from '../cad/types'
import {
  PRESENCE_TTL_MS,
  type CloudBackend,
  type CloudPresenceRecord,
  type CloudResult,
} from './protocol'

/**
 * Live presence and follow-mode.
 *
 * Presence is the one thing in this workstream that is allowed to be lost.
 * Nothing here writes to the document, queues an outbox entry, or advances a
 * revision, and nothing downstream may treat a presence record as model truth:
 * a cursor is a hint about where somebody is looking, and a dropped heartbeat
 * costs an avatar rather than an edit.
 *
 * That is enforced structurally rather than by convention — this module takes a
 * `CloudBackend`, not a `ProjectStore`, so it has no method that could write a
 * transaction even by accident. It reads `ModelDocument.revision` to say which
 * revision a peer is viewing, and never writes back.
 */

export interface PresencePeer {
  subject: string
  sessionId: string
  displayName: string | null
  color: string
  /** The revision that peer is viewing. Advisory: it never drives a load. */
  revision: number
  selection: string[]
  cursorLdu?: { x: number; y: number; z: number }
  cameraTargetLdu?: { x: number; y: number; z: number }
  followingSubject: string | null
  /** True when their revision differs from the reader's. */
  behind: boolean
  ahead: boolean
  updatedAt: string
}

export interface PresenceView {
  peers: PresencePeer[]
  /** Peers currently following the reader, so the UI can say "2 following you". */
  followers: PresencePeer[]
  /** The peer the reader is following, when they picked one and it is live. */
  following: PresencePeer | null
}

const isLive = (record: CloudPresenceRecord, at: number) =>
  Date.parse(record.expiresAt) > at

/**
 * Turns raw presence rows into what a viewport needs.
 *
 * Expired rows are dropped here as well as on the server, because a reader that
 * has been offline holds a list the server has already stopped returning, and
 * showing a ghost cursor is worse than showing none.
 */
export function presenceView(args: {
  records: readonly CloudPresenceRecord[]
  selfSubject: string
  selfSessionId?: string
  documentRevision: number
  followingSubject?: string | null
  now?: number
}): PresenceView {
  const at = args.now ?? Date.now()
  const peers = args.records
    .filter((record) => isLive(record, at))
    .filter((record) =>
      args.selfSessionId ? record.sessionId !== args.selfSessionId : record.subject !== args.selfSubject,
    )
    .map<PresencePeer>((record) => ({
      subject: record.subject,
      sessionId: record.sessionId,
      displayName: record.displayName ?? null,
      color: record.color,
      revision: record.revision,
      selection: record.selection,
      cursorLdu: record.cursorLdu,
      cameraTargetLdu: record.cameraTargetLdu,
      followingSubject: record.followingSubject ?? null,
      behind: record.revision < args.documentRevision,
      ahead: record.revision > args.documentRevision,
      updatedAt: record.updatedAt,
    }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))

  return {
    peers,
    followers: peers.filter((peer) => peer.followingSubject === args.selfSubject),
    following: args.followingSubject
      ? (peers.find((peer) => peer.subject === args.followingSubject) ?? null)
      : null,
  }
}

export interface PresenceSessionOptions {
  /** One per browser tab. Two tabs are two sessions of the same subject. */
  sessionId: string
  now?: () => number
  /** Heartbeats closer together than this are coalesced. */
  minIntervalMs?: number
}

/**
 * One tab's presence publisher.
 *
 * Coalesces heartbeats and drops the ones that would say nothing new, because a
 * cursor moving 400 times a second is not 400 facts. There is no timer inside:
 * `publish` is called by whoever owns the pointer events, and `heartbeat` by
 * whoever owns the keepalive, so the class stays synchronous to reason about.
 */
export class PresenceSession {
  private lastSentAt = 0
  private lastPayload = ''
  private followingSubject: string | null = null
  private readonly now: () => number
  private readonly minIntervalMs: number

  constructor(
    private readonly backend: CloudBackend,
    private readonly projectId: string,
    private readonly options: PresenceSessionOptions,
  ) {
    this.now = options.now ?? (() => Date.now())
    this.minIntervalMs = options.minIntervalMs ?? PRESENCE_TTL_MS / 6
  }

  get sessionId(): string {
    return this.options.sessionId
  }

  get following(): string | null {
    return this.followingSubject
  }

  /** Follow-mode is local state until the next heartbeat carries it. */
  follow(subject: string | null): void {
    this.followingSubject = subject
  }

  /**
   * Publishes this tab's view of the document.
   *
   * Takes the document only to read its revision and never returns it, so no
   * call site can mistake this for a save.
   */
  async publish(args: {
    document: ModelDocument
    selection: readonly string[]
    cursorLdu?: { x: number; y: number; z: number }
    cameraTargetLdu?: { x: number; y: number; z: number }
    force?: boolean
  }): Promise<CloudResult<CloudPresenceRecord> | null> {
    const payload = {
      projectId: this.projectId,
      sessionId: this.options.sessionId,
      revision: args.document.revision,
      selection: [...args.selection],
      cursorLdu: args.cursorLdu,
      cameraTargetLdu: args.cameraTargetLdu,
      followingSubject: this.followingSubject ?? undefined,
    }
    const fingerprint = JSON.stringify(payload)
    const at = this.now()
    if (!args.force && fingerprint === this.lastPayload && at - this.lastSentAt < this.minIntervalMs) {
      return null
    }
    this.lastPayload = fingerprint
    this.lastSentAt = at
    return this.backend.presenceHeartbeat(payload)
  }

  peers(): Promise<CloudResult<CloudPresenceRecord[]>> {
    return this.backend.listPresence({ projectId: this.projectId })
  }

  leave(): Promise<CloudResult<{ left: boolean }>> {
    return this.backend.presenceLeave({
      projectId: this.projectId,
      sessionId: this.options.sessionId,
    })
  }
}
