import { describe, expect, it } from 'vitest'
import {
  SPEED_SEGMENT_MAX,
  normalizeSpeedSegments,
  segmentPlan,
  segmentedTimelineDuration,
  SPEED_CURVE_SAMPLES,
  sampleSpeedCurve,
  speedAtTimelineTime,
  speedSegmentedVideoFilter,
} from '../src/editor/core/speed'
import { clipSpanSourceAt, clipTimelineDuration } from '../src/editor/core/clipTime'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { normalizeProjectSpeedSegments } from '../src/editor/core/draft'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Project, SourceInfo, SpeedSegment } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:speed-seg',
  name: 'src.mp4',
  size: 1_000_000,
  duration: 30,
  width: 1920,
  height: 1080,
}

const project = (clip: ReturnType<typeof createClip>): Project => ({
  ...createInitialProject({ url: SOURCE.url, duration: 30 }, clip.id),
  aspectRatio: '16:9',
  exportQuality: { resolution: '480p', fps: 30 },
  clips: [clip],
})

const clipWith = (segments: SpeedSegment[], sourceStart = 0, sourceEnd = 10) => ({
  ...createClip(SOURCE.url, sourceStart, sourceEnd, {}, 'c'),
  speedSegments: segments,
})

describe('分段参数归一化', () => {
  it('不足 2 段 / 非数组 → 视为没有分段', () => {
    expect(normalizeSpeedSegments(undefined)).toBeUndefined()
    expect(normalizeSpeedSegments([])).toBeUndefined()
    expect(normalizeSpeedSegments([{ at: 0, speed: 2 }])).toBeUndefined()
    expect(normalizeSpeedSegments('nope')).toBeUndefined()
  })

  it('排序、首段归零、段速夹取、间隔至少 1%', () => {
    const segments = normalizeSpeedSegments([
      { at: 0.9, speed: 99 },
      { at: 0.2, speed: 0.001 },
    ])!
    expect(segments[0]).toEqual({ at: 0, speed: 0.1 })
    // 第二段 0.9 与首段的间隔被保留，段速夹到上限 10
    expect(segments[1].at).toBeCloseTo(0.9, 6)
    expect(segments[1].speed).toBe(10)
  })

  it('段数上限（曲线采样需要更密）；最后一段不能从 1.0 开始', () => {
    // 30 段 > 上限 → 截到 SPEED_SEGMENT_MAX（24）
    const many = Array.from({ length: 30 }, (_, index) => ({ at: index / 30, speed: 2 }))
    expect(normalizeSpeedSegments(many)!).toHaveLength(SPEED_SEGMENT_MAX)
    expect(
      normalizeSpeedSegments([
        { at: 0, speed: 2 },
        { at: 1, speed: 2 },
      ]),
    ).toBeUndefined()
  })
})

describe('时长 = Σ(段源长 / 段速)', () => {
  it('两段：前半 2x、后半 0.5x', () => {
    // 源 0–10s，at=0.5 → 前 5s@2x = 2.5s，后 5s@0.5x = 10s → 总 12.5s
    const clip = clipWith([
      { at: 0, speed: 2 },
      { at: 0.5, speed: 0.5 },
    ])
    expect(clipTimelineDuration(clip)).toBeCloseTo(12.5, 6)
    expect(segmentedTimelineDuration(clip)).toBeCloseTo(12.5, 6)
  })

  it('三段 + 非零 sourceStart 时段的区间切分正确', () => {
    // 源 4–14（span 10），at 0/0.3/0.7 → 段长 3/4/3s
    const clip = clipWith(
      [
        { at: 0, speed: 1 },
        { at: 0.3, speed: 2 },
        { at: 0.7, speed: 4 },
      ],
      4,
      14,
    )
    const plan = segmentPlan(clip)!
    expect(plan.map((segment) => Number(segment.sourceStart.toFixed(4)))).toEqual([4, 7, 11])
    expect(plan.map((segment) => Number(segment.sourceEnd.toFixed(4)))).toEqual([7, 11, 14])
    // 3/1 + 4/2 + 3/4 = 3 + 2 + 0.75 = 5.75
    expect(clipTimelineDuration(clip)).toBeCloseTo(5.75, 6)
    expect(plan.map((segment) => Number(segment.timelineOffset.toFixed(4)))).toEqual([0, 3, 5])
  })

  it('没有分段时退化成原来的「总长 / speed」', () => {
    const clip = { ...createClip(SOURCE.url, 4, 14, {}, 'c'), speed: 2 }
    expect(clipTimelineDuration(clip)).toBeCloseTo(5, 6)
    expect(segmentedTimelineDuration(clip)).toBeNull()
  })

  it('单段（归一化后不足 2 段）不生效', () => {
    const clip = clipWith([{ at: 0, speed: 4 }])
    expect(clipTimelineDuration(clip)).toBeCloseTo(10, 6)
  })
})

