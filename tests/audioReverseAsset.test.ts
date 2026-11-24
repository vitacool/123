import { describe, expect, it } from 'vitest'
import { buildReversedAudioAsset, reverseAudioClipPatch } from '../src/editor/core/audio'
import { unusedAssets } from '../src/editor/core/assets'
import { createInitialProject } from '../src/editor/core/operations'
import type { AudioClip, MediaAsset } from '../src/editor/core/types'

const source: MediaAsset = {
  id: 'orig',
  url: 'blob:orig',
  name: 'music.mp3',
  size: 100,
  duration: 8,
  width: 0,
  height: 0,
  kind: 'audio',
}

function clip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'a',
    sourceUrl: source.url,
    sourceStart: 2,
    sourceEnd: 6,
    start: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    ...overrides,
  }
}

describe('音频倒放素材与来源保护', () => {
  it('buildReversedAudioAsset 写入 reversedFrom，原素材不会被误判为未使用', () => {
    const file = new File(['x'], 'music-reversed.m4a', { type: 'audio/mp4' })
    const reversed = buildReversedAudioAsset(source, file, 'rev', 'blob:rev')
    expect(reversed).toMatchObject({
      id: 'rev',
      url: 'blob:rev',
      name: 'music-reversed.m4a',
      kind: 'audio',
      duration: 8,
    })
    expect(reversed.reversedFrom).toEqual({
      assetId: 'orig',
      sourceUrl: 'blob:orig',
      start: 0,
      end: 8,
    })

    // 片段已指向倒放素材：原素材必须仍被判定为“已使用”，否则清理会把撤销依据删掉。
    const project = createInitialProject({ url: 'blob:rev', duration: 8 }, 'c1')
    expect(unusedAssets(project, [source, reversed])).toEqual([])
  })

  it('倒放镜像关键帧时对调 easeIn/easeOut', () => {
    const patch = reverseAudioClipPatch(
      clip({
        anim: {
          volume: [
            { t: 0.25, value: 2, ease: 'easeIn' },
            { t: 0.75, value: 0.5, ease: 'easeOut' },
          ],
        },
      }),
      'blob:rev',
      8,
    )
    expect(patch.anim?.volume?.[0]).toMatchObject({ t: 0.25, value: 0.5, ease: 'easeIn' })
    expect(patch.anim?.volume?.[1]).toMatchObject({ t: 0.75, value: 2, ease: 'easeOut' })
  })
})