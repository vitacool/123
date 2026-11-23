import { describe, expect, it } from 'vitest'
import {
  ANIMATED_CLIP_FIELD_HANDLING,
  bakeAnimatedClip,
  type AnimatedClipFieldHandling,
} from '../src/editor/core/animationExport'
import { createClip } from '../src/editor/core/operations'
import type { Clip } from '../src/editor/core/types'

/**
 * 逐帧烘焙后，片段必须变成「指向中间视频的普通片段」：
 * 所有已经画进画面的视觉字段都要重置，否则导出会把效果**再做一遍**。
 *
 * 本文件同时用两类守卫：
 * - 编译期：`ANIMATED_CLIP_FIELD_HANDLING` 用 `satisfies Record<keyof Clip, …>`
 *   穷举 Clip 的每个字段 —— 以后新增字段没表态，typecheck 直接失败；
 * - 运行期：逐个字段断言「baked = 必须变化 / kept = 必须原样保留」。
 */

/** 覆盖 Clip 所有字段、且每个字段都取非默认值的片段。 */
function richClip(): Clip {
  return createClip(
    'blob:source',
    1,
    4,
    {
      type: 'freeze',
      rotation: 30,
      flipH: true,
      flipV: true,
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      scale: 0.6,
      position: { x: 0.2, y: -0.1 },
      gapBefore: 0.7,
      freezeFrameTime: 2,
      volume: 1.5,
      fadeIn: 0.5,
      fadeOut: 0.4,
      speed: 2,
      keepPitch: false,
      opacity: 0.5,
      blendMode: 'multiply',
      speedSegments: [
        { at: 0, speed: 1 },
        { at: 0.5, speed: 2 },
      ],
      speedCurve: [
        { at: 0, speed: 1 },
        { at: 1, speed: 2 },
      ],
      transitionOut: { type: 'fade', duration: 0.5 },
      background: { type: 'color', color: '#123456' },
      color: { brightness: 20, contrast: 10, saturation: 5, temperature: -5 },
      mask: {
        shape: 'rect',
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.5,
        rotation: 15,
        feather: 0.1,
        invert: false,
      },
      chromaKey: { color: '#00ff00', similarity: 0.2, blend: 0.1, spill: 0.3 },
      anim: {
        'position.x': [
          { t: 0, value: 0, ease: 'linear' },
          { t: 1, value: 1, ease: 'linear' },
        ],
        volume: [
          { t: 0, value: 1, ease: 'linear' },
          { t: 1, value: 0.5, ease: 'linear' },
        ],
      },
    },
    'clip-rich',
  )
}

describe('bakeAnimatedClip：蒙版 / 抠像必须清掉（渲染器已经画过一次）', () => {
  it('mask 与 chromaKey 被清空', () => {
    const baked = bakeAnimatedClip(richClip(), 'blob:anim-preview', 5)
    expect(baked.mask).toBeUndefined()
    expect(baked.chromaKey).toBeUndefined()
  })

  it('蒙版/抠像之外：几何、调色、透明度、背景、变速全部重置', () => {
    const source = richClip()
    const baked = bakeAnimatedClip(source, 'blob:anim-preview', 5)
    expect(baked.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(baked.scale).toBe(1)
    expect(baked.position).toEqual({ x: 0, y: 0 })
    expect(baked.rotation).toBe(0)
    expect(baked.flipH).toBe(false)
    expect(baked.flipV).toBe(false)
    expect(baked.opacity).toBe(1)
    expect(baked.blendMode).toBe('normal')
    expect(baked.background).toBeUndefined()
    expect(baked.color).toBeUndefined()
    expect(baked.speed).toBe(1)
    expect(baked.speedSegments).toBeUndefined()
    expect(baked.speedCurve).toBeUndefined()
    expect(baked.type).toBe('video')
    expect(baked.freezeFrameTime).toBeUndefined()
    // 时间轴结构 / 音频参数不该被烘焙改动。
    expect(baked.gapBefore).toBe(source.gapBefore)
    expect(baked.volume).toBe(source.volume)
    expect(baked.fadeIn).toBe(source.fadeIn)
    expect(baked.fadeOut).toBe(source.fadeOut)
    expect(baked.transitionOut).toEqual(source.transitionOut)
    // 音量关键帧保留给音频链，视觉关键帧丢弃。
    expect(baked.anim).toEqual({ volume: source.anim!.volume })
  })
})

describe('字段归属表：新增 Clip 字段必须表态', () => {
  it('覆盖 Clip 的全部字段（运行期兜底；编译期由 satisfies 保证）', () => {
    const clipKeys = Object.keys(richClip()).sort()
    const tableKeys = Object.keys(ANIMATED_CLIP_FIELD_HANDLING).sort()
    expect(tableKeys).toEqual(clipKeys)
  })

  it('逐字段：baked 必须变化，kept 必须原样保留', () => {
    const source = richClip()
    const baked = bakeAnimatedClip(source, 'blob:anim-preview', 5)
    for (const key of Object.keys(ANIMATED_CLIP_FIELD_HANDLING) as (keyof Clip)[]) {
      const handling: AnimatedClipFieldHandling = ANIMATED_CLIP_FIELD_HANDLING[key]
      if (handling === 'kept') {
        expect(baked[key], `${key} 应原样保留`).toEqual(source[key])
      } else if (handling === 'baked') {
        expect(baked[key], `${key} 必须被烘焙后重置`).not.toEqual(source[key])
      } else {
        // replaced / partial：由函数显式处理（sourceUrl / anim）。
        expect(['sourceUrl', 'anim']).toContain(key)
      }
    }
  })
})