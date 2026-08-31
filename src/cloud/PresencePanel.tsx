import { useEffect, useMemo, useRef, useState } from 'react'
import { Radio } from 'lucide-react'
import { useCloudSync } from './CloudSyncProvider'
import { PresenceSession, presenceView, type PresencePeer } from './presence'
import { PRESENCE_TTL_MS, type CloudPresenceRecord } from './protocol'
import type { ProjectLink } from './projectStore'
import { canReachCloud } from './runtime'
import { formatCount, type CloudWorkbenchApi } from './surface'
import './cloud.css'

/**
 * Who else is in this project, and what they are looking at.
 *
 * The reducer, the publisher and the Convex functions behind this were built
 * and tested some time ago; nothing rendered them, so two people editing the
 * same project could not see each other at all. This is the roster half of
 * that: names, the revision each peer is on, what they have selected, and a
 * follow toggle. Viewport cursors are the other half and belong to the
 * renderer, not here.
 *
 * Presence is allowed to be lost. Every failure below degrades to "nobody is
 * here" rather than to an error surface, because a dropped heartbeat costs an
 * avatar and must never look like a problem with the model. Nothing in this
 * file writes to the document.
 */
export function CloudPresencePanel({ api }: { api: CloudWorkbenchApi }) {
  const { snapshot } = useCloudSync()
  const { configuration, identity, links } = snapshot
  const documentId = api.snapshot.document.id
  const [link, setLink] = useState<ProjectLink | null | undefined>(undefined)

  useEffect(() => {
    let live = true
    setLink(undefined)
    void links.get(documentId).then((found) => {
      if (live) setLink(found ?? null)
    })
    return () => {
      live = false
    }
  }, [documentId, links, snapshot.linksVersion])

  if (configuration.status === 'unconfigured' || !canReachCloud(identity) || link === null) {
    // One quiet line for all three, deliberately. A signed-out solo builder is
    // not in an error state — they are simply the only person here, and the
    // Share panel is where the reasons and the repairs already live.
    return (
      <div className="bw-cloud bw-cloud-presence" data-testid="cloud-presence-panel">
        <p className="bw-cloud-empty" role="status">
          You are the only one here.
        </p>
      </div>
    )
  }
  if (link === undefined) {
    return (
      <div className="bw-cloud bw-cloud-presence" data-testid="cloud-presence-panel">
        <p className="bw-cloud-empty" role="status">Checking who is here…</p>
      </div>
    )
  }
  return <LivePresence api={api} link={link} />
}

/** How often a tab re-announces itself, well inside the server's expiry. */
const HEARTBEAT_MS = PRESENCE_TTL_MS / 3
/** How often the roster is re-read. Peers appear within one interval. */
const POLL_MS = 4_000

