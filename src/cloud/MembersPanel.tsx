import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { Eye, MailPlus, Shield, UserMinus, Users } from 'lucide-react'
import { useCloudSync } from './CloudSyncProvider'
import { refusalReason, roleAllows } from './permissions'
import type {
  CloudErrorShape,
  CloudInvitationRecord,
  CloudMemberRecord,
  CloudRole,
  ProjectVisibility,
} from './protocol'
import type { ProjectLink } from './projectStore'
import { canReachCloud } from './runtime'
import { formatWhen, noticeFor, type CloudWorkbenchApi, type SurfaceNotice } from './surface'
import './cloud.css'

const ASSIGNABLE_ROLES: ReadonlyArray<Exclude<CloudRole, 'owner'>> = [
  'editor',
  'commenter',
  'viewer',
]

const ROLE_RANK: Readonly<Record<CloudRole, number>> = {
  owner: 4,
  editor: 3,
  commenter: 2,
  viewer: 1,
}

/** Collaborator access for the open, live project (not public snapshot sharing). */
export function CloudMembersPanel({ api }: { api: CloudWorkbenchApi }) {
  const { snapshot } = useCloudSync()
  const { configuration, identity, store, links } = snapshot
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

  if (configuration.status === 'unconfigured') {
    return (
      <div className="bw-cloud bw-cloud-members" data-testid="cloud-members-panel">
        <EmptyReason
          title="Collaboration needs a cloud deployment"
          detail={configuration.reason ?? 'No cloud deployment is configured.'}
          extra="The model and its complete transaction history remain available in this browser."
        />
      </div>
    )
  }
  if (!canReachCloud(identity)) {
    return (
      <div className="bw-cloud bw-cloud-members" data-testid="cloud-members-panel">
        <EmptyReason
          title="Sign in to share this project"
          detail={identity.reason ?? 'You are not signed in.'}
          extra="Local editing is unaffected while signed out."
        />
      </div>
    )
  }
  if (link === undefined) {
    return (
      <div className="bw-cloud bw-cloud-members" data-testid="cloud-members-panel">
        <p className="bw-cloud-empty" role="status">Checking collaboration access…</p>
      </div>
    )
  }
  if (link === null || !store) {
    return (
      <div className="bw-cloud bw-cloud-members" data-testid="cloud-members-panel">
        <EmptyReason
          title="Save this project to the cloud first"
          detail="Collaborator roles apply to a live cloud project, and this document has no replica yet."
          extra="Use Save to cloud in Projects. The local copy remains authoritative."
        />
      </div>
    )
  }

  return <ClaimedMembers api={api} link={link} />
}

