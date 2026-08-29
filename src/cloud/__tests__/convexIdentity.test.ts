import { describe, expect, it } from 'vitest'
import { identityFromClaims } from '../../../convex/model/identity'

describe('Convex identity claims', () => {
  it('accepts a named, unrestricted principal', () => {
    expect(
      identityFromClaims({
        tokenIdentifier: 'https://api.hexclave.com/api/v1/projects/p|user_1',
        subject: 'user_1',
        issuer: 'https://api.hexclave.com/api/v1/projects/p',
        name: 'Ada',
        is_anonymous: false,
        is_restricted: false,
      }),
    ).toEqual({ subject: 'https://api.hexclave.com/api/v1/projects/p|user_1', displayName: 'Ada' })
  })

  it('refuses anonymous and restricted tokens the paid API also refuses', () => {
    expect(identityFromClaims({ subject: 'anon', is_anonymous: true })).toBeNull()
    expect(identityFromClaims({ subject: 'user', is_restricted: true })).toBeNull()
    expect(
      identityFromClaims({
        subject: 'anon',
        issuer: 'https://api.hexclave.com/api/v1/projects-anonymous-users/p',
      }),
    ).toBeNull()
  })

  it('refuses a token with no subject', () => {
    expect(identityFromClaims({ issuer: 'https://api.hexclave.com/api/v1/projects/p' })).toBeNull()
  })
})
