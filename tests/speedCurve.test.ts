import { describe, expect, it } from 'vitest'
import {
  SPEED_CURVE_POINT_MAX,
  SPEED_CURVE_POINT_MIN,
  SPEED_CURVE_SAMPLES,
  createFlatSpeedCurve,
  evalSpeedCurve,
  hasSpeedVariation,
  normalizeSpeedCurve,
  sampleSpeedCurve,
  segmentPlan,
  speedSegmentedVideoFilter,
} from '../src/editor/core/speed'
import {
  clipLocalAt,
  clipSpanSourceAt,
  clipTimelineDuration,
} from '../src/editor/core/clipTime'
import {
  captureSpeedAttrs,
  speedAttrsPatch,
} from '../src/editor/core/attributeClipboard'
import { createPasteSpeedAttributesCommand } from '../src/editor/core/commands'
import { replaceClipSourceInProject } from '../src/editor/core/reverse'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Clip, Project, SpeedSegment } from '../src/editor/core/types'

const SAMPLE_POINTS = 200

const videoClip = (
  id: string,
  sourceStart = 0,
  sourceEnd = 10,
  overrides: Partial<Clip> = {},
): Clip => createClip('blob:curve', sourceStart, sourceEnd, overrides, id)

const curve = (...points: SpeedSegment[]): SpeedSegment[] => points

/** 采样 0…1 的 n 个曲线值（用于检查单调性 / 过冲）。 */
const sampleAll = (points: SpeedSegment[], count = SAMPLE_POINTS): number[] =>
  Array.from({ length: count + 1 }, (_, index) => evalSpeedCurve(points, index / count)!)

