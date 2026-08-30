/** Provider submission is server-only; shared state lives in invitationLifecycle. */
export const INVITATION_DELIVERY_TIMEOUT_MS = 10_000

export type DeliveryResult = {
  status: 'queued' | 'failed' | 'not-configured'
  reason: string
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  )

/** URL validation prevents accidental credential forwarding and broken links. */
function trustedUrl(value: string | undefined, originOnly = false): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.hash
    )
      return null
    if (originOnly && (url.pathname !== '/' || url.search)) return null
    return url
  } catch {
    return null
  }
}

/** One bounded provider submission. Acceptance is not proof of inbox delivery.
 * No automatic retry after ambiguous I/O: the owner decides whether to resend. */
export async function sendInvitationEmail(args: {
  endpoint?: string
  credential?: string
  hexclaveProjectId?: string
  hexclaveSecretServerKey?: string
  hexclaveApiOrigin?: string
  origin?: string
  invitationId: string
  generation: number
  email: string
  token: string
  role: string
  projectName: string
}): Promise<DeliveryResult> {
  const origin = trustedUrl(args.origin, true)
  if (!origin) {
    return {
      status: 'not-configured',
      reason: 'Email delivery needs a valid INVITATION_LINK_ORIGIN on this deployment.',
    }
  }
  const invitationUrl = `${origin.origin}/invite/${encodeURIComponent(args.token)}`
  const subject = 'You have been invited to a Brickwright project'
  const customEndpoint = Boolean(args.endpoint || args.credential)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': `brickwrite-invite:${args.invitationId}:${args.generation}`,
  }
  let endpoint: URL | null
  let body: Record<string, unknown>
  if (customEndpoint) {
    endpoint = trustedUrl(args.endpoint)
    if (!endpoint || !args.credential?.trim())
      return {
        status: 'not-configured',
        reason: 'The custom email adapter needs a valid INVITATION_EMAIL_ENDPOINT and INVITATION_EMAIL_TOKEN.',
      }
    headers.authorization = `Bearer ${args.credential}`
    body = { to: args.email, subject, projectName: args.projectName, role: args.role, invitationUrl }
  } else {
    const apiOrigin = trustedUrl(args.hexclaveApiOrigin ?? 'https://api.hexclave.com', true)
    if (!apiOrigin || !args.hexclaveProjectId?.trim() || !args.hexclaveSecretServerKey?.trim())
      return {
        status: 'not-configured',
        reason:
          'Email delivery needs HEXCLAVE_PROJECT_ID and HEXCLAVE_SECRET_SERVER_KEY on this deployment and a valid Hexclave API origin.',
      }
    // Matches @hexclave/js 1.0.108 sendEmail({ emails, html, subject, themeId }).
    // Use its REST contract directly: the SDK automatically retries network
    // errors and does not expose the abort/deadline needed for a single attempt.
    // Arbitrary-address transactional recipients do not require user accounts.
    endpoint = new URL('/api/v1/emails/send-email', apiOrigin)
    headers['x-hexclave-project-id'] = args.hexclaveProjectId
    headers['x-hexclave-access-type'] = 'server'
    headers['x-hexclave-secret-server-key'] = args.hexclaveSecretServerKey
    body = {
      emails: [args.email],
      subject,
      theme_id: false,
      html: `<h1>You are invited to collaborate</h1><p>You have been invited to <strong>${escapeHtml(args.projectName)}</strong> with the ${escapeHtml(args.role)} role.</p><p><a href="${escapeHtml(invitationUrl)}">Accept your Brickwright invitation</a></p><p>Sign in to accept. This private link expires 14 days after the invitation was created. If you were not expecting this invitation, you can ignore this email.</p>`,
    }
  }
  const provider = customEndpoint ? 'The email endpoint' : 'Hexclave'
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Delivery timeout'))
    }, INVITATION_DELIVERY_TIMEOUT_MS)
  })
  try {
    const response = await Promise.race([
      fetch(endpoint.href, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers,
        body: JSON.stringify(body),
      }),
      deadline,
    ])
    // Never store or render a provider response body: it may include secrets.
    void response.body?.cancel().catch(() => {})
    // Hexclave may wrap an error in HTTP 200 for browser transports. Respect
    // both current and legacy status/error headers, without exposing their text.
    const wrappedStatus = customEndpoint
      ? null
      : (response.headers.get('x-hexclave-actual-status') ?? response.headers.get('x-stack-actual-status'))
    const status = wrappedStatus === null ? response.status : Number(wrappedStatus)
    const knownError =
      !customEndpoint && (response.headers.has('x-hexclave-known-error') || response.headers.has('x-stack-known-error'))
    return response.ok && Number.isInteger(status) && status >= 200 && status < 300 && !knownError
      ? { status: 'queued', reason: `${provider} accepted the invitation. Inbox delivery is not confirmed.` }
      : {
          status: 'failed',
          reason: `${provider} did not accept the invitation (HTTP ${Number.isInteger(status) && status >= 100 && status <= 599 ? status : response.status}). Check the email configuration. Delivery is not confirmed; retrying may send another message.`,
        }
  } catch {
    // Do not propagate arbitrary network errors containing endpoint credentials,
    // tokens, payloads or provider response text into owner-visible metadata.
    return {
      status: 'failed',
      reason: 'The email request failed or timed out. Delivery is not confirmed; retrying may send another message.',
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
