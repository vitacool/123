import { describe, expect, it } from 'vitest'
import {
  SPEED_CURVE_SAMPLES,
  clipSpeedSegments,
  segmentPlan,
  sliceSpeedRange,
  sliceSpeedSegments,
} from '../src/editor/core/speed'
import {
  clipSourceSpan,
  clipLocalAt,
  clipSpanSourceAt,
  clipTimelineDuration,
} from '../src/editor/core/clipTime'
import {
  createClip,
  createInitialProject,
  insertFreezeAt,
  resizeClipEdge,
  resizeOverlayClipEdge,
  splitOverlayClipAt,
  splitProjectAt,
  trimOverlayClipAt,
  trimProjectLeft,
  trimProjectRight,
} from '../src/editor/core/operations'
import type { Clip, OverlayTrack, Project, SpeedSegment } from '../src/editor/core/types'

const SOURCE = 'blob:speed-slice'
const DURATION_TOLERANCE = 1e-3 // 1ms

/** 分段：源 0–10s 上「前 5s 1x、后 5s 4x」。 */
const SEGMENTS: SpeedSegment[] = [
  { at: 0, speed: 1 },
  { at: 0.5, speed: 4 },
]

/** 曲线：源 0–10s 上 1x → 4x → 1x（峰值在 5s）。 */
const CURVE: SpeedSegment[] = [
  { at: 0, speed: 1 },
  { at: 0.5, speed: 4 },
  { at: 1, speed: 1 },
]

const video = (overrides: Partial<Clip> = {}, start = 0, end = 10): Clip =>
  createClip(SOURCE, start, end, overrides, 'clip-a')

const segmentedClip = () => video({ speedSegments: SEGMENTS })
const curvedClip = () => video({ speedCurve: CURVE })

const projectOf = (clip: Clip): Project => ({
  ...createInitialProject({ url: SOURCE, duration: 30 }, clip.id),
  clips: [clip],
})

/** 主轨放一段长素材、叠加轨放待测片段。 */
const overlayProjectOf = (clip: Clip): Project => ({
  ...createInitialProject({ url: SOURCE, duration: 30 }, 'main'),
  clips: [createClip(SOURCE, 0, 30, {}, 'main')],
  overlayTracks: [
    {
      id: 'ov',
      name: '叠加 1',
      muted: false,
      hidden: false,
      clips: [clip],
    } satisfies OverlayTrack,
  ],
})

/** 该片段在某个「绝对源时刻」的段速（与 segmentPlan 的半开区间口径一致）。 */
function speedAtSource(clip: Clip, sourceTime: number): number {
  const plan = segmentPlan(clip)
  if (!plan) return clip.speed ?? 1
  for (const piece of plan) {
    if (sourceTime < piece.sourceEnd - 1e-9) return piece.speed
  }
  return plan[plan.length - 1].speed
}

/** 在 (from, to) 内均匀采样若干源时刻，逐个比对段速是否与 `reference` 一致。 */
function expectSameSpeedsAtSameSource(
  reference: Clip,
  actual: Clip,
  from: number,
  to: number,
  samples = 97,
): void {
  for (let index = 0; index < samples; index += 1) {
    const source = from + ((index + 0.5) / samples) * (to - from)
    expect(speedAtSource(actual, source)).toBe(speedAtSource(reference, source))
  }
}