function LivePresence({ api, link }: { api: CloudWorkbenchApi; link: ProjectLink }) {
  const { snapshot } = useCloudSync()
  const backend = snapshot.backend!
  const selfSubject = 'userId' in snapshot.identity ? snapshot.identity.userId : ''
  const document = api.snapshot.document
  const selection = api.snapshot.selection

  const [roster, setRoster] = useState<Roster>(EMPTY_ROSTER)
  const [following, setFollowing] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  /**
   * One session per tab, for the life of the link.
   *
   * Keyed on the cloud project id rather than rebuilt per render: a new session
   * every render would announce a new participant every render, and the roster
   * would fill with ghosts of the same person.
   */
  const session = useMemo(
    () => new PresenceSession(backend, link.cloudProjectId, { sessionId: sessionIdFor(link.cloudProjectId) }),
    [backend, link.cloudProjectId],
  )

  // The latest document and selection, without making the publish effect
  // re-subscribe on every keystroke.
  const latest = useRef({ document, selection })
  latest.current = { document, selection }

  useEffect(() => {
    let live = true
    const announce = (force: boolean) => {
      const { document: current, selection: picked } = latest.current
      void session.publish({ document: current, selection: picked, force }).catch(() => {})
    }
    announce(true)
    const heartbeat = window.setInterval(() => announce(true), HEARTBEAT_MS)
    const poll = window.setInterval(() => {
      void session
        .peers()
        .then((result) => {
          if (live && result.ok) setRoster(rosterFrom(result.value))
        })
        .catch(() => {})
      // Re-render on the poll so `behind` and expiry are recomputed against a
      // fresh clock even when the roster itself has not changed.
      if (live) setTick((value) => value + 1)
    }, POLL_MS)
    void session
      .peers()
      .then((result) => {
        if (live && result.ok) setRoster(rosterFrom(result.value))
      })
      .catch(() => {})
    return () => {
      live = false
      window.clearInterval(heartbeat)
      window.clearInterval(poll)
      // Leaving is best effort: a closing tab that cannot reach the deployment
      // simply expires instead, which is what the TTL is for.
      void session.leave().catch(() => {})
    }
  }, [session])

  // A selection or a commit is new information, so it goes out immediately
  // rather than waiting for the next heartbeat. `publish` coalesces.
  useEffect(() => {
    void session.publish({ document, selection }).catch(() => {})
  }, [session, document, selection])

  const view = useMemo(
    () =>
      presenceView({
        records: roster.records,
        selfSubject,
        selfSessionId: session.sessionId,
        documentRevision: document.revision,
        followingSubject: following,
        now: serverNow(roster),
      }),
    // `tick` is a dependency without being read: expiry is a function of the
    // clock, so the roster has to be recomputed on the poll even when the
    // records themselves have not changed. Without it a peer who closed their
    // tab would sit in the list until something else re-rendered.
    [roster, selfSubject, session, document.revision, following, tick],
  )

  const toggleFollow = (peer: PresencePeer) => {
    const next = following === peer.subject ? null : peer.subject
    setFollowing(next)
    session.follow(next)
    void session.publish({ document, selection, force: true }).catch(() => {})
    if (next && peer.selection.length) api.select(peer.selection)
  }

  return (
    <div className="bw-cloud bw-cloud-presence" data-testid="cloud-presence-panel">
      <p className="bw-cloud-eyebrow">
        {view.peers.length ? formatCount(view.peers.length, 'other builder') : 'You are the only one here.'}
        {view.followers.length ? ` · ${formatCount(view.followers.length, 'follower')}` : ''}
      </p>
      {view.peers.length > 0 && (
        <ul className="bw-cloud-list">
          {view.peers.map((peer) => (
            <li
              key={peer.sessionId}
              className="bw-cloud-peer"
              data-following={following === peer.subject}
              data-testid="cloud-presence-peer"
            >
              <span className="bw-cloud-peer-dot" style={{ background: peer.color }} aria-hidden="true" />
              <span className="bw-cloud-peer-name">{peer.displayName ?? 'Someone'}</span>
              <span className="bw-cloud-peer-meta">{describeRevision(peer)}</span>
              <button
                type="button"
                className="bw-cloud-btn"
                aria-pressed={following === peer.subject}
                onClick={() => toggleFollow(peer)}
              >
                {following === peer.subject ? 'Following' : 'Follow'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="bw-cloud-note">
        <Radio size={10} aria-hidden="true" /> Presence is advisory. It never changes the model, and it is
        never what a save waits on.
      </p>
    </div>
  )
}

/**
 * A fetched roster, and enough to read its clock in the server's frame.
 *
 * `expiresAt` is stamped by the deployment, and the panel has to decide whether
 * it has passed. Comparing it to the browser's own `Date.now()` makes presence a
 * hostage to clock skew: a machine thirty seconds fast shows an empty room, and
 * one thirty seconds slow keeps ghosts of people who left. Browser clocks are
 * routinely off by more than the thirty-second TTL, so this is not a hypothetical.
 *
 * Instead, the newest `expiresAt` in a response fixes the server's own clock at
 * the moment it answered — every row it returned was live then, and the freshest
 * one was written at most a full TTL before. Local elapsed time advances that
 * estimate. Only *differences* in the browser's clock are trusted, which is the
 * one thing it is reliably good at.
 *
 * It errs low, so a peer lingers a moment rather than vanishing early. For a
 * roster that is the right direction to be wrong in.
 */
interface Roster {
  records: CloudPresenceRecord[]
  /** Server time when this response was produced, or null before the first. */
  serverAt: number | null
  clientAt: number
}

const EMPTY_ROSTER: Roster = { records: [], serverAt: null, clientAt: 0 }

function rosterFrom(records: CloudPresenceRecord[]): Roster {
  let newest = Number.NEGATIVE_INFINITY
  for (const record of records) {
    const at = Date.parse(record.expiresAt)
    if (Number.isFinite(at) && at > newest) newest = at
  }
  return {
    records,
    serverAt: Number.isFinite(newest) ? newest - PRESENCE_TTL_MS : null,
    clientAt: Date.now(),
  }
}

const serverNow = (roster: Roster): number =>
  roster.serverAt === null ? Date.now() : roster.serverAt + (Date.now() - roster.clientAt)

/**
 * What a peer's revision means for the reader.
 *
 * Stated as a relationship rather than a number, because the number alone
 * invites the wrong conclusion: a peer being "ahead" is not a conflict and does
 * not mean anything of yours is lost. It means their tab has seen commits yours
 * has not yet drained.
 */
function describeRevision(peer: PresencePeer): string {
  const picked = peer.selection.length ? `, ${formatCount(peer.selection.length, 'part')} selected` : ''
  if (peer.ahead) return `ahead of you${picked}`
  if (peer.behind) return `behind you${picked}`
  return `same revision${picked}`
}

/**
 * A stable id for this tab and project.
 *
 * Stored in `sessionStorage`, so a reload keeps the same identity instead of
 * leaving a ghost behind until the TTL clears it, while a second tab — a
 * genuinely separate viewpoint — gets its own. Falls back to a per-call id
 * where storage is unavailable, which costs a ghost on reload and nothing else.
 */
function sessionIdFor(cloudProjectId: string): string {
  const key = `bw.presence.${cloudProjectId}`
  const fresh = () => `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  try {
    const existing = window.sessionStorage.getItem(key)
    if (existing) return existing
    const created = fresh()
    window.sessionStorage.setItem(key, created)
    return created
  } catch {
    return fresh()
  }
}
