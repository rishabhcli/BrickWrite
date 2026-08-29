import { describe, expect, it } from 'vitest'
import { classifyTransportFailure } from '../convexClient'

describe('transport error classification', () => {
  it('classifies connectivity failures as OFFLINE so the outbox retries', () => {
    for (const message of [
      'Failed to fetch',
      'network error',
      'fetch failed',
      'ECONNREFUSED',
      'ENOTFOUND api.example',
      'the client is offline',
      'socket hang up',
    ]) {
      expect(classifyTransportFailure(new Error(message)).code).toBe('OFFLINE')
    }
  })

  it('classifies other thrown failures as TRANSPORT_FAILED', () => {
    const error = classifyTransportFailure(new Error('Convex mutation timed out'))
    expect(error.code).toBe('TRANSPORT_FAILED')
    expect(error.message).toContain('timed out')
  })

  it('stringifies a non-Error throw', () => {
    expect(classifyTransportFailure('Failed to fetch').code).toBe('OFFLINE')
    expect(classifyTransportFailure(404).code).toBe('TRANSPORT_FAILED')
  })
})
