import { describe, expect, it } from 'vitest'
import {
  clampTransitionDuration,
  clipTransitionOut,
  hasTransitionPair,
  maxTransitionDuration,
  normalizeTransitionType,
  resolveTransitionDuration,
  TRANSITION_GROUPS,
  transitionLabel,
  transitionProgress,
  TRANSITION_MAX_DURATION,
  TRANSITION_MIN_DURATION,
  TRANSITION_TYPES,
  transitionDurationFromDrag,
} from '../src/editor/core/transition'
import { getProjectDuration, getTimeline, segmentsAt } from '../src/editor/core/timeline'
import { buildExportPlan } from '../src/editor/core/exportPlan'
import { createClip, createInitialProject } from '../src/editor/core/operations'
import { createSetTransitionCommand } from '../src/editor/core/commands'
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

describe('时间轴拖转场时长', () => {
  it('像素位移按 pps 换算并夹到上下限', () => {
    expect(transitionDurationFromDrag(0.4, 20, 100, 2)).toBeCloseTo(0.6)
    expect(transitionDurationFromDrag(0.4, -100, 100, 2)).toBe(TRANSITION_MIN_DURATION)
    expect(transitionDurationFromDrag(0.4, 10_000, 100, 1)).toBe(1)
  })

  it('非法 pps/位移/上限不产生 NaN', () => {
    expect(transitionDurationFromDrag(0.4, 0, 0, 2)).toBeCloseTo(0.4)
    expect(transitionDurationFromDrag(0.4, Number.NaN, 100, 2)).toBeCloseTo(0.4)
    expect(transitionDurationFromDrag(0.4, 0, 100, Number.NaN)).toBeCloseTo(0.4)
  })
})

describe('空隙 + 转场：同一步原子完成', () => {
  it('设置转场时自动闭合空隙，且重复执行是 no-op', () => {
    const before = twoClips(undefined, 0.5)
    const command = createSetTransitionCommand('c1', 'c2', {
      type: 'fade',
      duration: 0.4,
    })
    const after = command.execute(before)
    expect(clipTransitionOut(after.clips[0])).toMatchObject({ type: 'fade', duration: 0.4 })
    expect(after.clips[1].gapBefore).toBe(0)
    // 片段自身时长/源区间不变（只是把空隙收掉）
    expect(after.clips[0].sourceEnd).toBe(before.clips[0].sourceEnd)
    expect(after.clips[1].sourceEnd).toBe(before.clips[1].sourceEnd)
    expect(command.execute(after)).toBe(after)
  })
})

describe('转场类型与时长夹取', () => {
  it('历史五种类型仍然存在且中文名不变', () => {
    // 兼容性：旧草稿里的这五个值必须继续可用（分组后位置可以变，值不能变）。
    const values = TRANSITION_TYPES.map((item) => item.value)
    for (const legacy of ['fade', 'fadeblack', 'wipeleft', 'slideleft', 'circleopen']) {
      expect(values).toContain(legacy)
    }
    expect(normalizeTransitionType('fadeblack')).toBe('fadeblack')
    expect(transitionLabel('fadeblack')).toBe('黑场过渡')
  })

  it('新增类型齐全、分组完整、中文名不重复', () => {
    const values = TRANSITION_TYPES.map((item) => item.value)
    expect(new Set(values).size).toBe(values.length)
    const labels = TRANSITION_TYPES.map((item) => item.label)
    expect(new Set(labels).size).toBe(labels.length)
    // 每个分组都非空，且顺序与 TRANSITION_GROUPS 一致。
    const groupsInOrder = values.map(
      (value) => TRANSITION_TYPES.find((item) => item.value === value)!.group,
    )
    const seen: string[] = []
    for (const group of groupsInOrder) if (seen.at(-1) !== group) seen.push(group)
    expect(seen).toEqual(TRANSITION_GROUPS.map((group) => group.id))
    for (const group of TRANSITION_GROUPS) {
      expect(values.filter((value) => TRANSITION_TYPES.find((i) => i.value === value)!.group === group.id).length)
        .toBeGreaterThan(0)
    }
    // 覆盖本次新增的全部 xfade 名称。
    for (const type of [
      'fadewhite', 'fadegrays',
      'wiperight', 'wipeup', 'wipedown',
      'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
      'slideright', 'slideup', 'slidedown',
      'circleclose', 'circlecrop', 'rectcrop',
      'vertopen', 'vertclose', 'horzopen', 'horzclose', 'radial',
      'dissolve', 'pixelize', 'hblur', 'zoomin', 'squeezeh', 'squeezev',
    ]) {
      expect(values).toContain(type)
    }
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