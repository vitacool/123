import { describe, expect, it } from 'vitest'
import {
  applySpeedPreview,
  asetrateChain,
  atempoChain,
  canChangeClipSpeed,
  clampPlaybackRate,
  clampSpeed,
  clipKeepsPitch,
  clipSpeedValue,
  DEFAULT_SPEED,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  SPEED_MAX,
  SPEED_MIN,
  speedAdjustedDuration,
  speedAudioFilters,
  speedVideoFilter,
} from '../src/editor/core/speed'
import {
  clipFrameSourceAt,
  clipLocalAt,
  clipTimelineDuration,
  clipTimelineDurationAt,
} from '../src/editor/core/clipTime'
import { mapWordsToTimeline } from '../src/editor/core/captionMapping'
import { getTimeline } from '../src/editor/core/timeline'
import { createEditorStore, selectCanUndo } from '../src/editor/store/editorStore'
import type { AsrWord } from '../src/editor/core/asr'
import {
  createClip,
  createInitialProject,
  splitProjectAt,
  trimProjectLeft,
  trimProjectRight,
} from '../src/editor/core/operations'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import type { Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:v',
  name: 'v.mp4',
  size: 1_000_000,
  duration: 10,
  width: 1920,
  height: 1080,
}

function projectWithSpeed(speed: number, overrides = {}): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
  return {
    ...base,
    clips: [createClip(SOURCE.url, 0, 10, { speed, ...overrides }, 'c1')],
  }
}

describe('speed 参数与时长', () => {
  it('缺省 1、保持音调', () => {
    const clip = createClip('a', 0, 10)
    expect(clipSpeedValue(clip)).toBe(DEFAULT_SPEED)
    expect(clipKeepsPitch(clip)).toBe(true)
    expect(clipTimelineDuration(clip)).toBe(10)
  })

  it('倍率夹在 0.1–10', () => {
    expect(clampSpeed(0.01)).toBe(SPEED_MIN)
    expect(clampSpeed(99)).toBe(SPEED_MAX)
    expect(clampSpeed(Number.NaN)).toBe(1)
    expect(clampSpeed(2)).toBe(2)
  })

  it('时间轴时长 = 源时长 / 倍率', () => {
    expect(clipTimelineDuration(createClip('a', 0, 10, { speed: 2 }))).toBe(5)
    expect(clipTimelineDuration(createClip('a', 0, 10, { speed: 0.5 }))).toBe(20)
    expect(speedAdjustedDuration(createClip('a', 0, 10, { speed: 4 }))).toBe(2.5)
  })

  it('局部时间 ↔ 源时间按倍率换算', () => {
    const clip = createClip('a', 0, 10, { speed: 2 })
    // 时间轴 1s 对应源 2s
    expect(clipFrameSourceAt(clip, 1)).toBe(2)
    expect(clipLocalAt(clip, 2)).toBe(1)
  })

  it('keepPitch=false 被识别', () => {
    expect(clipKeepsPitch(createClip('a', 0, 5, { keepPitch: false }))).toBe(false)
  })
})

describe('变速滤镜生成', () => {
  it('视频：setpts=PTS/speed，1x 不产出滤镜', () => {
    expect(speedVideoFilter(2)).toBe('setpts=PTS/2')
    expect(speedVideoFilter(0.5)).toBe('setpts=PTS/0.5')
    expect(speedVideoFilter(1)).toBeNull()
  })

  it('音频 atempo 每级限制 0.5–2，超出时链式拆解', () => {
    expect(atempoChain(1)).toEqual([])
    expect(atempoChain(1.5)).toEqual(['atempo=1.5'])
    expect(atempoChain(0.5)).toEqual(['atempo=0.5'])
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2'])
    expect(atempoChain(3)).toEqual(['atempo=2', 'atempo=1.5'])
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5'])
    // 任何一级都必须在 0.5–2 之间
    for (const value of [0.1, 0.3, 0.75, 1.25, 2, 5, 10]) {
      for (const filter of atempoChain(value)) {
        const rate = Number(filter.replace('atempo=', ''))
        expect(rate).toBeGreaterThanOrEqual(0.5 - 1e-9)
        expect(rate).toBeLessThanOrEqual(2 + 1e-9)
      }
    }
  })

  it('keepPitch=false 用 asetrate + aresample（先归一采样率，44.1k 源才不会偏）', () => {
    expect(asetrateChain(2)).toEqual([
      'aresample=48000',
      'asetrate=96000',
      'aresample=48000',
    ])
    expect(asetrateChain(1)).toEqual([])
    expect(speedAudioFilters(2, true)).toEqual(['atempo=2'])
    expect(speedAudioFilters(2, false)).toEqual([
      'aresample=48000',
      'asetrate=96000',
      'aresample=48000',
    ])
  })
})