describe('导出：分段 setpts 表达式', () => {
  it('两段生成嵌套 if() 的分段线性映射（不含 concat）', () => {
    const clip = clipWith([
      { at: 0, speed: 2 },
      { at: 0.5, speed: 0.5 },
    ])
    const filter = speedSegmentedVideoFilter(clip)!
    // 阈值 = 下一段在源区间内的起点（5s）；第二段的偏移 = 5/2 = 2.5s。
    expect(filter).toBe("setpts='if(lt(T,5),((T-0)/2),(2.5+(T-5)/0.5))/TB'")
    expect(filter).not.toContain('concat')
  })

  it('三段：偏移与分支顺序正确', () => {
    const clip = clipWith(
      [
        { at: 0, speed: 1 },
        { at: 0.3, speed: 2 },
        { at: 0.7, speed: 4 },
      ],
      4,
      14,
    )
    const filter = speedSegmentedVideoFilter(clip)!
    // 第二段从源相对 3s 起、偏移 3s；第三段从相对 7s 起、偏移 5s
    expect(filter).toContain('lt(T,3)')
    expect(filter).toContain('lt(T,7)')
    expect(filter).toContain('(3+(T-3)/2)')
    expect(filter).toContain('(5+(T-7)/4)')
  })

  it('graph 里分段片段用分段 setpts，且总时长按分段和', () => {
    const clip = clipWith([
      { at: 0, speed: 2 },
      { at: 0.5, speed: 0.5 },
    ])
    const plan = buildExportPlan(project(clip), SOURCE, true)
    expect(plan.graph).toContain('if(lt(')
    expect(plan.totalDuration).toBeCloseTo(12.5, 3)
  })

  it('没有分段的片段 graph 完全不含分段表达式（逐字不变）', () => {
    const clip = { ...createClip(SOURCE.url, 0, 10, {}, 'c'), speed: 2 }
    const plan = buildExportPlan(project(clip), SOURCE, true)
    expect(plan.graph).toContain('setpts=PTS/2')
    expect(plan.graph).not.toContain('if(lt(')
  })

  it('分段片段的音频逐段 atempo 后 concat（不再静音）', () => {
    const clip = clipWith([
      { at: 0, speed: 2 },
      { at: 0.5, speed: 0.5 },
    ])
    const plan = buildExportPlan(project(clip), SOURCE, true)
    // 两段各自 atrim + atempo，再 concat 成一条流
    expect(plan.graph).toContain('[outasg0]')
    expect(plan.graph).toContain('[outasg1]')
    expect(plan.graph).toContain('concat=n=2:v=0:a=1')
    expect(plan.graph).not.toContain('anullsrc')
    // 段内 atempo：2x → atempo=2；0.5x → atempo=0.5
    expect(plan.graph).toContain('atempo=2')
    expect(plan.graph).toContain('atempo=0.5')
  })
})
describe('时间映射：时间轴本地时间 → 源时间（分段反查）', () => {
  const segmented = () =>
    clipWith(
      [
        { at: 0, speed: 2 },
        { at: 0.5, speed: 0.5 },
      ],
      4,
      14,
    )

  it('段内线性：前半 2x（时间轴 0–2.5s ↔ 源 4–9s），后半 0.5x（2.5–12.5s ↔ 源 9–14s）', () => {
    const clip = segmented()
    expect(clipSpanSourceAt(clip, 0)).toBeCloseTo(4, 6)
    expect(clipSpanSourceAt(clip, 1.25)).toBeCloseTo(6.5, 6)
    expect(clipSpanSourceAt(clip, 2.5)).toBeCloseTo(9, 6)
    // 后半：时间轴 +2s（源 +1s）
    expect(clipSpanSourceAt(clip, 4.5)).toBeCloseTo(10, 6)
    // 末端夹取到 sourceEnd
    expect(clipSpanSourceAt(clip, 12.5)).toBeCloseTo(14, 6)
    expect(clipSpanSourceAt(clip, 99)).toBeCloseTo(14, 6)
  })

  it('与分段时长自洽：映射到末端正好等于 sourceEnd', () => {
    const clip = segmented()
    const total = clipTimelineDuration(clip)
    expect(clipSpanSourceAt(clip, total)).toBeCloseTo(clip.sourceEnd, 6)
  })

  it('倒放时以 sourceEnd 为起点镜像', () => {
    const clip = segmented()
    // 倒放由 options.reversed 标记（不是 speed 取负）。
    // 时间轴 0 → 源 14；时间轴 2.5（前半 2x 走完 5s）→ 源 9
    expect(clipSpanSourceAt(clip, 0, { reversed: true })).toBeCloseTo(14, 6)
    expect(clipSpanSourceAt(clip, 2.5, { reversed: true })).toBeCloseTo(9, 6)
  })

  it('显式传 options.speed 时忽略分段（与时长口径一致）', () => {
    const clip = segmented()
    expect(clipSpanSourceAt(clip, 1, { speed: 2 })).toBeCloseTo(6, 6)
  })

  it('没有分段时保持原行为', () => {
    const clip = { ...createClip(SOURCE.url, 4, 14, {}, 'c'), speed: 2 }
    expect(clipSpanSourceAt(clip, 1)).toBeCloseTo(6, 6)
  })
})