describe('sliceSpeedSegments：按源区间裁段表', () => {
  it('在段内切一刀：插入断点，两侧速度都不变', () => {
    // 源 0–10 上 [0,4)@2x、[4,10)@0.5x，裁出 [2,7]
    const segments = sliceSpeedSegments(
      [
        { at: 0, speed: 2 },
        { at: 0.4, speed: 0.5 },
      ],
      0,
      10,
      2,
      7,
    )!
    expect(segments).toEqual([
      { at: 0, speed: 2 },
      { at: 0.4, speed: 0.5 },
    ])
    // 2 段：2s..4s @2x（占 0.4），4s..7s @0.5x（占 1.0）
    expect(segments[0]).toEqual({ at: 0, speed: 2 })
    expect(segments[1].at).toBeCloseTo((4 - 2) / 5, 9)
    expect(segments[1].speed).toBe(0.5)
  })

  it('切点恰好落在段边界：取从该点开始的段，不留零宽段', () => {
    const segments = sliceSpeedSegments(
      [
        { at: 0, speed: 1 },
        { at: 0.5, speed: 4 },
      ],
      0,
      10,
      5,
      10,
    )!
    expect(segments).toEqual([
      { at: 0, speed: 4 },
      { at: 0.5, speed: 4 },
    ])
  })

  it('裁出的区间只含一个恒速段：补一个同速段（段表至少 2 段才生效）', () => {
    const segments = sliceSpeedSegments(
      [
        { at: 0, speed: 1 },
        { at: 0.5, speed: 4 },
      ],
      0,
      10,
      1,
      4,
    )!
    expect(segments).toEqual([
      { at: 0, speed: 1 },
      { at: 0.5, speed: 1 },
    ])
  })

  it('区间伸出源区间：超出部分沿用最近一端的段速（外扩不拉伸曲线）', () => {
    const growRight = sliceSpeedSegments(
      [
        { at: 0, speed: 1 },
        { at: 0.5, speed: 4 },
      ],
      0,
      10,
      0,
      12,
    )!
    // 原 [0,5)@1x、[5,10]@4x，右侧补出 [10,12]@4x
    expect(growRight).toEqual([
      { at: 0, speed: 1 },
      { at: 5 / 12, speed: 4 },
      { at: 10 / 12, speed: 4 },
    ])
    const growLeft = sliceSpeedSegments(
      [
        { at: 0, speed: 1 },
        { at: 0.5, speed: 4 },
      ],
      2,
      10,
      0,
      10,
    )!
    // 源区间本来是 2–10：[2,6)@1x、[6,10]@4x；左扩到 0 后前面 [0,2) 沿用第一段 1x
    expect(growLeft[0]).toEqual({ at: 0, speed: 1 })
    expect(growLeft[1]).toEqual({ at: 0.2, speed: 1 })
  })

  it('非法输入返回 undefined', () => {
    expect(sliceSpeedSegments(undefined, 0, 10, 0, 5)).toBeUndefined()
    expect(sliceSpeedSegments(SEGMENTS, 0, 10, 3, 3)).toBeUndefined()
    expect(sliceSpeedSegments(SEGMENTS, 0, 0, 0, 0)).toBeUndefined()
  })
})

describe('sliceSpeedRange：片段级补丁', () => {
  it('普通倍率片段 / 定格片段不产生变速补丁', () => {
    expect(sliceSpeedRange(video({ speed: 2 }), 0, 5)).toEqual({})
    const freeze = createClip(SOURCE, 0, 4, { type: 'freeze', freezeFrameTime: 1 }, 'f')
    expect(sliceSpeedRange(freeze, 0, 2)).toEqual({})
  })

  it('分段片段：返回等价的分段表，并显式清掉曲线字段', () => {
    const patch = sliceSpeedRange(segmentedClip(), 0, 5)
    expect(patch.speedSegments).toEqual([
      { at: 0, speed: 1 },
      { at: 0.5, speed: 1 },
    ])
    expect(patch.speedCurve).toBeUndefined()
  })

  it('曲线片段：按有效段表切片（16 段），曲线字段被清空', () => {
    const patch = sliceSpeedRange(curvedClip(), 0, 5)
    expect(patch.speedCurve).toBeUndefined()
    expect(patch.speedSegments!.length).toBeGreaterThan(1)
    expect(patch.speedSegments!.length).toBeLessThanOrEqual(SPEED_CURVE_SAMPLES)
  })

  it('区间没变时返回空补丁（不做无谓的曲线降级）', () => {
    expect(sliceSpeedRange(curvedClip(), 0, 10)).toEqual({})
  })
})