describe('分割继承变速', () => {
  it('split 后左右两段都保留 speed / keepPitch', () => {
    const project = projectWithSpeed(2, { keepPitch: false })
    const split = splitProjectAt(project, 'c1', 2, 'c2')!
    const [left, right] = split.clips
    expect(left.speed).toBe(2)
    expect(right.speed).toBe(2)
    expect(left.keepPitch).toBe(false)
    expect(right.keepPitch).toBe(false)
  })

  it('split 按倍率换算源时间：时间轴 2s 处切成源 4s', () => {
    const project = projectWithSpeed(2)
    const split = splitProjectAt(project, 'c1', 2, 'c2')!
    const [left, right] = split.clips
    expect(left.sourceEnd).toBe(4)
    expect(right.sourceStart).toBe(4)
    // 左段源跨度 4s @2x → 时间轴 2s
    expect(clipTimelineDuration(left)).toBe(2)
    expect(clipTimelineDuration(right)).toBe(3)
  })
})

describe('裁剪按倍率换算', () => {
  it('右裁 1 秒（时间轴）在 2x 下收敛源 2 秒', () => {
    const project = projectWithSpeed(2) // 源 0-10 @2x → 时间轴 0-5
    const trimmed = trimProjectRight(project, 'c1', 4)!
    // 时间轴从 5s 裁到 4s，源应少 2s
    expect(trimmed.clips[0].sourceEnd).toBe(8)
    expect(clipTimelineDuration(trimmed.clips[0])).toBe(4)
  })

  it('左裁 1 秒（时间轴）在 2x 下推进源 2 秒', () => {
    const project = projectWithSpeed(2)
    const trimmed = trimProjectLeft(project, 'c1', 1)!
    expect(trimmed.clips[0].sourceStart).toBe(2)
    expect(clipTimelineDuration(trimmed.clips[0])).toBe(4)
  })
})

