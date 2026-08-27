import { describe, expect, it, vi } from 'vitest'
import { createId } from './ids'

describe('opaque ids', () => {
  it('uses the platform UUID source and keeps a readable namespace', () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')
    expect(createId('agent copy')).toBe('agent_copy_00000000-0000-4000-8000-000000000001')
    expect(randomUUID).toHaveBeenCalledOnce()
    randomUUID.mockRestore()
  })

  it('refuses an empty namespace', () => {
    expect(() => createId('---')).toThrow(/namespace/i)
  })
})