describe('分割：分段变速', () => {
  it('在 4x 段内分割后，两半各自的速度与时长都正确', () => {
    const original = segmentedClip()
    const originalDuration = clipTimelineDuration(original)
    // 时间轴 5.625s → 源 7.5s（前 5s 1x 走完 5s，再 0.625s 的 4x 走 2.5s）
    expect(clipSpanSourceAt(original, 5.625)).toBeCloseTo(7.5, 9)
    const split = splitProjectAt(projectOf(original), original.id, 5.625, 'clip-b')!
    const [left, right] = split.clips

    expect(left.sourceStart).toBeCloseTo(0, 9)
    expect(left.sourceEnd).toBeCloseTo(7.5, 9)
    expect(right.sourceStart).toBeCloseTo(7.5, 9)
    expect(right.sourceEnd).toBeCloseTo(10, 9)
    // 左半：0–5s 1x + 5–7.5s 4x
    expect(clipTimelineDuration(left)).toBeCloseTo(5 + 2.5 / 4, 9)
    // 右半：2.5s 全 4x
    expect(clipTimelineDuration(right)).toBeCloseTo(2.5 / 4, 9)
    // 验收：两半时长之和 = 原时长（误差 < 1ms）
    expect(
      Math.abs(clipTimelineDuration(left) + clipTimelineDuration(right) - originalDuration),
    ).toBeLessThan(DURATION_TOLERANCE)
    // 每个源时刻的速度不变（这正是原来 0.5 分界点被压缩到左半、后半段变 4x 的 bug）
    expectSameSpeedsAtSameSource(original, left, 0, 7.5)
    expectSameSpeedsAtSameSource(original, right, 7.5, 10)
    // 4x 段不应该漏进左半的前 5s
    expect(speedAtSource(left, 2.5)).toBe(1)
    expect(speedAtSource(left, 6)).toBe(4)
  })

  it('分割点在段边界上时也精确守恒', () => {
    const original = segmentedClip()
    const split = splitProjectAt(projectOf(original), original.id, 5, 'clip-b')!
    const [left, right] = split.clips
    expect(clipTimelineDuration(left)).toBeCloseTo(5, 9)
    expect(clipTimelineDuration(right)).toBeCloseTo(1.25, 9)
    expect(
      Math.abs(clipTimelineDuration(left) + clipTimelineDuration(right) - clipTimelineDuration(original)),
    ).toBeLessThan(DURATION_TOLERANCE)
    expect(speedAtSource(left, 4.9)).toBe(1)
    expect(speedAtSource(right, 5.1)).toBe(4)
  })
})

describe('分割：速度曲线', () => {
  it('曲线片段分割后，两半时长之和 = 原时长（误差 < 1ms）', () => {
    const original = curvedClip()
    const originalDuration = clipTimelineDuration(original)
    // 分割点按「时间轴时间」给（曲线下 4.32s 的总长，取一半正好对应源 5s）
    const splitAt = originalDuration / 2
    const boundary = clipSpanSourceAt(original, splitAt)
    // 注意：曲线中间快、两端慢，所以「时间轴一半」不等于「源一半」（≈4.10s 而非 5s），
    // 下面的断言只依赖真实边界，不依赖这个直观假设。
    const split = splitProjectAt(projectOf(original), original.id, splitAt, 'clip-b')!
    const [left, right] = split.clips

    expect(
      Math.abs(clipTimelineDuration(left) + clipTimelineDuration(right) - originalDuration),
    ).toBeLessThan(DURATION_TOLERANCE)
    // 每个源时刻的速度不变（切片按有效段表烘焙，采样网格不会漂移）
    expectSameSpeedsAtSameSource(original, left, 0, boundary)
    expectSameSpeedsAtSameSource(original, right, boundary, 10)
    // 曲线被降级为等价的分段表示
    expect(left.speedCurve).toBeUndefined()
    expect(right.speedCurve).toBeUndefined()
    expect(clipSpeedSegments(left)!.length).toBeGreaterThan(1)
  })

  it('非对称分割点（曲线片段在 1/3 处切）也守恒', () => {
    const original = curvedClip()
    const splitAt = clipTimelineDuration(original) / 3
    const boundary = clipSpanSourceAt(original, splitAt)
    const split = splitProjectAt(projectOf(original), original.id, splitAt, 'clip-b')!
    const [left, right] = split.clips
    expect(
      Math.abs(clipTimelineDuration(left) + clipTimelineDuration(right) - clipTimelineDuration(original)),
    ).toBeLessThan(DURATION_TOLERANCE)
    expectSameSpeedsAtSameSource(original, left, 0, boundary)
    expectSameSpeedsAtSameSource(original, right, boundary, 10)
  })
})

