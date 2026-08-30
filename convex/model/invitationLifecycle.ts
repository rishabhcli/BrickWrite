/** Shared state policy. No provider code or server credentials belong here. */
export const INVITATION_RETRY_COOLDOWN_MS = 30_000
export const INVITATION_DELIVERY_LEASE_MS = 60_000

export type InvitationDeliveryStatus =
  'pending' | 'sending' | 'queued' | 'sent' | 'not-configured' | 'failed' | 'cancelled'

export function invitationRetryAt(row: {
  createdAt: number
  deliveryStatus: InvitationDeliveryStatus
  deliveryRequestedAt?: number
  deliveryStartedAt?: number
}): number {
  return row.deliveryStatus === 'sending'
    ? (row.deliveryStartedAt ?? row.deliveryRequestedAt ?? row.createdAt) + INVITATION_DELIVERY_LEASE_MS
    : (row.deliveryRequestedAt ?? row.createdAt) + INVITATION_RETRY_COOLDOWN_MS
}
