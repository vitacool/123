import { describe, expect, it } from 'vitest'
import {
  KEYFRAME_DRAG_GAP,
  clampGroupDrag,
  clearPropertyKeyframes,
  findDuplicateProperty,
  keyframeUnion,
  moveKeyframes,
  pruneEmptyProperties,
  refsAtTime,
  setEasingOnKeyframes,
} from '../src/editor/core/keyframeEdit'
import {
  clearPropertyKeyframesInProject,
  moveKeyframesInProject,
  setKeyframeEasingInProject,
} from '../src/editor/core/keyframes'
import { createInitialProject } from '../src/editor/core/operations'
import type { AnimationMap, Clip, Easing, Keyframe, Project } from '../src/editor/core/types'

const key = (t: number, value: number, ease: Easing = 'linear'): Keyframe => ({ t, value, ease })

const ANIM: AnimationMap = {
  'position.x': [key(0, 0), key(0.5, 0.5), key(1, 0)],
  opacity: [key(0.5, 1)],
}

function projectWithAnim(anim: AnimationMap = ANIM): Project {
  const base = createInitialProject({ url: 'blob:x', duration: 10 }, 'c1')
  const clip: Clip = { ...base.clips[0], sourceEnd: 4, anim }
  return { ...base, clips: [clip] }
}

describe('关键帧并集（时间轴菱形）', () => {
  it('同一 t 的不同属性合并成一个点，按 t 升序', () => {
    const union = keyframeUnion(ANIM)
    expect(union.map((item) => item.t)).toEqual([0, 0.5, 1])
    expect(union[1].props.sort()).toEqual(['opacity', 'position.x'])
  })

  it('无 anim 返回空数组', () => {
    expect(keyframeUnion(undefined)).toEqual([])
    expect(keyframeUnion({})).toEqual([])
  })

  it('refsAtTime 展开该时刻所有属性的关键帧', () => {
    expect(refsAtTime(ANIM, 0.5).map((ref) => ref.prop).sort()).toEqual(['opacity', 'position.x'])
    expect(refsAtTime(ANIM, 0.25)).toEqual([])
  })
})

describe('拖动夹取（多选整体平移）', () => {
  it('不允许越过 0 / 1', () => {
    const selected = [{ prop: 'position.x' as const, t: 0 }, { prop: 'position.x' as const, t: 0.5 }]
    expect(clampGroupDrag(ANIM, selected, -0.3)).toBeCloseTo(0, 6) // 最早已贴 0
    const atEnd = [{ prop: 'position.x' as const, t: 1 }]
    expect(clampGroupDrag(ANIM, atEnd, 0.4)).toBeCloseTo(0, 6)
    // 中间时刻可以正常移动
    expect(clampGroupDrag(ANIM, [{ prop: 'position.x', t: 0.5 }], 0.2)).toBeCloseTo(0.2, 6)
  })

  it('不会与未选中的同属性关键帧重叠：向右夹到对方左侧 GAP 处', () => {
    // 选中 t=0.2（新建场景），目标 t=0.5 处有未选中帧
    const anim: AnimationMap = { 'position.x': [key(0.2, 0), key(0.5, 1)] }
    const selected = [{ prop: 'position.x' as const, t: 0.2 }]
    const clamped = clampGroupDrag(anim, selected, 0.3)
    // 拖动期只防「完全重合」：夹到对方左侧 KEYFRAME_DRAG_GAP（=0.0005）处
    expect(clamped).toBeCloseTo(0.5 - KEYFRAME_DRAG_GAP - 0.2, 6)
    // 向左同理
    const clampedLeft = clampGroupDrag(anim, [{ prop: 'position.x', t: 0.2 }], -0.19)
    expect(clampedLeft).toBeCloseTo(-0.19, 6)
  })

  it('选中项之间可以一起移动（互相不阻挡）', () => {
    const selected = [{ prop: 'position.x' as const, t: 0 }, { prop: 'position.x' as const, t: 0.5 }]
    // 0.5 处还有 opacity 的帧，但属性不同，不阻挡
    expect(clampGroupDrag(ANIM, selected, 0.25)).toBeCloseTo(0.25, 6)
  })
})