describe('实时预览与播放速率钳制', () => {
  it('clipTimelineDurationAt 与显式 options 一致', () => {
    const clip = createClip('a', 0, 10)
    expect(clipTimelineDurationAt(clip, 2)).toBe(5)
    expect(clipTimelineDurationAt(clip, 0.5)).toBe(20)
    expect(clipTimelineDurationAt(clip, 1)).toBe(10)
    // 等价于把倍率写进片段再算
    expect(clipTimelineDurationAt(clip, 4)).toBe(
      clipTimelineDuration({ ...clip, speed: 4 }),
    )
  })

  it('applySpeedPreview 只改目标片段，不改原对象', () => {
    const project = projectWithSpeed(1)
    const two: Project = {
      ...project,
      clips: [
        createClip(SOURCE.url, 0, 10, {}, 'c1'),
        createClip(SOURCE.url, 10, 20, {}, 'c2'),
      ],
    }
    const previewed = applySpeedPreview(two, 'c1', 2)
    expect(previewed.clips[0].speed).toBe(2)
    expect(previewed.clips[1].speed).toBeUndefined()
    // 原工程未被就地修改
    expect(two.clips[0].speed).toBeUndefined()
  })

  it('applySpeedPreview 让时间轴实时重排（总时长减半）', () => {
    const project: Project = {
      ...createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1'),
      clips: [
        createClip(SOURCE.url, 0, 10, {}, 'c1'),
        createClip(SOURCE.url, 0, 10, {}, 'c2'),
      ],
    }
    const before = getTimeline(project.clips)
    expect(before[1].start).toBe(10)
    const previewed = applySpeedPreview(project, 'c1', 2)
    const after = getTimeline(previewed.clips)
    // c1 从 10s 缩到 5s，c2 随之前移
    expect(after[0].end).toBe(5)
    expect(after[1].start).toBe(5)
  })

  it('applySpeedPreview 支持叠加轨片段', () => {
    const project: Project = {
      ...projectWithSpeed(1),
      overlayTracks: [
        {
          id: 'ov1',
          name: '叠加',
          muted: false,
          hidden: false,
          clips: [createClip(SOURCE.url, 0, 4, {}, 'ovc')],
        },
      ],
    }
    const previewed = applySpeedPreview(project, 'ovc', 2)
    expect(previewed.overlayTracks![0].clips[0].speed).toBe(2)
    // 主轨片段的既有倍率（fixture 里是 1）保持不变
    expect(previewed.clips[0].speed).toBe(1)
  })

  it('applySpeedPreview 目标不存在时原样返回', () => {
    const project = projectWithSpeed(1)
    expect(applySpeedPreview(project, 'nope', 2)).toBe(project)
  })

  it('clampPlaybackRate 钳到浏览器支持的 [0.0625, 16]', () => {
    expect(clampPlaybackRate(0.01)).toEqual({ rate: PLAYBACK_RATE_MIN, clamped: true })
    expect(clampPlaybackRate(30)).toEqual({ rate: PLAYBACK_RATE_MAX, clamped: true })
    expect(clampPlaybackRate(2)).toEqual({ rate: 2, clamped: false })
    expect(clampPlaybackRate(0.5)).toEqual({ rate: 0.5, clamped: false })
    // 边界值不算被钳制，避免误报
    expect(clampPlaybackRate(PLAYBACK_RATE_MIN)).toEqual({
      rate: PLAYBACK_RATE_MIN,
      clamped: false,
    })
    expect(clampPlaybackRate(PLAYBACK_RATE_MAX)).toEqual({
      rate: PLAYBACK_RATE_MAX,
      clamped: false,
    })
    // 先按 SPEED_MIN/MAX 夹取，再按播放区间夹取
    expect(clampPlaybackRate(99).rate).toBe(PLAYBACK_RATE_MAX)
  })

  it('canChangeClipSpeed：定格与图片不可变速', () => {
    expect(canChangeClipSpeed({ type: 'video' })).toBe(true)
    expect(canChangeClipSpeed({})).toBe(true)
    expect(canChangeClipSpeed({ type: 'freeze' })).toBe(false)
    expect(canChangeClipSpeed({ type: 'image' })).toBe(false)
  })
})

describe('store.setClipSpeed 对定格片段的拒绝路径', () => {
  function storeWithFreeze() {
    const store = createEditorStore()
    store.getState().loadSource(SOURCE)
    return store
  }

  it('定格片段变速被拒绝：工程不变、无撤销步骤、给出 warning', () => {
    const store = storeWithFreeze()
    const state = store.getState()
    const freeze = createClip(SOURCE.url, 0, 4, { type: 'freeze', freezeFrameTime: 0 }, 'f1')
    // 直接把主轨换成定格片段
    store.setState({
      project: { ...state.project, clips: [freeze] },
      selectedClipId: 'f1',
      selectedIds: ['f1'],
    })
    const before = store.getState().project
    const canUndoBefore = selectCanUndo(store.getState())

    store.getState().setClipSpeed('f1', 2, true)

    expect(store.getState().project).toBe(before)
    expect(selectCanUndo(store.getState())).toBe(canUndoBefore)
    expect(store.getState().toast?.kind).toBe('warning')
    expect(store.getState().toast?.message).toContain('定格片段不支持变速')
  })

  it('普通片段变速成功并产生 1 个撤销步骤', () => {
    const store = storeWithFreeze()
    const clipId = store.getState().selectedClipId!
    store.getState().setClipSpeed(clipId, 2, true)
    expect(store.getState().project.clips[0].speed).toBe(2)
    expect(selectCanUndo(store.getState())).toBe(true)
    // 撤销后恢复原值
    store.getState().undo()
    expect(store.getState().project.clips[0].speed).toBeUndefined()
  })
})