describe('单调三次插值：evalSpeedCurve', () => {
  it('控制点处取到精确值，两端按端点常量延拓', () => {
    const points = curve({ at: 0, speed: 1 }, { at: 0.5, speed: 4 }, { at: 1, speed: 1 })
    expect(evalSpeedCurve(points, 0)).toBeCloseTo(1, 9)
    expect(evalSpeedCurve(points, 0.5)).toBeCloseTo(4, 9)
    expect(evalSpeedCurve(points, 1)).toBeCloseTo(1, 9)
    // 超出控制点范围 → 端点值（与旧实现的线性延拓一致）
    expect(evalSpeedCurve(points, -5)).toBeCloseTo(1, 9)
    expect(evalSpeedCurve(points, 5)).toBeCloseTo(1, 9)
  })

  it('只有 2 个控制点时退化为直线（与旧采样完全一致）', () => {
    const points = curve({ at: 0, speed: 1 }, { at: 1, speed: 8 })
    for (let index = 0; index <= 20; index += 1) {
      const at = index / 20
      expect(evalSpeedCurve(points, at)).toBeCloseTo(1 + at * 7, 9)
    }
  })

  it('不产生过冲：峰值就是控制点速度，中间不会冲过头', () => {
    const points = curve({ at: 0, speed: 1 }, { at: 0.5, speed: 4 }, { at: 1, speed: 1 })
    const values = sampleAll(points)
    expect(Math.max(...values)).toBeLessThanOrEqual(4 + 1e-9)
    expect(Math.min(...values)).toBeLessThanOrEqual(1 + 1e-9)
    expect(Math.min(...values)).toBeGreaterThan(1 - 1e-9)
    // 峰值确实在中点附近出现（曲线是「钟形」而不是直线尖角）
    const peakIndex = values.indexOf(Math.max(...values))
    expect(peakIndex / SAMPLE_POINTS).toBeGreaterThan(0.4)
    expect(peakIndex / SAMPLE_POINTS).toBeLessThan(0.6)
  })

  it('控制点处一阶导数连续（原来的线性插值会有折角）', () => {
    const points = curve({ at: 0, speed: 1 }, { at: 0.5, speed: 4 }, { at: 1, speed: 1 })
    const h = 1e-4
    const leftSlope = (evalSpeedCurve(points, 0.5)! - evalSpeedCurve(points, 0.5 - h)!) / h
    const rightSlope = (evalSpeedCurve(points, 0.5 + h)! - evalSpeedCurve(points, 0.5)!) / h
    // 单调三次插值：两侧斜率接近；线性插值这里会是 +6 / -6。
    expect(Math.abs(leftSlope - rightSlope)).toBeLessThan(0.5)
    expect(Math.abs(leftSlope)).toBeLessThan(0.5)
  })

  it('控制点单调递增 / 递减时，采样也严格单调', () => {
    const rising = curve(
      { at: 0, speed: 1 },
      { at: 0.3, speed: 1.5 },
      { at: 0.6, speed: 3 },
      { at: 1, speed: 8 },
    )
    const risingValues = sampleAll(rising)
    for (let index = 1; index < risingValues.length; index += 1) {
      expect(risingValues[index]).toBeGreaterThan(risingValues[index - 1])
    }
    const falling = curve(
      { at: 0, speed: 8 },
      { at: 0.4, speed: 2 },
      { at: 1, speed: 0.5 },
    )
    const fallingValues = sampleAll(falling)
    for (let index = 1; index < fallingValues.length; index += 1) {
      expect(fallingValues[index]).toBeLessThan(fallingValues[index - 1])
    }
  })

  it('非法 / 单点 / 空曲线：返回 undefined 或单点值', () => {
    expect(evalSpeedCurve(undefined, 0.5)).toBeUndefined()
    expect(evalSpeedCurve([], 0.5)).toBeUndefined()
    expect(evalSpeedCurve('nope', 0.5)).toBeUndefined()
    expect(evalSpeedCurve([{ at: 0.5, speed: 2 }], 0)).toBe(2)
  })

  it('速度始终夹在 0.1–10（越界控制点 + 采样）', () => {
    const points = curve(
      { at: 0, speed: 0.0001 },
      { at: 0.5, speed: 99 },
      { at: 1, speed: 0.0002 },
    )
    for (const value of sampleAll(points)) {
      expect(value).toBeGreaterThanOrEqual(0.1 - 1e-9)
      expect(value).toBeLessThanOrEqual(10 + 1e-9)
    }
  })

  it('相同 at 的控制点不会产生零宽区间 / NaN', () => {
    const points = curve(
      { at: 0, speed: 1 },
      { at: 0.5, speed: 2 },
      { at: 0.5, speed: 3 },
      { at: 1, speed: 1 },
    )
    const values = sampleAll(points)
    for (const value of values) expect(Number.isFinite(value)).toBe(true)
  })
})