describe('唯一性校验（同属性 t 差 < 0.001 视为重复）', () => {
  it('moveKeyframes 保持 value/ease，只改 t', () => {
    const moved = moveKeyframes(ANIM, [{ prop: 'position.x', t: 0 }, { prop: 'position.x', t: 1 }], 0.1)
    // 只选中 0 与 1，中间的 0.5 未选中 → 原地不动
    expect(moved?.['position.x']?.map((k) => Number(k.t.toFixed(3)))).toEqual([0.1, 0.5, 1])
    expect(moved?.['position.x']?.map((k) => k.value)).toEqual([0, 0.5, 0])
  })

  it('同属性出现重复时 findDuplicateProperty 能识别', () => {
    expect(findDuplicateProperty({ 'position.x': [key(0.5, 0), key(0.5005, 1)] })).toBe('position.x')
    expect(findDuplicateProperty({ 'position.x': [key(0.5, 0), key(0.6, 1)] })).toBeNull()
    // 不同属性之间允许相同 t
    expect(findDuplicateProperty(ANIM)).toBeNull()
  })

  it('项目级移动：重复时返回 null（调用方 Toast 并回到拖动前）', () => {
    const project = projectWithAnim({ 'position.x': [key(0.3, 0), key(0.4, 1)] })
    // 拖到与 0.4 相差 0.0005 处 → 夹到 0.4005，但 0.0005 < 0.001 → 提交时被判重复并拒绝（验收 #4）
    const rejected = moveKeyframesInProject(project, 'c1', [{ prop: 'position.x', t: 0.3 }], 0.1)
    expect(rejected).toBeNull()
    // 拖到一个合法距离（0.35）则成功
    const ok = moveKeyframesInProject(project, 'c1', [{ prop: 'position.x', t: 0.3 }], 0.05)
    expect(ok).not.toBeNull()
    expect(ok!.clips[0].anim?.['position.x']?.map((k) => Number(k.t.toFixed(4)))).toEqual([0.35, 0.4])

    // 守卫：数据本身已经重复（例如外部写入/舍入）时，移动被拒绝 → 调用方 Toast 并回退
    const duplicated = projectWithAnim({ 'position.x': [key(0.3, 0), key(0.3005, 1), key(0.5, 0)] })
    expect(moveKeyframesInProject(duplicated, 'c1', [{ prop: 'position.x', t: 0.5 }], 0.1)).toBeNull()

    // 左移到底（t 正好落到 0）是合法移动
    const toZero = moveKeyframesInProject(project, 'c1', [{ prop: 'position.x', t: 0.3 }], -0.3)
    expect(toZero?.clips[0].anim?.['position.x']?.map((k) => Number(k.t.toFixed(3)))).toEqual([0, 0.4])
    // 位移为 0 时不写历史
    expect(moveKeyframesInProject(project, 'c1', [{ prop: 'position.x', t: 0.3 }], 0)).toBeNull()
  })
})

describe('缓动批量设置与清空属性', () => {
  it('setEasingOnKeyframes 只改选中的帧', () => {
    const next = setEasingOnKeyframes(ANIM, [{ prop: 'position.x', t: 0.5 }], 'hold')
    expect(next?.['position.x']?.find((k) => k.t === 0.5)?.ease).toBe('hold')
    expect(next?.['position.x']?.find((k) => k.t === 0)?.ease).toBe('linear')
    expect(next?.opacity?.[0].ease).toBe('linear')
  })

  it('项目级批量缓动：一次命令覆盖多个选中帧', () => {
    const project = projectWithAnim()
    const next = setKeyframeEasingInProject(
      project,
      'c1',
      [
        { prop: 'position.x', t: 0 },
        { prop: 'opacity', t: 0.5 },
      ],
      'easeOut',
    )
    expect(next).not.toBeNull()
    const clip = next!.clips[0]
    expect(clip.anim?.['position.x']?.find((k) => k.t === 0)?.ease).toBe('easeOut')
    expect(clip.anim?.opacity?.[0].ease).toBe('easeOut')
    // 未选中的帧不变
    expect(clip.anim?.['position.x']?.find((k) => k.t === 0.5)?.ease).toBe('linear')
  })

  it('缓动无变化时返回 null（不写历史）', () => {
    const project = projectWithAnim()
    expect(
      setKeyframeEasingInProject(project, 'c1', [{ prop: 'position.x', t: 0 }], 'linear'),
    ).toBeNull()
  })

  it('清空某属性：属性消失，其它属性保留；最后一个属性清空后 anim 字段被移除', () => {
    const project = projectWithAnim()
    const cleared = clearPropertyKeyframesInProject(project, 'c1', 'opacity')
    expect(cleared!.clips[0].anim?.opacity).toBeUndefined()
    expect(cleared!.clips[0].anim?.['position.x']?.length).toBe(3)

    const all = clearPropertyKeyframesInProject(project, 'c1', 'position.x')!
    const none = clearPropertyKeyframesInProject(all, 'c1', 'opacity')!
    expect(none.clips[0].anim).toBeUndefined()
  })

  it('pruneEmptyProperties 去掉空属性', () => {
    expect(pruneEmptyProperties({ 'position.x': [], opacity: [key(0, 1)] })).toEqual({
      opacity: [key(0, 1)],
    })
    expect(pruneEmptyProperties({ 'position.x': [] })).toBeUndefined()
    expect(clearPropertyKeyframes(ANIM, 'scale')).toBe(ANIM) // 没有该属性时原样返回
  })
})