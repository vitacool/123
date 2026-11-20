import { animatedProps } from './animation'
import type { AnimatableProperty, AnimationMap, Easing, Keyframe } from './types'

/** 同一个属性内两个关键帧允许的最小时间间隔；小于它就视为「重复」（提交时校验）。 */
export const KEYFRAME_MIN_GAP = 0.001

/**
 * 拖动期夹取用的间隙：只保证「不完全重合」，仍允许落进 <0.001 的区间。
 * 这样到达非法距离时会在提交阶段被唯一性校验拒绝并回退（规格 2.4 的语义），
 * 而不是被悄悄夹到一个合法位置。
 */
export const KEYFRAME_DRAG_GAP = 0.0005

export interface KeyframeRef {
  prop: AnimatableProperty
  t: number
}

export interface KeyframePoint extends KeyframeRef {
  value: number
  ease: Easing
}

/**
 * 关键帧并集：同一 t 上不同属性的关键帧合并成一个点（时间轴只画一个菱形）。
 * 结果按 t 升序。
 */
export function keyframeUnion(anim: AnimationMap | undefined): { t: number; props: AnimatableProperty[] }[] {
  if (!anim) return []
  const byTime = new Map<number, AnimatableProperty[]>()
  for (const prop of animatedProps({ anim })) {
    for (const key of anim[prop] ?? []) {
      const t = Math.round(key.t * 1e6) / 1e6
      const list = byTime.get(t)
      if (list) list.push(prop)
      else byTime.set(t, [prop])
    }
  }
  return [...byTime.entries()]
    .map(([t, props]) => ({ t, props }))
    .sort((a, b) => a.t - b.t)
}

/** 把某个时间点上的所有属性关键帧展开成引用列表。 */
export function refsAtTime(anim: AnimationMap | undefined, t: number): KeyframeRef[] {
  if (!anim) return []
  const refs: KeyframeRef[] = []
  for (const prop of animatedProps({ anim })) {
    for (const key of anim[prop] ?? []) {
      if (Math.abs(key.t - t) < KEYFRAME_MIN_GAP / 2) refs.push({ prop, t: key.t })
    }
  }
  return refs
}

/** 展开某属性在某时刻的关键帧（含取值），用于缓动浮层显示。 */
export function keyframeAt(
  anim: AnimationMap | undefined,
  prop: AnimatableProperty,
  t: number,
): KeyframePoint | null {
  const key = (anim?.[prop] ?? []).find((item) => Math.abs(item.t - t) < KEYFRAME_MIN_GAP / 2)
  return key ? { prop, t: key.t, value: key.value, ease: key.ease } : null
}

/**
 * 多选整体平移的夹取：
 * 1. 整体不越过 [0, 1]（最早不能 < 0、最晚不能 > 1）；
 * 2. 不能与**未选中**的同属性关键帧重叠到同一 t：向右移动时最多贴到对方左侧
 *    `KEYFRAME_MIN_GAP`，向左移动时最多贴到右侧 `KEYFRAME_MIN_GAP`（夹住而不合并）。
 *
 * 返回夹取后的位移量（可能为 0）。
 */
export function clampGroupDrag(
  anim: AnimationMap | undefined,
  selected: readonly KeyframeRef[],
  delta: number,
): number {
  if (!anim || selected.length === 0 || !Number.isFinite(delta)) return 0
  const times = selected.map((ref) => ref.t)
  const earliest = Math.min(...times)
  const latest = Math.max(...times)

  let clamped = delta
  // 1) 端点夹取
  if (earliest + clamped < 0) clamped = -earliest
  if (latest + clamped > 1) clamped = 1 - latest

  // 2) 与未选中关键帧的碰撞夹取
  for (const ref of selected) {
    const target = ref.t + clamped
    for (const other of anim[ref.prop] ?? []) {
      if (Math.abs(other.t - ref.t) < KEYFRAME_MIN_GAP / 2) continue // 自己
      const targetIsSelected = selected.some(
        (item) => item.prop === ref.prop && Math.abs(item.t - other.t) < KEYFRAME_MIN_GAP / 2,
      )
      if (targetIsSelected) continue // 同为选中项，允许一起移动
      const gap = target - other.t
      if (Math.abs(gap) >= KEYFRAME_DRAG_GAP) continue
      if (clamped > 0) {
        clamped = Math.min(clamped, other.t - KEYFRAME_DRAG_GAP - ref.t)
      } else if (clamped < 0) {
        clamped = Math.max(clamped, other.t + KEYFRAME_DRAG_GAP - ref.t)
      } else {
        return 0
      }
    }
  }
  return clamped
}

