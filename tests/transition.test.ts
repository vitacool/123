import { describe, expect, it } from 'vitest'
import {
  clampTransitionDuration,
  clipTransitionOut,
  hasTransitionPair,
  maxTransitionDuration,
  normalizeTransitionType,
  resolveTransitionDuration,
  transitionLabel,
  transitionProgress,
  TRANSITION_MAX_DURATION,
  TRANSITION_MIN_DURATION,
  TRANSITION_TYPES,
} from '../src/editor/core/transition'
import { getProjectDuration, getTimeline, segmentsAt } from '../src/editor/core/timeline'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import type { Clip, Project, SourceInfo } from '../src/editor/core/types'

const SOURCE: SourceInfo = {
  url: 'blob:v',
  name: 'v.mp4',
  size: 1_000_000,
  duration: 20,
  width: 1920,
  height: 1080,
}

function twoClips(transition?: Clip['transitionOut'], gap = 0): Project {
  const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c1')
  return {
    ...base,
    clips: [
      createClip(SOURCE.url, 0, 10, transition ? { transitionOut: transition } : {}, 'c1'),
      createClip(SOURCE.url, 10, 20, { gapBefore: gap }, 'c2'),
    ],
  }
}

describe('转场类型与时长夹取', () => {
  it('五种类型齐全，含中文名', () => {
    expect(TRANSITION_TYPES.map((item) => item.value)).toEqual([
      'fade',
      'fadeblack',
      'wipeleft',
      'slideleft',
      'circleopen',
    ])
    expect(transitionLabel('fadeblack')).toBe('黑场过渡')
  })

  it('非法类型回退 fade', () => {
    expect(normalizeTransitionType('nope')).toBe('fade')
    expect(normalizeTransitionType(undefined)).toBe('fade')
    expect(normalizeTransitionType('wipeleft')).toBe('wipeleft')
  })

  it('时长夹在 0.1–2s', () => {
    expect(clampTransitionDuration(0.01)).toBe(TRANSITION_MIN_DURATION)
    expect(clampTransitionDuration(9)).toBe(TRANSITION_MAX_DURATION)
    expect(clampTransitionDuration(0.8)).toBe(0.8)
    expect(clampTransitionDuration(Number.NaN)).toBe(TRANSITION_MIN_DURATION)
  })

  it('clipTransitionOut 规范化返回值', () => {
    expect(clipTransitionOut(createClip('a', 0, 5))).toBeNull()
    expect(clipTransitionOut(createClip('a', 0, 5, { transitionOut: { type: 'fade', duration: 9 } }))).toEqual(
      { type: 'fade', duration: TRANSITION_MAX_DURATION },
    )
  })
})

describe('转场可用性', () => {
  it('最大时长受较短片段一半限制', () => {
    // 两侧 10s → 上限 min(2, 5) = 2
    expect(maxTransitionDuration(createClip('a', 0, 10), createClip('b', 0, 10))).toBe(2)
    // 短边 2s → 上限 1
    expect(maxTransitionDuration(createClip('a', 0, 10), createClip('b', 0, 2))).toBe(1)
    // 短边 0.1s → 放不下
    expect(maxTransitionDuration(createClip('a', 0, 10), createClip('b', 0, 0.1))).toBe(0)
  })

  it('有 gapBefore 时禁用', () => {
    const left = createClip('a', 0, 10, { transitionOut: { type: 'fade', duration: 1 } })
    const right = createClip('b', 10, 20)
    expect(resolveTransitionDuration(left, right, 0)).toBe(1)
    expect(resolveTransitionDuration(left, right, 0.5)).toBe(0)
  })

  it('定格片段不参与转场', () => {
    const left = createClip('a', 0, 10, { transitionOut: { type: 'fade', duration: 1 } })
    const freeze = createClip('b', 0, 10, { type: 'freeze' })
    expect(resolveTransitionDuration(left, freeze, 0)).toBe(0)
  })

  it('hasTransitionPair 与 gap 状态一致', () => {
    const left = createClip('a', 0, 10)
    const right = createClip('b', 10, 20)
    expect(hasTransitionPair(left, right, 0)).toBe(true)
    expect(hasTransitionPair(left, right, 1)).toBe(false)
    expect(hasTransitionPair(left, null, 0)).toBe(false)
  })

  it('transitionProgress 线性 0→1', () => {
    expect(transitionProgress(4, 5, 4)).toBe(0)
    expect(transitionProgress(4, 5, 4.5)).toBeCloseTo(0.5)
    expect(transitionProgress(4, 5, 5)).toBe(1)
    expect(transitionProgress(4, 4, 4)).toBe(1)
  })
})