describe('采样：sampleSpeedCurve 接口不变', () => {
  it('返回 16 段、at = i/16，段速来自单调三次插值', () => {
    const points = curve({ at: 0, speed: 1 }, { at: 1, speed: 8 })
    const sampled = sampleSpeedCurve(points, SPEED_CURVE_SAMPLES)!
    expect(sampled).toHaveLength(SPEED_CURVE_SAMPLES)
    sampled.forEach((segment, index) => {
      expect(segment.at).toBeCloseTo(index / SPEED_CURVE_SAMPLES, 9)
      expect(segment.speed).toBeCloseTo(evalSpeedCurve(points, segment.at)!, 9)
    })
  })

  it('平坦曲线采样后每段都是 1x', () => {
    const sampled = sampleSpeedCurve(createFlatSpeedCurve(1))!
    for (const segment of sampled) expect(segment.speed).toBeCloseTo(1, 9)
  })

  it('曲线参与段计划与导出 setpts（与分段同一条链路）', () => {
    const clip = videoClip('c1', 0, 10, {
      speedCurve: curve({ at: 0, speed: 1 }, { at: 0.5, speed: 4 }, { at: 1, speed: 1 }),
    })
    const plan = segmentPlan(clip)!
    expect(plan.length).toBeGreaterThanOrEqual(2)
    // 时钟：峰值 4x 处推进最快，两端的段更慢 → 时长明显短于 10s、长于 2.5s
    const duration = clipTimelineDuration(clip)
    expect(duration).toBeGreaterThan(2.5)
    expect(duration).toBeLessThan(10)
    expect(speedSegmentedVideoFilter(clip)).toContain("setpts='if(")
  })

  it('显式 speedSegments 优先于 speedCurve', () => {
    const clip = videoClip('c2', 0, 10, {
      speedSegments: curve({ at: 0, speed: 2 }, { at: 0.5, speed: 2 }),
      speedCurve: curve({ at: 0, speed: 1 }, { at: 1, speed: 1 }),
    })
    expect(segmentPlan(clip)![0].speed).toBe(2)
  })

  it('控制点数量约束覆盖 3–5 个点', () => {
    expect(SPEED_CURVE_POINT_MIN).toBe(3)
    expect(SPEED_CURVE_POINT_MAX).toBe(5)
    expect(createFlatSpeedCurve()).toHaveLength(SPEED_CURVE_POINT_MIN)
    // 归一化不会因为点多而丢点（上限是 5 个控制点，采样段上限是 24）
    const five = curve(
      { at: 0, speed: 1 },
      { at: 0.25, speed: 2 },
      { at: 0.5, speed: 1 },
      { at: 0.75, speed: 2 },
      { at: 1, speed: 1 },
    )
    expect(normalizeSpeedCurve(five)).toHaveLength(5)
  })
})

describe('倒放 + 分段 / 曲线：先正向映射再镜像', () => {
  const segmented = () =>
    videoClip('seg', 4, 14, {
      speedSegments: curve({ at: 0, speed: 2 }, { at: 0.5, speed: 0.5 }),
    })
  const curved = () =>
    videoClip('curve', 4, 14, {
      speedCurve: curve({ at: 0, speed: 0.5 }, { at: 0.5, speed: 3 }, { at: 1, speed: 1 }),
    })

  it('倒放 = 正向映射后关于源区间镜像', () => {
    const clip = segmented()
    const total = clipTimelineDuration(clip)
    for (const local of [0, 1.25, 2.5, 5, 9, total]) {
      const forward = clipSpanSourceAt(clip, local)
      const reversed = clipSpanSourceAt(clip, local, { reversed: true })
      expect(reversed).toBeCloseTo(clip.sourceEnd - (forward - clip.sourceStart), 9)
    }
  })

  it('倒放时从 sourceEnd 起步、向 sourceStart 单调递减，且不越界', () => {
    const clip = curved()
    const total = clipTimelineDuration(clip)
    expect(clipSpanSourceAt(clip, 0, { reversed: true })).toBeCloseTo(clip.sourceEnd, 9)
    expect(clipSpanSourceAt(clip, total, { reversed: true })).toBeCloseTo(clip.sourceStart, 6)
    let previous = Number.POSITIVE_INFINITY
    for (let step = 0; step <= 50; step += 1) {
      const value = clipSpanSourceAt(clip, (total * step) / 50, { reversed: true })
      expect(value).toBeLessThanOrEqual(clip.sourceEnd + 1e-9)
      expect(value).toBeGreaterThanOrEqual(clip.sourceStart - 1e-9)
      expect(value).toBeLessThanOrEqual(previous + 1e-9)
      previous = value
    }
  })

  it('时长与是否倒放无关（倒放只翻内容，不改速度曲线）', () => {
    for (const clip of [segmented(), curved()]) {
      const forward = clipTimelineDuration(clip)
      expect(clipTimelineDuration(clip, { reversed: true })).toBeCloseTo(forward, 9)
    }
  })

  it('倒放下的正向 / 反向映射自洽（clipLocalAt 是 clipSpanSourceAt 的逆）', () => {
    for (const clip of [segmented(), curved()]) {
      const total = clipTimelineDuration(clip)
      for (const local of [0, 0.5, total / 3, total / 2, total * 0.9]) {
        const source = clipSpanSourceAt(clip, local, { reversed: true })
        expect(clipLocalAt(clip, source, { reversed: true })).toBeCloseTo(local, 6)
      }
    }
  })

  it('正向（不倒放）下分段 / 曲线的正反映射同样自洽', () => {
    const clip = segmented()
    const total = clipTimelineDuration(clip)
    for (const local of [0, 0.75, 2.5, 4, total]) {
      const source = clipSpanSourceAt(clip, local)
      expect(clipLocalAt(clip, source)).toBeCloseTo(local, 6)
    }
  })

  it('换倒放素材（replaceClipSourceInProject）保留曲线 / 分段与时长', () => {
    const clip = curved()
    const project: Project = {
      ...createInitialProject({ url: 'blob:curve', duration: 30 }, clip.id),
      clips: [clip],
    }
    const reversed = replaceClipSourceInProject(project, {
      clipId: clip.id,
      sourceUrl: 'blob:curve-reversed',
      // 倒放素材里同一段内容的区间（时长相同）
      sourceStart: 16,
      sourceEnd: 26,
    })
    const next = reversed.clips[0]
    expect(next.sourceUrl).toBe('blob:curve-reversed')
    expect(next.speedCurve).toEqual(clip.speedCurve)
    expect(next.speedSegments).toBeUndefined()
    // 关键：曲线定义在「片段进度」上，倒放不翻转控制点，时长保持不变。
    expect(clipTimelineDuration(next)).toBeCloseTo(clipTimelineDuration(clip), 9)
    expect(segmentPlan(next)!.map((segment) => segment.speed)).toEqual(
      segmentPlan(clip)!.map((segment) => segment.speed),
    )
    // 显示帧在倒放素材自己的坐标系里正向推进（不叠加第二次镜像）。
    expect(clipSpanSourceAt(next, 0)).toBeCloseTo(16, 9)
  })
})