describe('左裁 / 右裁', () => {
  it('左裁分段变速：源 0–10 → 2.5–10，时长与逐点速度都正确', () => {
    const original = segmentedClip()
    const trimmed = trimProjectLeft(projectOf(original), original.id, 2.5)!.clips[0]
    expect(trimmed.sourceStart).toBeCloseTo(2.5, 9)
    expect(trimmed.sourceEnd).toBeCloseTo(10, 9)
    expect(clipTimelineDuration(trimmed)).toBeCloseTo(clipTimelineDuration(original) - 2.5, 9)
    // 裁掉的 2.5s（1x）之外，剩下的还是「2.5s 1x + 5s 4x」
    expect(speedAtSource(trimmed, 2.6)).toBe(1)
    expect(speedAtSource(trimmed, 7)).toBe(4)
    expectSameSpeedsAtSameSource(original, trimmed, 2.5, 10)
  })

  it('左裁速度曲线：时长按裁掉的局部时间精确减少，逐点速度不变', () => {
    const original = curvedClip()
    const delta = 2 // 时间轴前 2s
    const boundary = clipSpanSourceAt(original, delta)
    const trimmed = trimProjectLeft(projectOf(original), original.id, delta)!.clips[0]
    expect(
      Math.abs(clipTimelineDuration(trimmed) - (clipTimelineDuration(original) - delta)),
    ).toBeLessThan(DURATION_TOLERANCE)
    expectSameSpeedsAtSameSource(original, trimmed, boundary, 10)
  })

  it('右裁分段变速：保留前半段，末端切在 4x 段内', () => {
    const original = segmentedClip()
    const originalDuration = clipTimelineDuration(original)
    const keepUntil = 5.625 // 时间轴保留到 5.625s
    const trimmed = trimProjectRight(projectOf(original), original.id, keepUntil)!.clips[0]
    expect(trimmed.sourceEnd).toBeCloseTo(7.5, 9)
    expect(clipTimelineDuration(trimmed)).toBeCloseTo(5 + 2.5 / 4, 9)
    // 时长守恒：新时长 = 原时长 - 被裁掉的时间轴长度
    expect(
      Math.abs(clipTimelineDuration(trimmed) - (originalDuration - (originalDuration - keepUntil))),
    ).toBeLessThan(DURATION_TOLERANCE)
    expect(speedAtSource(trimmed, 6)).toBe(4)
    expectSameSpeedsAtSameSource(original, trimmed, 0, 7.5)
  })

  it('右裁速度曲线：逐点速度不变，时长守恒', () => {
    const original = curvedClip()
    const originalDuration = clipTimelineDuration(original)
    const keepUntil = 2.5 // 时间轴保留到 2.5s（曲线片段总长约 4.32s）
    const trimmed = trimProjectRight(projectOf(original), original.id, keepUntil)!.clips[0]
    // 片段从 0 开始 → 保留后的时间轴时长就该等于 keepUntil
    expect(Math.abs(clipTimelineDuration(trimmed) - keepUntil)).toBeLessThan(DURATION_TOLERANCE)
    expect(
      Math.abs(clipTimelineDuration(trimmed) - (originalDuration - (originalDuration - keepUntil))),
    ).toBeLessThan(DURATION_TOLERANCE)
    expectSameSpeedsAtSameSource(original, trimmed, 0, clipSourceSpan(trimmed).end)
  })
})