/** 应用一次整体平移（纯函数）；保持每组关键帧的 ease/value 不变。 */
export function moveKeyframes(
  anim: AnimationMap | undefined,
  selected: readonly KeyframeRef[],
  delta: number,
): AnimationMap | undefined {
  if (!anim || selected.length === 0 || Math.abs(delta) < 1e-9) return anim
  const next: AnimationMap = {}
  for (const [prop, keys] of Object.entries(anim) as [AnimatableProperty, Keyframe[]][]) {
    const moved = (keys ?? []).map((key) => {
      const ref = selected.find((item) => item.prop === prop && Math.abs(item.t - key.t) < KEYFRAME_MIN_GAP / 2)
      if (!ref) return { ...key }
      return { ...key, t: Math.min(1, Math.max(0, key.t + delta)) }
    })
    next[prop] = moved.sort((a, b) => a.t - b.t)
  }
  return next
}

/**
 * 拖动结束的唯一性校验：同一属性内是否有两个关键帧的 t 差 < `KEYFRAME_MIN_GAP`。
 * 返回冲突的属性（没有冲突返回 null）。
 */
export function findDuplicateProperty(anim: AnimationMap | undefined): AnimatableProperty | null {
  if (!anim) return null
  for (const prop of animatedProps({ anim })) {
    const times = (anim[prop] ?? []).map((key) => key.t).sort((a, b) => a - b)
    for (let index = 1; index < times.length; index += 1) {
      if (times[index] - times[index - 1] < KEYFRAME_MIN_GAP) return prop
    }
  }
  return null
}

/** 批量设置缓动（作用于选中的关键帧）。 */
export function setEasingOnKeyframes(
  anim: AnimationMap | undefined,
  selected: readonly KeyframeRef[],
  ease: Easing,
): AnimationMap | undefined {
  if (!anim || selected.length === 0) return anim
  const next: AnimationMap = {}
  for (const [prop, keys] of Object.entries(anim) as [AnimatableProperty, Keyframe[]][]) {
    next[prop] = (keys ?? []).map((key) => {
      const hit = selected.some(
        (item) => item.prop === prop && Math.abs(item.t - key.t) < KEYFRAME_MIN_GAP / 2,
      )
      return hit && key.ease !== ease ? { ...key, ease } : { ...key }
    })
  }
  return next
}

/** 清空某个属性的全部关键帧；属性清空后若整个 anim 为空则返回 undefined。 */
export function clearPropertyKeyframes(
  anim: AnimationMap | undefined,
  prop: AnimatableProperty,
): AnimationMap | undefined {
  if (!anim || !anim[prop]) return anim
  const next: AnimationMap = { ...anim }
  delete next[prop]
  return Object.keys(next).length > 0 ? next : undefined
}

/** 从 anim 里删掉完全为空的属性（保持对象干净）。 */
export function pruneEmptyProperties(anim: AnimationMap | undefined): AnimationMap | undefined {
  if (!anim) return undefined
  const next: AnimationMap = {}
  for (const [prop, keys] of Object.entries(anim) as [AnimatableProperty, Keyframe[]][]) {
    if ((keys ?? []).length > 0) next[prop] = keys
  }
  return Object.keys(next).length > 0 ? next : undefined
}