describe('预览静音判定：hasSpeedVariation', () => {
  it('平坦曲线（3 点全 1x）不算变速，也不改时长', () => {
    const clip = videoClip('flat', 0, 10, { speedCurve: createFlatSpeedCurve(1) })
    expect(hasSpeedVariation(clip)).toBe(false)
    // 采样出的 16 段全是 1x → 时长仍是 10s（与没有曲线一致）
    expect(clipTimelineDuration(clip)).toBeCloseTo(10, 6)
  })

  it('曲线里存在非 1x 段 → 需要静音', () => {
    const clip = videoClip('vary', 0, 10, {
      speedCurve: curve({ at: 0, speed: 1 }, { at: 1, speed: 2 }),
    })
    expect(hasSpeedVariation(clip)).toBe(true)
  })

  it('普通片段与单段分段都不算变速', () => {
    expect(hasSpeedVariation(videoClip('plain', 0, 10, { speed: 2 }))).toBe(false)
    expect(
      hasSpeedVariation(videoClip('one', 0, 10, { speedSegments: curve({ at: 0, speed: 3 }) })),
    ).toBe(false)
  })
})

describe('变速属性剪贴板：speed / speedSegments / speedCurve', () => {
  it('复制曲线片段：带 speed / keepPitch / speedCurve，不带 speedSegments', () => {
    const clip = videoClip('a', 0, 10, {
      speed: 1.5,
      keepPitch: false,
      speedCurve: curve({ at: 0, speed: 1 }, { at: 1, speed: 3 }),
    })
    const attrs = captureSpeedAttrs(clip)
    expect(attrs.speed).toBeCloseTo(1.5, 9)
    expect(attrs.keepPitch).toBe(false)
    expect(attrs.speedCurve).toEqual([
      { at: 0, speed: 1 },
      { at: 1, speed: 3 },
    ])
    expect(attrs.speedSegments).toBeUndefined()
  })

  it('复制分段片段：带 speedSegments，不带 speedCurve', () => {
    const clip = videoClip('b', 0, 10, {
      speedSegments: curve({ at: 0, speed: 2 }, { at: 0.5, speed: 0.5 }),
    })
    const attrs = captureSpeedAttrs(clip)
    expect(attrs.speedSegments).toHaveLength(2)
    expect(attrs.speedCurve).toBeUndefined()
  })

  it('补丁里分段与曲线互斥（没有的那一路显式清空）', () => {
    const patch = speedAttrsPatch(captureSpeedAttrs(
      videoClip('c', 0, 10, { speedCurve: curve({ at: 0, speed: 1 }, { at: 1, speed: 2 }) }),
    ))
    expect(patch.speedCurve).toHaveLength(2)
    expect(patch.speedSegments).toBeUndefined()
    expect(patch.speed).toBe(1)
    expect(patch.keepPitch).toBe(true)
  })

  it('粘贴变速：曲线覆盖目标旧分段（不是叠加）', () => {
    const source = videoClip('src', 0, 10, {
      speedCurve: curve({ at: 0, speed: 0.5 }, { at: 1, speed: 2 }),
    })
    const target = videoClip('dst', 0, 8, {
      speedSegments: curve({ at: 0, speed: 4 }, { at: 0.5, speed: 4 }),
    })
    const project: Project = {
      ...createInitialProject({ url: 'blob:curve', duration: 30 }, source.id),
      clips: [source, target],
    }
    const command = createPasteSpeedAttributesCommand(
      [target.id],
      captureSpeedAttrs(source),
    )
    const next = command.execute(project)
    const pasted = next.clips[1]
    expect(pasted.speedCurve).toEqual([
      { at: 0, speed: 0.5 },
      { at: 1, speed: 2 },
    ])
    expect(pasted.speedSegments).toBeUndefined()
    // 分段被清掉后，目标片段的段速来自曲线而不是旧的 4x
    expect(segmentPlan(pasted)![0].speed).toBeCloseTo(0.5, 6)
  })

  it('粘贴变速跳过定格片段（避免偷改停留时长）', () => {
    const source = videoClip('src2', 0, 10, { speed: 2 })
    const freeze = videoClip('freeze', 0, 4, { type: 'freeze', freezeFrameTime: 1 })
    const project: Project = {
      ...createInitialProject({ url: 'blob:curve', duration: 30 }, source.id),
      clips: [source, freeze],
    }
    const command = createPasteSpeedAttributesCommand(
      [freeze.id],
      captureSpeedAttrs(source),
    )
    const next = command.execute(project)
    expect(next).toBe(project)
    expect(next.clips[1].speed).toBeUndefined()
    expect(clipTimelineDuration(next.clips[1])).toBeCloseTo(4, 9)
  })

  it('倒放片段的变速属性可以原样复制 / 粘贴（曲线不因倒放而变）', () => {
    const clip = videoClip('r', 0, 10, {
      speedCurve: curve({ at: 0, speed: 1 }, { at: 0.4, speed: 3 }, { at: 1, speed: 1 }),
    })
    const project: Project = {
      ...createInitialProject({ url: 'blob:curve', duration: 30 }, clip.id),
      clips: [clip],
    }
    const reversed = replaceClipSourceInProject(project, {
      clipId: clip.id,
      sourceUrl: 'blob:curve-reversed',
      sourceStart: 5,
      sourceEnd: 15,
    }).clips[0]
    const attrs = captureSpeedAttrs(reversed)
    expect(attrs.speedCurve).toEqual(captureSpeedAttrs(clip).speedCurve)
    const restored = replaceClipSourceInProject(
      { ...project, clips: [reversed] },
      {
        clipId: reversed.id,
        sourceUrl: 'blob:curve',
        sourceStart: 0,
        sourceEnd: 10,
      },
    )
    expect(restored.clips[0].speedCurve).toEqual(attrs.speedCurve)
  })
})