describe('贴近段边界的分割（1% 最小段宽策略的回归）', () => {
  const nearBoundary = (
    clip: Clip,
    boundarySource: number,
    offset: number,
  ): { error: number } => {
    const original = clip
    const total = clipTimelineDuration(original)
    const splitAt = clipLocalAt(original, boundarySource + offset)
    const split = splitProjectAt(projectOf(original), original.id, splitAt, 'clip-b')!
    const sum = clipTimelineDuration(split.clips[0]) + clipTimelineDuration(split.clips[1])
    return { error: Math.abs(sum - total) }
  }

  it('分段片段：边界之后分割精确守恒；边界之前受 1% 最小段宽限制', () => {
    const original = segmentedClip()
    // 边界之后（源 5s 起）：切片首段是完整段 → 精确守恒。
    for (const offset of [0.001, 0.005, 0.02, 0.2]) {
      expect(nearBoundary(original, 5, offset).error).toBeLessThan(DURATION_TOLERANCE)
    }
    // 边界之前：右半开头会留下一个窄于 1% 的段，段表表示不了 →
    // 这段内容只能按邻段速度播，误差以「窄段源长 × |1/v窄 - 1/v邻|」为界（1x ↔ 4x）。
    for (const offset of [-0.001, -0.005, -0.02]) {
      const bound = Math.abs(offset) * (1 - 1 / 4)
      expect(nearBoundary(original, 5, offset).error).toBeLessThanOrEqual(bound + DURATION_TOLERANCE)
    }
  })

  it('曲线片段：边界之后分割精确守恒；边界之前的误差同样以窄段时长为界', () => {
    const original = curvedClip()
    // 第 4 个采样网格点在源 2.5s
    for (const offset of [0.001, 0.005, 0.02]) {
      expect(nearBoundary(original, 2.5, offset).error).toBeLessThan(DURATION_TOLERANCE)
    }
    for (const offset of [-0.001, -0.02]) {
      // 邻段速度约 2.6x，误差上限按「1x ↔ 2.6x」估
      const bound = Math.abs(offset) * (1 - 1 / 2.6)
      expect(nearBoundary(original, 2.5, offset).error).toBeLessThanOrEqual(bound + DURATION_TOLERANCE)
    }
  })
})

describe('转场归属：分割后左半不保留 transitionOut', () => {
  const withTransition = () =>
    video({
      speedSegments: SEGMENTS,
      transitionOut: { type: 'fade', duration: 0.5 },
    })

  it('主轨分割：出点转场只留在右半，接缝处不多出一个转场', () => {
    const original = withTransition()
    const split = splitProjectAt(projectOf(original), original.id, 5.625, 'clip-b')!
    const [left, right] = split.clips
    expect(left.transitionOut).toBeUndefined()
    expect(right.transitionOut).toEqual({ type: 'fade', duration: 0.5 })
  })

  it('叠加轨分割：同样只在右半保留', () => {
    const original = withTransition()
    const project = overlayProjectOf(original)
    const split = splitOverlayClipAt(project, 'ov', original.id, 5.625, 'clip-b')!
    const clips = split.overlayTracks![0].clips
    expect(clips[0].transitionOut).toBeUndefined()
    expect(clips[1].transitionOut).toEqual({ type: 'fade', duration: 0.5 })
  })

  it('插入定格时被切开的两半，同样只在右半保留', () => {
    const original = withTransition()
    const insertion = insertFreezeAt(projectOf(original), 5.625, 'freeze-x', 2)!
    const clips = insertion.project.clips
    expect(clips[0].transitionOut).toBeUndefined()
    expect(clips[1].type).toBe('freeze')
    expect(clips[2].transitionOut).toEqual({ type: 'fade', duration: 0.5 })
  })

  it('右裁 / 左裁不改动出点转场（片段仍然直接接下一段）', () => {
    const original = withTransition()
    const trimmedLeft = trimProjectLeft(projectOf(original), original.id, 2.5)!.clips[0]
    expect(trimmedLeft.transitionOut).toEqual({ type: 'fade', duration: 0.5 })
    const trimmedRight = trimProjectRight(projectOf(original), original.id, 5.625)!.clips[0]
    expect(trimmedRight.transitionOut).toEqual({ type: 'fade', duration: 0.5 })
  })
})

