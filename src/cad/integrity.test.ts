import { describe, expect, it } from 'vitest'
import { AssetIntegrityError, sha256Hex, verifyAsset } from './integrity'

const bytes = (value: string) => new TextEncoder().encode(value).buffer

describe('catalog asset integrity', () => {
  it('computes the standard SHA-256 digest', async () => {
    expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('accepts an exact content-addressed asset', async () => {
    const buffer = bytes('abc')
    await expect(
      verifyAsset(buffer, {
        bytes: 3,
        hash: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects a wrong length before hashing', async () => {
    await expect(
      verifyAsset(bytes('abc'), { bytes: 4, hash: `sha256:${'0'.repeat(64)}` }, 'geometry 3001'),
    ).rejects.toThrow(/geometry 3001 length mismatch/i)
  })

  it('rejects a digest mismatch without exposing either byte stream', async () => {
    await expect(
      verifyAsset(bytes('abc'), { bytes: 3, hash: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toBeInstanceOf(AssetIntegrityError)
  })
})

