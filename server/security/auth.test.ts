import { describe, expect, it } from 'vitest'
import { authorizePaidRoute, type HexclaveRequestVerifier } from './auth'

const request = { headers: new Headers({ authorization: 'Bearer test' }) }

describe('paid route authorization', () => {
  it('fails closed when the server identity plane is absent', async () => {
    const previousProject = process.env.HEXCLAVE_PROJECT_ID
    const previousSecret = process.env.HEXCLAVE_SECRET_SERVER_KEY
    delete process.env.HEXCLAVE_PROJECT_ID
    delete process.env.HEXCLAVE_SECRET_SERVER_KEY
    try {
      await expect(authorizePaidRoute(request)).resolves.toMatchObject({
        ok: false,
        status: 503,
        code: 'auth_unavailable',
      })
    } finally {
      if (previousProject === undefined) delete process.env.HEXCLAVE_PROJECT_ID
      else process.env.HEXCLAVE_PROJECT_ID = previousProject
      if (previousSecret === undefined) delete process.env.HEXCLAVE_SECRET_SERVER_KEY
      else process.env.HEXCLAVE_SECRET_SERVER_KEY = previousSecret
    }
  })

  it('does not reveal whether a token is absent, expired or invalid', async () => {
    const rejecting: HexclaveRequestVerifier = { getUser: async () => { throw new Error('expired') } }
    await expect(authorizePaidRoute(request, rejecting)).resolves.toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized',
      detail: 'Sign in to use model-backed tools.',
    })
  })

  it('refuses anonymous and restricted sessions', async () => {
    const anonymous: HexclaveRequestVerifier = {
      getUser: async () => ({ id: 'anon', displayName: null, isAnonymous: true, isRestricted: false }),
    }
    const restricted: HexclaveRequestVerifier = {
      getUser: async () => ({ id: 'user', displayName: 'R', isAnonymous: false, isRestricted: true }),
    }
    await expect(authorizePaidRoute(request, anonymous)).resolves.toMatchObject({ status: 401, code: 'unauthorized' })
    await expect(authorizePaidRoute(request, restricted)).resolves.toMatchObject({ status: 403, code: 'restricted' })
  })

  it('returns only the identity fields the router needs', async () => {
    const accepted: HexclaveRequestVerifier = {
      getUser: async () => ({ id: 'user_1', displayName: 'Rishabh', isAnonymous: false, isRestricted: false }),
    }
    await expect(authorizePaidRoute(request, accepted)).resolves.toEqual({
      ok: true,
      identity: { userId: 'user_1', displayName: 'Rishabh' },
    })
  })
})