describe('叠加轨分割 / 裁剪', () => {
  it('叠加轨分割：两半速度与时长守恒', () => {
    const original = curvedClip()
    const splitAt = clipTimelineDuration(original) / 2
    const split = splitOverlayClipAt(overlayProjectOf(original), 'ov', original.id, splitAt, 'clip-b')!
    const [left, right] = split.overlayTracks![0].clips
    expect(
      Math.abs(clipTimelineDuration(left) + clipTimelineDuration(right) - clipTimelineDuration(original)),
    ).toBeLessThan(DURATION_TOLERANCE)
    const boundary = clipSpanSourceAt(original, splitAt)
    expectSameSpeedsAtSameSource(original, left, 0, boundary)
    expectSameSpeedsAtSameSource(original, right, boundary, 10)
  })

  it('叠加轨左裁 / 右裁：时长与逐点速度正确', () => {
    const original = segmentedClip()
    const leftTrimmed = trimOverlayClipAt(overlayProjectOf(original), 'ov', original.id, 2.5, 'left')!
      .overlayTracks![0].clips[0]
    expect(
      Math.abs(clipTimelineDuration(leftTrimmed) - (clipTimelineDuration(original) - 2.5)),
    ).toBeLessThan(DURATION_TOLERANCE)
    const rightTrimmed = trimOverlayClipAt(overlayProjectOf(original), 'ov', original.id, 5.625, 'right')!
      .overlayTracks![0].clips[0]
    expectSameSpeedsAtSameSource(original, rightTrimmed, 0, clipSourceSpan(rightTrimmed).end)
  })
})

