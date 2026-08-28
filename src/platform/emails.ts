/**
 * Transactional email, defined on the client and sent only on a server.
 *
 * Brickwright's browser bundle must never be able to send mail. Sending needs
 * `HEXCLAVE_SECRET_SERVER_KEY`, and any module that reads that key is one
 * careless import away from being bundled into a public asset. So the split is
 * structural rather than conventional: this file holds the *content* — pure
 * functions from typed inputs to a subject and a body — and knows nothing about
 * transport, while everything that touches the key lives under
 * `src/platform/server/`, which no module here may import. `emails.test.ts`
 * enforces that, and `secret-scan.test.ts` enforces it again from the client
 * entry.
 *
 * Nothing here sends anything. Rendering a message and delivering it are
 * separate acts, and only the first one happens in this process.
 */

/** Where delivery lives. Named as data so the split is greppable. */
export const SERVER_EMAIL_MODULE = 'src/platform/server/emails.server.ts'

/**
 * Hexclave notification categories.
 *
 * Named so an operator can unsubscribe from build announcements without losing
 * the invitations that let them into a shared project.
 */
export type NotificationCategory = 'Transactional' | 'Marketing'

export interface ProjectInvitationEmail {
  kind: 'project-invitation'
  /** Display name of the project being shared. Rendered, never logged. */
  projectName: string
  /** Display name of whoever sent the invitation. */
  inviterName: string
  /** Absolute URL the recipient opens to accept. */
  acceptUrl: string
}

export interface PublicationNotificationEmail {
  kind: 'publication-notification'
  projectName: string
  /** Absolute URL of the published model. */
  shareUrl: string
  /** Whether this is a first publication or an update to an existing one. */
  change: 'published' | 'updated' | 'unpublished'
}

export type PlatformEmail = ProjectInvitationEmail | PublicationNotificationEmail

export interface RenderedEmail {
  subject: string
  html: string
  notificationCategoryName: NotificationCategory
}

/** Minimal, deliberate escaping: these bodies carry operator-supplied names. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function layout(headline: string, body: string, cta: { href: string; label: string }): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;color:#1a1f21">',
    `<h1 style="font-size:19px;margin:0 0 12px">${headline}</h1>`,
    body,
    `<p style="margin:24px 0 0"><a href="${escapeHtml(cta.href)}" style="background:#f5a33f;color:#12181a;padding:10px 18px;border-radius:4px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>`,
    '<p style="margin:28px 0 0;font-size:12px;color:#68767a">Sent by Brickwright, an LDraw CAD application.</p>',
    '</div>',
  ].join('')
}

const PUBLICATION_HEADLINE: Record<PublicationNotificationEmail['change'], string> = {
  published: 'Your model is published',
  updated: 'Your published model was updated',
  unpublished: 'Your model is no longer published',
}

/** Turn a typed message into a subject and a body. Pure; no I/O, no secrets. */
export function renderPlatformEmail(email: PlatformEmail): RenderedEmail {
  switch (email.kind) {
    case 'project-invitation':
      return {
        subject: `${email.inviterName} shared "${email.projectName}" with you`,
        notificationCategoryName: 'Transactional',
        html: layout(
          `${escapeHtml(email.inviterName)} shared a Brickwright project with you`,
          `<p>You have been invited to <strong>${escapeHtml(email.projectName)}</strong>. Opening the invitation adds the project to your account.</p>`,
          { href: email.acceptUrl, label: 'Open the project' },
        ),
      }
    case 'publication-notification':
      return {
        subject: `${PUBLICATION_HEADLINE[email.change]}: ${email.projectName}`,
        notificationCategoryName: 'Transactional',
        html: layout(
          PUBLICATION_HEADLINE[email.change],
          `<p><strong>${escapeHtml(email.projectName)}</strong> ${
            email.change === 'unpublished'
              ? 'is no longer reachable at its share link.'
              : 'is live. Anyone with the link can view the model and its part list.'
          }</p>`,
          { href: email.shareUrl, label: email.change === 'unpublished' ? 'Open the project' : 'View the model' },
        ),
      }
  }
}

/**
 * Recipients, kept separate from content.
 *
 * `userIds` is preferred over raw addresses wherever Hexclave already knows the
 * user, so notification preferences and unsubscribes are honoured by the
 * platform rather than reimplemented here.
 */
export type EmailRecipients = { userIds: string[] } | { emails: string[] }

export interface PlatformEmailRequest {
  email: PlatformEmail
  recipients: EmailRecipients
}
