import { describe, expect, it } from 'vitest'
import { buildAsrCacheKey, type AsrCacheKey } from '../src/editor/core/asr'

describe('buildAsrCacheKey', () => {
  it('combines asset, interval, provider and language deterministically', () => {
    const key: AsrCacheKey = {
      assetId: 'asset-1',
      start: 1.23456,
      end: 5.6789,
      providerId: 'whisper-small-timestamped',
      language: 'zh',
    }
    expect(buildAsrCacheKey(key)).toBe('v2|asset-1|1.235|5.679|whisper-small-timestamped|zh')
  })

  it('distinguishes different intervals and providers', () => {
    const base: AsrCacheKey = {
      assetId: 'asset-1',
      start: 0,
      end: 10,
      providerId: 'p',
      language: 'auto',
    }
    expect(buildAsrCacheKey(base)).not.toBe(buildAsrCacheKey({ ...base, start: 1 }))
    expect(buildAsrCacheKey(base)).not.toBe(buildAsrCacheKey({ ...base, providerId: 'q' }))
    expect(buildAsrCacheKey({ ...base, language: 'zh' })).not.toBe(
      buildAsrCacheKey({ ...base, language: 'en' }),
    )
  })
})