describe('字幕映射按倍率换算（captionMapping）', () => {
  const words: AsrWord[] = [
    { text: '一', start: 0, end: 1 },
    { text: '二', start: 2, end: 3 },
    { text: '三', start: 4, end: 5 },
  ]

  function mapFor(speed: number | undefined) {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
    const project: Project = {
      ...base,
      clips: [createClip(SOURCE.url, 0, 10, speed === undefined ? {} : { speed }, 'c1')],
      audioTracks: [],
      textTracks: [],
    }
    return mapWordsToTimeline(project, { [SOURCE.url]: words })
  }

  it('1x 与旧行为逐值一致（线性平移回归）', () => {
    const mapped = mapFor(undefined)
    expect(mapped.map((word) => [word.start, word.end])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ])
  })

  it('2x 时源时间被压缩一半（旧实现会停留在源时间）', () => {
    const mapped = mapFor(2)
    expect(mapped.map((word) => [word.start, word.end])).toEqual([
      [0, 0.5],
      [1, 1.5],
      [2, 2.5],
    ])
  })

  it('0.5x 时源时间被拉长一倍', () => {
    const mapped = mapFor(0.5)
    expect(mapped.map((word) => [word.start, word.end])).toEqual([
      [0, 2],
      [4, 6],
      [8, 10],
    ])
  })

  it('映射结果被夹在该片段的时间轴范围内', () => {
    const mapped = mapFor(2)
    // 2x 下片段只有 5s，最后一个词不得越过 5s
    for (const word of mapped) {
      expect(word.start).toBeGreaterThanOrEqual(0)
      expect(word.end).toBeLessThanOrEqual(5 + 1e-6)
    }
  })

  it('源区间之外的词被过滤（半开区间不受倍率影响）', () => {
    const base = createInitialProject({ url: SOURCE.url, duration: 10 }, 'c1')
    const project: Project = {
      ...base,
      // 只保留源 2–5s，2x
      clips: [createClip(SOURCE.url, 2, 5, { speed: 2 }, 'c1')],
      audioTracks: [],
      textTracks: [],
    }
    const mapped = mapWordsToTimeline(project, { [SOURCE.url]: words })
    // 源 2–3、4–5 落在区间内；0–1 被过滤
    expect(mapped.map((word) => word.text)).toEqual(['二', '三'])
    // 源 2s 是片段自身起点 → 时间轴 0；源 4s → 时间轴 1
    expect(mapped[0].start).toBeCloseTo(0)
    expect(mapped[1].start).toBeCloseTo(1)
  })
})

describe('导出的变速参数', () => {
  it('视频 setpts 与音频 atempo 出现在滤镜图里', () => {
    const plan = buildExportPlan(projectWithSpeed(2), SOURCE, true)
    expect(plan.graph).toContain('setpts=PTS/2')
    expect(plan.graph).toContain('atempo=2')
    // 时长按变速后计算
    expect(plan.totalDuration).toBeCloseTo(5)
  })

  it('keepPitch=false 时音频改用 asetrate', () => {
    const plan = buildExportPlan(projectWithSpeed(2, { keepPitch: false }), SOURCE, true)
    expect(plan.graph).toContain('asetrate=96000')
    expect(plan.graph).toContain('aresample=48000')
    expect(plan.graph).not.toContain('atempo=2')
  })

  it('1x 不产生变速滤镜', () => {
    const plan = buildExportPlan(projectWithSpeed(1), SOURCE, true)
    expect(plan.graph).not.toContain('setpts=PTS/')
    expect(plan.graph).not.toContain('atempo=')
  })
})