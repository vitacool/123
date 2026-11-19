import { describe, expect, it } from 'vitest'
import {
  clipFrameSourceAt,
  clipFreezeFrame,
  clipLocalAt,
  clipReversed,
  clipSourceSpan,
  clipSpeed,
  clipSpanSourceAt,
  clipTimelineDuration,
} from '../src/editor/core/clipTime'
import { createClip } from '../src/editor/core/operations'
import type { Clip } from '../src/editor/core/types'

function video(start = 2, end = 7): Clip {
  return createClip('src', start, end, {}, 'clip-a')
}

function freeze(start = 4, end = 7, frame = 4): Clip {
  return createClip('src', start, end, { type: 'freeze', freezeFrameTime: frame }, 'freeze-a')
}

describe('clipTime：普通片段', () => {
  it('时间轴时长 = sourceEnd - sourceStart', () => {
    expect(clipTimelineDuration(video(2, 7))).toBe(5)
    expect(clipTimelineDuration(video(0, 0.5))).toBeCloseTo(0.5)
  })

  it('局部时间 → 源时间（正向）', () => {
    const clip = video(2, 7)
    expect(clipSpanSourceAt(clip, 0)).toBe(2)
    expect(clipSpanSourceAt(clip, 1.5)).toBe(3.5)
    expect(clipFrameSourceAt(clip, 1.5)).toBe(3.5)
  })

  it('源时间 → 局部时间', () => {
    const clip = video(2, 7)
    expect(clipLocalAt(clip, 2)).toBe(0)
    expect(clipLocalAt(clip, 5.5)).toBe(3.5)
  })

  it('源跨度与定格帧', () => {
    const clip = video(2, 7)
    expect(clipSourceSpan(clip)).toEqual({ start: 2, end: 7 })
    expect(clipFreezeFrame(clip)).toBe(2)
  })

  it('往返换算自洽（正向）：local → source → local', () => {
    const clip = video(3, 9)
    for (const local of [0, 0.25, 2, 5.75, 6]) {
      expect(clipLocalAt(clip, clipSpanSourceAt(clip, local))).toBeCloseTo(local, 6)
    }
  })
})

describe('clipTime：定格片段', () => {
  it('时间轴时长按 sourceStart/sourceEnd 的停留时长计算', () => {
    expect(clipTimelineDuration(freeze(4, 7))).toBe(3)
  })

  it('显示帧恒为 freezeFrameTime，不随时间变化', () => {
    const clip = freeze(4, 7, 4)
    expect(clipFrameSourceAt(clip, 0)).toBe(4)
    expect(clipFrameSourceAt(clip, 1.5)).toBe(4)
    expect(clipFrameSourceAt(clip, 3)).toBe(4)
  })

  it('没有 freezeFrameTime 时回退到 sourceStart', () => {
    const clip = createClip('src', 5, 8, { type: 'freeze' }, 'f')
    expect(clipFreezeFrame(clip)).toBe(5)
    expect(clipFrameSourceAt(clip, 2)).toBe(5)
  })

  it('跨度坐标仍按 sourceStart+local（用于 split/trim 改写时长）', () => {
    const clip = freeze(4, 7)
    expect(clipSpanSourceAt(clip, 0)).toBe(4)
    expect(clipSpanSourceAt(clip, 2)).toBe(6)
  })

  it('源时间 → 局部时间对定格返回 0', () => {
    expect(clipLocalAt(freeze(4, 7), 5)).toBe(0)
  })
})

describe('clipTime：预留 speed / reversed 参数', () => {
  it('默认倍率 1、非倒放', () => {
    const clip = video(2, 7)
    expect(clipSpeed(clip)).toBe(1)
    expect(clipReversed(clip)).toBe(false)
  })

  it('倍率 2 时时间轴时长减半', () => {
    expect(clipTimelineDuration(video(2, 7), { speed: 2 })).toBe(2.5)
  })

  it('倍率 2 时局部时间 → 源时间翻倍', () => {
    expect(clipSpanSourceAt(video(2, 7), 1, { speed: 2 })).toBe(4)
    expect(clipLocalAt(video(2, 7), 4, { speed: 2 })).toBe(1)
  })

  it('倒放时局部时间从尾部反向', () => {
    const clip = video(2, 7)
    expect(clipSpanSourceAt(clip, 0, { reversed: true })).toBe(7)
    expect(clipSpanSourceAt(clip, 2, { reversed: true })).toBe(5)
    expect(clipLocalAt(clip, 7, { reversed: true })).toBe(0)
    expect(clipLocalAt(clip, 5, { reversed: true })).toBe(2)
  })

  it('非法倍率回退为 1', () => {
    expect(clipSpeed(video(), { speed: 0 })).toBe(1)
    expect(clipSpeed(video(), { speed: -3 })).toBe(1)
    expect(clipSpeed(video(), { speed: Number.NaN })).toBe(1)
    expect(clipTimelineDuration(video(2, 7), { speed: 0 })).toBe(5)
  })
})