describe('转场导致的总时长缩短', () => {
  it('无转场时两段首尾相接', () => {
    const project = twoClips()
    const timeline = getTimeline(project.clips)
    expect(timeline[1].start).toBe(10)
    expect(getProjectDuration(project.clips)).toBe(20)
  })

  it('1s 转场使后段提前 1s，总时长 20 → 19', () => {
    const project = twoClips({ type: 'fade', duration: 1 })
    const timeline = getTimeline(project.clips)
    expect(timeline[1].start).toBeCloseTo(9)
    expect(getProjectDuration(project.clips)).toBeCloseTo(19)
  })

  it('重叠区同时命中两段（segmentsAt）', () => {
    const project = twoClips({ type: 'fade', duration: 1 })
    const hit = segmentsAt(project.clips, 9.5)
    expect(hit).toHaveLength(2)
    expect(hit[0].clip.id).toBe('c1')
    expect(hit[1].clip.id).toBe('c2')
  })

  it('转场时长被上限收敛后，缩短量也随之收敛', () => {
    // 右侧只有 2s → 上限 1s，即使写 2s 也只重叠 1s
    const base = createInitialProject({ url: SOURCE.url, duration: 20 }, 'c1')
    const project: Project = {
      ...base,
      clips: [
        createClip(SOURCE.url, 0, 10, { transitionOut: { type: 'fade', duration: 2 } }, 'c1'),
        createClip(SOURCE.url, 10, 12, {}, 'c2'),
      ],
    }
    expect(getProjectDuration(project.clips)).toBeCloseTo(11)
  })
})

describe('导出的 xfade / acrossfade', () => {
  it('有转场时生成 xfade 与 acrossfade，并按重叠计算 offset', () => {
    const project = twoClips({ type: 'fade', duration: 1 })
    const plan = buildExportPlan(project, SOURCE, true)
    expect(plan.graph).toContain('xfade=transition=fade:duration=1:offset=9')
    expect(plan.graph).toContain('acrossfade=d=1')
    // 总时长缩短
    expect(plan.totalDuration).toBeCloseTo(19)
    // 不再使用整条 concat 拼接
    expect(plan.graph).not.toContain('concat=n=2:v=1:a=0[outv]')
  })

  it('各转场类型映射到对应 xfade transition', () => {
    const cases: Array<[Clip['transitionOut'], string]> = [
      [{ type: 'fadeblack', duration: 0.5 }, 'fadeblack'],
      [{ type: 'wipeleft', duration: 0.5 }, 'wipeleft'],
      [{ type: 'slideleft', duration: 0.5 }, 'slideleft'],
      [{ type: 'circleopen', duration: 0.5 }, 'circleopen'],
    ]
    for (const [transition, expected] of cases) {
      const plan = buildExportPlan(twoClips(transition), SOURCE, true)
      expect(plan.graph).toContain(`xfade=transition=${expected}`)
    }
  })

  it('无转场时保持原 concat 结构', () => {
    const plan = buildExportPlan(twoClips(), SOURCE, true)
    expect(plan.graph).toContain('concat=n=2:v=1:a=0')
    expect(plan.graph).not.toContain('xfade')
    expect(plan.graph).not.toContain('acrossfade')
  })
})