function ClaimedMembers({ api, link }: { api: CloudWorkbenchApi; link: ProjectLink }) {
  const { snapshot } = useCloudSync()
  const store = snapshot.store!
  const backend = snapshot.backend!
  const documentId = api.snapshot.document.id
  const selfSubject = 'userId' in snapshot.identity ? snapshot.identity.userId : ''

  const [members, setMembers] = useState<CloudMemberRecord[] | null>(null)
  const [invitations, setInvitations] = useState<CloudInvitationRecord[] | null>(null)
  const [role, setRole] = useState<CloudRole | null | undefined>(undefined)
  const [visibility, setVisibility] = useState<ProjectVisibility | null>(null)
  const [errors, setErrors] = useState<CloudErrorShape[]>([])
  const [notice, setNotice] = useState<SurfaceNotice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [nonce, refresh] = useReducer((value: number) => value + 1, 0)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Exclude<CloudRole, 'owner'>>('editor')
  const [confirmRole, setConfirmRole] = useState<{
    member: CloudMemberRecord
    role: Exclude<CloudRole, 'owner'>
  } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<CloudMemberRecord | null>(null)

  useEffect(() => {
    let live = true
    setErrors([])
    void Promise.all([
      store.listMembers(documentId),
      store.myRole(documentId),
      backend.getProject({ projectId: link.cloudProjectId }),
    ]).then(async ([memberResult, roleResult, projectResult]) => {
      if (!live) return
      const failures: CloudErrorShape[] = []
      if (memberResult.ok) setMembers(memberResult.value)
      else {
        setMembers([])
        failures.push(memberResult.error)
      }
      if (roleResult.ok) setRole(roleResult.value)
      else {
        setRole(null)
        failures.push(roleResult.error)
      }
      if (projectResult.ok) setVisibility(projectResult.value.visibility)
      else failures.push(projectResult.error)

      // Invitation addresses are owner-only. Do not manufacture a FORBIDDEN
      // round trip merely to discover what the shared capability matrix says.
      if (roleResult.ok && roleAllows(roleResult.value, 'member.invite')) {
        const invitationResult = await store.listInvitations(documentId)
        if (!live) return
        if (invitationResult.ok) setInvitations(invitationResult.value)
        else {
          setInvitations([])
          failures.push(invitationResult.error)
        }
      } else {
        setInvitations([])
      }
      setErrors(failures)
    })
    return () => {
      live = false
    }
  }, [backend, documentId, link.cloudProjectId, nonce, store])

  const run = useCallback(
    async (key: string, work: () => Promise<SurfaceNotice | null>) => {
      setBusy(key)
      setNotice(null)
      try {
        const result = await work()
        if (result) setNotice(result)
      } catch (cause: unknown) {
        setNotice({
          tone: 'error',
          title: 'That did not complete',
          detail: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        setBusy(null)
        refresh()
      }
    },
    [],
  )

  const inviteRefusal = refusalReason(role, 'member.invite')
  const visibilityRefusal = refusalReason(role, 'project.delete')

  const invite = () =>
    run('invite', async () => {
      const result = await store.createInvitation(documentId, email, inviteRole)
      if (!result.ok) return noticeFor(result.error, 'Invitation not created')
      setEmail('')
      return {
        tone: result.value.deliveryStatus === 'sent' ? 'neutral' : 'warn',
        title: `Invited ${result.value.email}`,
        detail:
          result.value.deliveryStatus === 'sent'
            ? `The ${result.value.role} invitation was sent.`
            : result.value.deliveryReason ??
              `Delivery is ${result.value.deliveryStatus}; the invitation remains available to revoke.`,
      }
    })

  const applyRole = (member: CloudMemberRecord, next: Exclude<CloudRole, 'owner'>) =>
    run(`role:${member.subject}`, async () => {
      setConfirmRole(null)
      const result = await store.setMemberRole(documentId, member.subject, next)
      return result.ok
        ? {
            tone: 'warn',
            title: `${member.displayName ?? member.subject} is now ${next}`,
            detail:
              ROLE_RANK[next] < ROLE_RANK[member.role]
                ? 'They cannot sync edits their new role does not permit; their local work remains in their browser.'
                : 'The new capability set applies to their next cloud request.',
          }
        : noticeFor(result.error, 'Role not changed')
    })

  const requestRole = (member: CloudMemberRecord, next: Exclude<CloudRole, 'owner'>) => {
    if (next === member.role) return
    if (ROLE_RANK[next] < ROLE_RANK[member.role]) setConfirmRole({ member, role: next })
    else void applyRole(member, next)
  }

  const remove = (member: CloudMemberRecord) =>
    run(`remove:${member.subject}`, async () => {
      setConfirmRemove(null)
      const result = await store.removeMember(documentId, member.subject)
      return result.ok
        ? {
            tone: 'warn',
            title: member.subject === selfSubject ? 'You left the project' : 'Collaborator removed',
            detail: result.value.removed
              ? 'Their live presence was removed immediately. Unsynced work remains in their browser.'
              : 'That collaborator was already absent.',
          }
        : noticeFor(result.error, 'Collaborator not removed')
    })

  const revoke = (invitation: CloudInvitationRecord) =>
    run(`invite:${invitation.invitationId}`, async () => {
      const result = await store.revokeInvitation(documentId, invitation.invitationId)
      return result.ok
        ? {
            tone: 'neutral',
            title: result.value.revoked ? 'Invitation revoked' : 'Invitation already resolved',
            detail: result.value.revoked
              ? `${invitation.email} can no longer use that link.`
              : 'No access was changed.',
          }
        : noticeFor(result.error, 'Invitation not revoked')
    })

  const changeVisibility = (next: ProjectVisibility) =>
    run('visibility', async () => {
      const result = await store.setVisibility(documentId, next)
      if (!result.ok) return noticeFor(result.error, 'Visibility not changed')
      setVisibility(result.value.visibility)
      return {
        tone: next === 'public' ? 'warn' : 'neutral',
        title: `Project is ${next}`,
        detail:
          next === 'public'
            ? 'Signed-in non-members may read the model, but rosters and presence remain member-only.'
            : next === 'unlisted'
              ? 'Only explicit collaborators can open this live project; the URL is not a membership credential.'
              : 'Only explicit collaborators can open this project.',
      }
    })

  const sortedMembers = useMemo(
    () =>
      [...(members ?? [])].sort(
        (a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
          (a.displayName ?? a.subject).localeCompare(b.displayName ?? b.subject),
      ),
    [members],
  )

  if (members === null || role === undefined || invitations === null) {
    return <p className="bw-cloud-empty" role="status">Reading collaborators and invitations…</p>
  }

  return (
    <div className="bw-cloud bw-cloud-members" data-testid="cloud-members-panel">
      {errors.map((error, index) => (
        <div className="bw-cloud-notice" data-tone="error" role="alert" key={`${error.code}:${index}`}>
          <strong>Part of collaboration could not be read</strong>
          <p>{error.message} {error.repair}</p>
        </div>
      ))}
      {notice && (
        <div className="bw-cloud-notice" data-tone={notice.tone} role="status">
          <strong>{notice.title}</strong>
          <p>{notice.detail}</p>
        </div>
      )}

      <section className="bw-cloud-sharing-section" aria-label="Project access">
        <span className="bw-cloud-eyebrow"><Eye size={11} aria-hidden="true" /> Access</span>
        <label className="bw-cloud-label" htmlFor="cloud-visibility">Live project visibility</label>
        <select
          id="cloud-visibility"
          className="bw-cloud-select"
          value={visibility ?? 'private'}
          disabled={busy !== null || Boolean(visibilityRefusal)}
          title={visibilityRefusal ?? undefined}
          onChange={(event) => void changeVisibility(event.target.value as ProjectVisibility)}
        >
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public read-only</option>
        </select>
        {visibilityRefusal && <span className="bw-cloud-project-meta">{visibilityRefusal}</span>}
      </section>

      <section className="bw-cloud-sharing-section" aria-label="Invite collaborator">
        <span className="bw-cloud-eyebrow"><MailPlus size={11} aria-hidden="true" /> Invite</span>
        <div className="bw-cloud-inline-form bw-cloud-inline-form--wrap">
          <input
            className="bw-cloud-field"
            type="email"
            aria-label="Collaborator email"
            placeholder="builder@example.com"
            value={email}
            disabled={busy === 'invite' || Boolean(inviteRefusal)}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && email.trim() && !inviteRefusal) void invite()
            }}
          />
          <select
            className="bw-cloud-select"
            aria-label="Invitation role"
            value={inviteRole}
            disabled={busy === 'invite' || Boolean(inviteRefusal)}
            onChange={(event) => setInviteRole(event.target.value as Exclude<CloudRole, 'owner'>)}
          >
            {ASSIGNABLE_ROLES.map((candidate) => <option value={candidate} key={candidate}>{candidate}</option>)}
          </select>
          <button
            type="button"
            className="bw-cloud-btn"
            data-variant="primary"
            disabled={busy === 'invite' || !email.trim() || Boolean(inviteRefusal)}
            title={inviteRefusal ?? undefined}
            onClick={() => void invite()}
          >
            {busy === 'invite' ? 'Inviting…' : 'Invite'}
          </button>
        </div>
        {inviteRefusal ? (
          <span className="bw-cloud-project-meta">{inviteRefusal}</span>
        ) : (
          <span className="bw-cloud-project-meta">If this address already belongs to a member, accepting consumes the link without lowering their role.</span>
        )}
      </section>

      <section className="bw-cloud-sharing-section" aria-label="Project members">
        <span className="bw-cloud-eyebrow"><Users size={11} aria-hidden="true" /> Members · {members.length}</span>
        <ul className="bw-cloud-list" aria-label="Project members">
          {sortedMembers.map((member) => {
            const isOwner = member.role === 'owner'
            const isSelf = member.subject === selfSubject
            const roleRefusal = refusalReason(role, 'member.setRole')
            const removeRefusal = isSelf ? null : refusalReason(role, 'member.remove')
            const rowBusy = busy === `role:${member.subject}` || busy === `remove:${member.subject}`
            return (
              <li className="bw-cloud-member" key={member.memberId}>
                <div className="bw-cloud-project-head">
                  <span className="bw-cloud-project-name">{member.displayName ?? member.subject}</span>
                  <span className="bw-cloud-badge" data-origin="cloud"><Shield size={9} aria-hidden="true" /> {member.role}</span>
                </div>
                <span className="bw-cloud-project-meta">Added {formatWhen(member.addedAt)}{isSelf ? ' · you' : ''}</span>
                <div className="bw-cloud-actions">
                  {!isOwner && (
                    <select
                      className="bw-cloud-select"
                      aria-label={`Role for ${member.displayName ?? member.subject}`}
                      value={member.role}
                      disabled={rowBusy || Boolean(roleRefusal)}
                      title={roleRefusal ?? undefined}
                      onChange={(event) => requestRole(member, event.target.value as Exclude<CloudRole, 'owner'>)}
                    >
                      {ASSIGNABLE_ROLES.map((candidate) => <option value={candidate} key={candidate}>{candidate}</option>)}
                    </select>
                  )}
                  {!isOwner && !removeRefusal && (
                    <button type="button" className="bw-cloud-btn" data-variant="danger" disabled={rowBusy} onClick={() => setConfirmRemove(member)}>
                      <UserMinus size={10} aria-hidden="true" /> {isSelf ? 'Leave' : 'Remove'}
                    </button>
                  )}
                </div>
                {confirmRole?.member.memberId === member.memberId && (
                  <div className="bw-cloud-confirm" role="alertdialog" aria-label={`Confirm demoting ${member.displayName ?? member.subject}`}>
                    <strong>Change {member.displayName ?? member.subject} to {confirmRole.role}?</strong>
                    <p>They will not be able to save changes they have not yet synced if the new role refuses them.</p>
                    <div className="bw-cloud-actions">
                      <button type="button" className="bw-cloud-btn" data-variant="danger" onClick={() => void applyRole(member, confirmRole.role)}>Confirm role change</button>
                      <button type="button" className="bw-cloud-btn" onClick={() => setConfirmRole(null)}>Cancel</button>
                    </div>
                  </div>
                )}
                {confirmRemove?.memberId === member.memberId && (
                  <div className="bw-cloud-confirm" role="alertdialog" aria-label={`Confirm removing ${member.displayName ?? member.subject}`}>
                    <strong>{isSelf ? 'Leave this project?' : `Remove ${member.displayName ?? member.subject}?`}</strong>
                    <p>Unsynced edits stay in their browser, but their next cloud request will be refused.</p>
                    <div className="bw-cloud-actions">
                      <button type="button" className="bw-cloud-btn" data-variant="danger" onClick={() => void remove(member)}>{isSelf ? 'Leave project' : 'Remove collaborator'}</button>
                      <button type="button" className="bw-cloud-btn" onClick={() => setConfirmRemove(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {roleAllows(role, 'member.invite') && (
        <section className="bw-cloud-sharing-section" aria-label="Pending invitations">
          <span className="bw-cloud-eyebrow">Invitations · {invitations.length}</span>
          {invitations.length === 0 ? <p className="bw-cloud-empty">No invitations yet.</p> : (
            <ul className="bw-cloud-list" aria-label="Project invitations">
              {invitations.map((invitation) => {
                const expired = invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now()
                return (
                  <li className="bw-cloud-member" key={invitation.invitationId}>
                    <div className="bw-cloud-project-head">
                      <span className="bw-cloud-project-name">{invitation.email}</span>
                      <span className="bw-cloud-badge" data-origin={expired ? 'remote' : 'cloud'}>{expired ? 'expired' : invitation.status}</span>
                    </div>
                    <span className="bw-cloud-project-meta">{invitation.role} · expires {formatWhen(invitation.expiresAt)}</span>
                    <span className="bw-cloud-project-meta">Delivery: {invitation.deliveryStatus}{invitation.deliveryReason ? ` · ${invitation.deliveryReason}` : ''}</span>
                    {invitation.status === 'pending' && !expired && (
                      <div className="bw-cloud-actions">
                        <button type="button" className="bw-cloud-btn" data-variant="danger" disabled={busy === `invite:${invitation.invitationId}`} onClick={() => void revoke(invitation)}>Revoke</button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function EmptyReason({ title, detail, extra }: { title: string; detail: string; extra: string }) {
  return (
    <div className="bw-cloud-notice" data-tone="neutral" role="note">
      <strong>{title}</strong>
      <p>{detail}</p>
      <p>{extra}</p>
    </div>
  )
}