describe('拖动边缘：外扩按端点段速换算源增量', () => {
  it('分段片段右扩：源增量 = 时间轴增量 × 末端段速（4x → ×4）', () => {
    const original = segmentedClip()
    // 先右裁到 7.5s（时间轴 5.625s），再外扩 0.625s
    const trimmed = trimProjectRight(projectOf(original), original.id, 5.625)!.clips[0]
    expect(trimmed.sourceEnd).toBeCloseTo(7.5, 9)
    const grown = resizeClipEdge(projectOf(trimmed), trimmed.id, 'right', 0.625, 30)!.clips[0]
    // 0.625s 时间轴 × 末端 4x = 2.5s 源 → 回到 10s
    expect(grown.sourceEnd).toBeCloseTo(10, 9)
    expect(clipTimelineDuration(grown)).toBeCloseTo(clipTimelineDuration(trimmed) + 0.625, 9)
    // 外扩出来的尾巴仍然是 4x，前面的 1x 段不被拉伸
    expect(speedAtSource(grown, 9.9)).toBe(4)
    expect(speedAtSource(grown, 2.5)).toBe(1)
    expectSameSpeedsAtSameSource(original, grown, 0, 7.5)
  })

  it('曲线片段右扩：时长按增量增长，且不超过素材总长', () => {
    const original = curvedClip()
    const trimmed = trimProjectRight(projectOf(original), original.id, 2.5)!.clips[0]
    const before = clipTimelineDuration(trimmed)
    const grown = resizeClipEdge(projectOf(trimmed), trimmed.id, 'right', 0.5, 30)!.clips[0]
    expect(clipTimelineDuration(grown)).toBeCloseTo(before + 0.5, 6)
    // 素材本身只有 10s：再要 5s 也只能扩到素材末尾，不会越过 sourceDuration
    const clamped = resizeClipEdge(projectOf(grown), grown.id, 'right', 5, 10)!.clips[0]
    expect(clamped.sourceEnd).toBeCloseTo(10, 6)
  })

  it('分段片段左扩：按首段段速把源起点往回退', () => {
    const original = segmentedClip()
    // 左裁 2.5s（首段 1x，源起点 → 2.5）→ 再往回拉 2.5s
    const trimmed = trimProjectLeft(projectOf(original), original.id, 2.5)!.clips[0]
    expect(trimmed.sourceStart).toBeCloseTo(2.5, 9)
    const restored = resizeClipEdge(projectOf(trimmed), trimmed.id, 'left', -2.5, 30)!.clips[0]
    expect(restored.sourceStart).toBeCloseTo(0, 9)
    expect(restored.gapBefore).toBeCloseTo(0, 9)
    expect(clipTimelineDuration(restored)).toBeCloseTo(clipTimelineDuration(original), 6)
    expectSameSpeedsAtSameSource(original, restored, 0, 10)
  })

  it('定格片段右扩：停留时长按时长上限增长', () => {
    const freeze = createClip(SOURCE, 0, 3, { type: 'freeze', freezeFrameTime: 1 }, 'freeze-a')
    const grown = resizeClipEdge(projectOf(freeze), freeze.id, 'right', 1, 30)!.clips[0]
    expect(grown.sourceEnd).toBeCloseTo(4, 9)
    expect(clipTimelineDuration(grown)).toBeCloseTo(4, 9)
  })

  it('纯倍率片段右扩：1s 时间轴消耗 2s 源（2x）', () => {
    const sped = video({ speed: 2 }, 0, 6)
    const grown = resizeClipEdge(projectOf(sped), sped.id, 'right', 1, 30)!.clips[0]
    expect(grown.sourceEnd).toBeCloseTo(8, 9)
    expect(clipTimelineDuration(grown)).toBeCloseTo(clipTimelineDuration(sped) + 1, 9)
  })

  it('叠加轨分段片段右扩同样生效', () => {
    const original = segmentedClip()
    const trimmed = trimOverlayClipAt(overlayProjectOf(original), 'ov', original.id, 5.625, 'right')!
      .overlayTracks![0].clips[0]
    const grown = resizeOverlayClipEdge(overlayProjectOf(trimmed), 'ov', trimmed.id, 'right', 0.625, 30)!
      .overlayTracks![0].clips[0]
    expect(grown.sourceEnd).toBeCloseTo(10, 9)
    expect(clipTimelineDuration(grown)).toBeCloseTo(clipTimelineDuration(trimmed) + 0.625, 6)
  })
})

describe('拖动边缘：内收后速度仍锚定在源时刻上', () => {
  it('右边缘内收：等效右裁，速度不变', () => {
    const original = segmentedClip()
    const resized = resizeClipEdge(projectOf(original), original.id, 'right', -0.625, 30)!.clips[0]
    expect(resized.sourceEnd).toBeCloseTo(7.5, 9)
    expectSameSpeedsAtSameSource(original, resized, 0, 7.5)
  })

  it('左边缘内收：等效左裁，速度不变', () => {
    const original = curvedClip()
    const delta = 2 // 时间轴前 2s
    const boundary = clipSpanSourceAt(original, delta)
    const resized = resizeClipEdge(projectOf(original), original.id, 'left', delta, 30)!.clips[0]
    expect(resized.sourceStart).toBeCloseTo(boundary, 6)
    expectSameSpeedsAtSameSource(original, resized, boundary, 10)
  })

  it('叠加轨拖右边缘内收：速度不变', () => {
    const original = segmentedClip()
    const project = overlayProjectOf(original)
    const resized = resizeOverlayClipEdge(project, 'ov', original.id, 'right', -0.625, 30)!
    expectSameSpeedsAtSameSource(original, resized.overlayTracks![0].clips[0], 0, 7.5)
  })
})