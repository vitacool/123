import { describe, expect, it } from 'vitest'
import {
  clipFilmstripRange,
  clipFrameSourceAt,
  clipFreezeFrame,
  clipLocalAt,
  clipReversed,
  clipSourceSpan,
  clipSpeed,
  clipSpanSourceAt,
  clipTimelineDuration,
} from '../src/editor/core/clipTime'
import { createClip, createInitialProject, insertFreezeAt } from '../src/editor/core/operations'
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

describe('胶片条取样区间：定格只看冻结的那一帧', () => {
  it('定格片段取「冻结帧」单点，与 sourceStart / sourceEnd（停留时长）无关', () => {
    // 停留 4–7 = 3 秒，冻结在第 2.5 秒那一帧。
    expect(clipFilmstripRange(freeze(4, 7, 2.5))).toEqual({ start: 2.5, end: 2.5 })
    // 没写 freezeFrameTime 时回退到 sourceStart（与 clipFreezeFrame 口径一致）。
    const clip = createClip('src', 4, 7, { type: 'freeze' }, 'freeze-b')
    expect(clipFilmstripRange(clip)).toEqual({ start: 4, end: 4 })
  })

  it('普通 / 变速 / 曲线片段仍然取样整个源区间', () => {
    expect(clipFilmstripRange(video(2, 7))).toEqual({ start: 2, end: 7 })
    const sped = { ...video(2, 7), speed: 2 }
    expect(clipFilmstripRange(sped)).toEqual({ start: 2, end: 7 })
    const curved = {
      ...video(2, 7),
      speedCurve: [
        { at: 0, speed: 1 },
        { at: 1, speed: 3 },
      ],
    }
    expect(clipFilmstripRange(curved)).toEqual({ start: 2, end: 7 })
  })

  it('插入定格：冻结帧 = 播放头处的源时间（缩略条与预览都看这一帧）', () => {
    const project = {
      ...createInitialProject({ url: 'src', duration: 30 }, 'clip-a'),
      clips: [video(0, 10)],
    }
    const insertion = insertFreezeAt(project, 4, 'freeze-c', 3)!
    const clip = insertion.freeze
    expect(clip.type).toBe('freeze')
    expect(clipFreezeFrame(clip)).toBeCloseTo(4, 9)
    // 缩略条取样点 = 冻结帧（修复前是 [4, 7]，会画出一串往后走的帧）。
    expect(clipFilmstripRange(clip)).toEqual({ start: 4, end: 4 })
    // 预览 / 导出：任何局部时间都显示同一帧。
    expect(clipFrameSourceAt(clip, 0)).toBeCloseTo(4, 9)
    expect(clipFrameSourceAt(clip, 2.9)).toBeCloseTo(4, 9)
    // 分割出的左右两半各自映射正确。
    const [left, right] = insertion.project.clips
    expect(left.sourceEnd).toBeCloseTo(4, 9)
    expect(right.sourceStart).toBeCloseTo(4, 9)
    expect(clipFrameSourceAt(left, 3.9)).toBeCloseTo(3.9, 6)
  })

  it('变速片段里插入定格：冻结帧按倍率换算到源时间', () => {
    const sped = { ...video(0, 10), speed: 2 }
    const project = {
      ...createInitialProject({ url: 'src', duration: 30 }, 'clip-a'),
      clips: [sped],
    }
    // 2x 下时间轴 1.5s 对应源 3s。
    const insertion = insertFreezeAt(project, 1.5, 'freeze-d', 1)!
    expect(clipFreezeFrame(insertion.freeze)).toBeCloseTo(3, 9)
    expect(clipFilmstripRange(insertion.freeze)).toEqual({ start: 3, end: 3 })
  })
})