describe('预览播放速率：按段取倍率', () => {
  const clip = () =>
    clipWith(
      [
        { at: 0, speed: 2 },
        { at: 0.5, speed: 0.5 },
      ],
      0,
      10,
    )

  it('段内返回该段倍率，段边界切换', () => {
    const target = clip()
    // 前半（时间轴 0–2.5s）2x，后半（2.5–12.5s）0.5x
    expect(speedAtTimelineTime(target, 0)).toBe(2)
    expect(speedAtTimelineTime(target, 2.4)).toBe(2)
    expect(speedAtTimelineTime(target, 2.5)).toBe(0.5)
    expect(speedAtTimelineTime(target, 99)).toBe(0.5)
  })

  it('没有分段时返回 undefined（调用方回落到 clip.speed）', () => {
    expect(speedAtTimelineTime(createClip(SOURCE.url, 0, 10, {}, 'c'), 1)).toBeUndefined()
  })
})

describe('平滑曲线：采样成段表（复用分段链路）', () => {
  it('采样 16 段，段速按控制点线性插值', () => {
    const sampled = sampleSpeedCurve(
      [
        { at: 0, speed: 1 },
        { at: 1, speed: 8 },
      ],
      SPEED_CURVE_SAMPLES,
    )!
    expect(sampled).toHaveLength(SPEED_CURVE_SAMPLES)
    expect(sampled[0].speed).toBeCloseTo(1, 6)
    // 第 8 段起点 = 0.5 → 速度 4.5
    expect(sampled[8].speed).toBeCloseTo(4.5, 6)
    // 单调递增
    for (let index = 1; index < sampled.length; index += 1) {
      expect(sampled[index].speed).toBeGreaterThanOrEqual(sampled[index - 1].speed)
    }
  })

  it('段速夹到 0.1–10，控制点乱序也能处理', () => {
    const sampled = sampleSpeedCurve([
      { at: 1, speed: 99 },
      { at: 0, speed: 0.0001 },
    ])!
    // 首段取控制点起点的值（0.0001 → 夹到 0.1）；末段取 0.9375 处的插值（约 9.3），
    // 因为最后一段从 0.9375 开始，不会正好落在 at=1 的 10x 上。
    expect(sampled[0].speed).toBe(0.1)
    expect(sampled[sampled.length - 1].speed).toBeGreaterThan(8)
    expect(sampled[sampled.length - 1].speed).toBeLessThanOrEqual(10)
  })

  it('曲线参与时长与导出（无显式 speedSegments 时）', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 10, {}, 'c'),
      speedCurve: [
        { at: 0, speed: 1 },
        { at: 1, speed: 4 },
      ],
    }
    // 曲线均值约 2.5x → 时长明显小于 10s、大于 2.5s
    const duration = clipTimelineDuration(clip)
    expect(duration).toBeGreaterThan(2.5)
    expect(duration).toBeLessThan(10)
    const graph = buildExportPlan(project(clip), SOURCE, true).graph
    // 16 段 → 至少 15 层 if(lt(
    expect((graph.match(/if\(lt\(/g) ?? []).length).toBeGreaterThanOrEqual(15)
  })

  it('显式 speedSegments 优先于 speedCurve', () => {
    const clip = {
      ...createClip(SOURCE.url, 0, 10, {}, 'c'),
      speedSegments: [
        { at: 0, speed: 2 },
        { at: 0.5, speed: 2 },
      ],
      speedCurve: [
        { at: 0, speed: 1 },
        { at: 1, speed: 8 },
      ],
    }
    // 两段各 2x → 总时长 5s（曲线是 1→8x，会明显更短）
    expect(clipTimelineDuration(clip)).toBeCloseTo(5, 6)
  })

  it('空 / 非法曲线视为没有分段', () => {
    expect(sampleSpeedCurve(undefined)).toBeUndefined()
    expect(sampleSpeedCurve([])).toBeUndefined()
    expect(sampleSpeedCurve('nope')).toBeUndefined()
  })
})

describe('草稿归一化：变速分段 / 曲线', () => {
  it('非法段表被清空（视为无分段），合法段表保持引用', () => {
    const project = createInitialProject({ url: SOURCE.url, duration: 30 }, 'c')
    const plain = { ...createClip(SOURCE.url, 0, 10, {}, 'c') }
    const bad = { ...plain, speedSegments: [{ at: 0, speed: 100 }] }
    const good = {
      ...plain,
      speedSegments: [
        { at: 0, speed: 2 },
        { at: 0.5, speed: 0.5 },
      ],
    }
    const withBad = normalizeProjectSpeedSegments({ ...project, clips: [bad] })
    expect(withBad.clips[0].speedSegments).toBeUndefined()
    const withGood = normalizeProjectSpeedSegments({ ...project, clips: [good] })
    expect(withGood.clips[0].speedSegments).toEqual(good.speedSegments)
    expect(withGood.clips[0]).toBe(good)
  })

  it('曲线也被夹取；只有 1 段时清空', () => {
    const project = createInitialProject({ url: SOURCE.url, duration: 30 }, 'c')
    const clip = {
      ...createClip(SOURCE.url, 0, 10, {}, 'c'),
      speedCurve: [
        { at: 0, speed: 0.001 },
        { at: 1, speed: 99 },
      ],
    }
    const normalized = normalizeProjectSpeedSegments({ ...project, clips: [clip] })
    expect(normalized.clips[0].speedCurve![0].speed).toBe(0.1)
    expect(normalized.clips[0].speedCurve![1].speed).toBe(10)
  })
})
