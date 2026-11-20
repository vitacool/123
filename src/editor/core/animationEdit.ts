import { evalAnimation } from './animation'
import type { AnimatableProperty, AnimationMap, Easing, Keyframe } from './types'

/**
 * 剪辑操作对关键帧的重映射。
 *
 * 关键帧时间用**片段内归一化时间** 0…1 表示（0 = 片段起点），因此裁剪/分割时
 * 需要把旧时间按新的可见范围换算，保证画面在编辑前后连续。
 *
 * 这里集中所有重映射逻辑，operations.ts 只负责在操作后调用，不自己算。
 */

/** 归一化时间夹取 + 去掉浮点噪声。 */
const norm = (value: number): number => {
  const clamped = Math.min(1, Math.max(0, value))
  return Math.abs(clamped - Math.round(clamped * 1e6) / 1e6) < 1e-9
    ? Math.round(clamped * 1e6) / 1e6
    : clamped
}

/** 去掉归一化后落在区间外（含容差）的关键帧。 */
function keepInRange(keys: Keyframe[], tolerance = 1e-6): Keyframe[] {
  return keys.filter((key) => key.t >= -tolerance && key.t <= 1 + tolerance).map((key) => ({
    ...key,
    t: norm(key.t),
  }))
}

/** 同一时间点去重（保留后者），并按时间排序。 */
function tidy(keys: Keyframe[]): Keyframe[] {
  const byTime = new Map<number, Keyframe>()
  for (const key of keys) byTime.set(norm(key.t), { ...key, t: norm(key.t) })
  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

/**
 * 左裁：可见范围从 [0, D0] 收缩/扩展到 [delta, D0] → 新时长 D1 = D0 - delta。
 * t' = (t·D0 − delta) / D1，丢弃 t' < 0 的帧。
 * `delta` 为负表示向左扩展（恢复被裁掉的部分），公式同样适用。
 *
 * 为了让「裁剪后起点取值 = 裁剪前对应时刻取值」（验收 #5），额外在 t=0 补一个
 * 边界帧，取值为原动画在 delta/D0 处的插值结果。
 */
export function leftTrimAnimation(
  anim: AnimationMap | undefined,
  deltaSeconds: number,
  oldDuration: number,
  newDuration: number,
): AnimationMap | undefined {
  if (!anim || Math.abs(deltaSeconds) < 1e-9 || oldDuration <= 0 || newDuration <= 0) return anim
  const next: AnimationMap = {}
  for (const [prop, keys] of Object.entries(anim) as [AnimatableProperty, Keyframe[]][]) {
    if (!keys || keys.length === 0) continue
    const mapped = keys.map((key) => ({
      ...key,
      t: (key.t * oldDuration - deltaSeconds) / newDuration,
    }))
    const kept = tidy(keepInRange(mapped))
    if (kept.length === 0) continue
    // 新起点对应的原时间：delta / D0（夹到 0…1）。
    const startTime = Math.min(1, Math.max(0, deltaSeconds / oldDuration))
    const startValue = evalAnimation(keys, startTime, kept[0].value)
    const withBoundary =
      kept[0].t > 1e-6 ? tidy([{ t: 0, value: startValue, ease: kept[0].ease }, ...kept]) : kept
    next[prop] = withBoundary
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * 右裁：保持起点不变、终点前移（或后移）。
 * t' = t·D0 / D1，丢弃 t' > 1 的帧。
 */
export function rightTrimAnimation(
  anim: AnimationMap | undefined,
  oldDuration: number,
  newDuration: number,
): AnimationMap | undefined {
  if (!anim || oldDuration <= 0 || newDuration <= 0 || Math.abs(oldDuration - newDuration) < 1e-9) {
    return anim
  }
  const next: AnimationMap = {}
  for (const [prop, keys] of Object.entries(anim) as [AnimatableProperty, Keyframe[]][]) {
    if (!keys || keys.length === 0) continue
    const mapped = keys.map((key) => ({ ...key, t: (key.t * oldDuration) / newDuration }))
    const kept = tidy(keepInRange(mapped))
    if (kept.length === 0) continue
    // 新终点对应的原时间：D1 / D0（右裁 < 1；右扩展 > 1 时夹到 1）。
    const endTime = Math.min(1, Math.max(0, newDuration / oldDuration))
    const endValue = evalAnimation(keys, endTime, kept[kept.length - 1].value)
    const last = kept[kept.length - 1]
    const withBoundary =
      last.t < 1 - 1e-6
        ? tidy([...kept, { t: 1, value: endValue, ease: last.ease }])
        : kept
    next[prop] = withBoundary
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/** 在比例 f 处分割：左片 t' = t/f，右片 t' = (t − f)/(1 − f)。 */
export function splitAnimation(
  anim: AnimationMap | undefined,
  fraction: number,
  baseValue: (prop: AnimatableProperty) => number,
): { left?: AnimationMap; right?: AnimationMap } {
  if (!anim) return {}
  const f = Math.min(1, Math.max(0, fraction))
  const leftMap: AnimationMap = {}
  const rightMap: AnimationMap = {}
  const boundaryEase: Easing = 'linear'

  for (const [prop, keys] of Object.entries(anim) as [AnimatableProperty, Keyframe[]][]) {
    if (!keys || keys.length === 0) continue
    const valueAtCut = evalAnimation(keys, f, baseValue(prop))

    // 左片：0…f 映射到 0…1；右片：f…1 映射到 0…1。
    const leftKeys = keepInRange(keys.map((key) => ({ ...key, t: f <= 0 ? 0 : key.t / f })))
    const rightKeys = keepInRange(
      keys.map((key) => ({ ...key, t: f >= 1 ? 0 : (key.t - f) / (1 - f) })),
    )

    // 两侧各补一个边界帧，保证分割点两侧取值连续（只在该侧本来就有帧时补）。
    if (leftKeys.length > 0) {
      leftMap[prop] = tidy([...leftKeys, { t: 1, value: valueAtCut, ease: boundaryEase }])
    }
    if (rightKeys.length > 0) {
      rightMap[prop] = tidy([{ t: 0, value: valueAtCut, ease: boundaryEase }, ...rightKeys])
    }
  }

  return {
    ...(Object.keys(leftMap).length > 0 ? { left: leftMap } : {}),
    ...(Object.keys(rightMap).length > 0 ? { right: rightMap } : {}),
  }
}

/** 变速 / 改 gap / 移动片段：关键帧不变（相对位置保持）。 */
export function unchangedAnimation(anim: AnimationMap | undefined): AnimationMap | undefined {
  return anim
}
/** 属性对应的片段基础值（分割补边界帧时用来求插值终点）。 */
export function baseValueOf(clip: {
  position: { x: number; y: number }
  scale: number
  rotation: number
  opacity?: number
}): (prop: AnimatableProperty) => number {
  return (prop) => {
    switch (prop) {
      case 'position.x':
        return clip.position.x
      case 'position.y':
        return clip.position.y
      case 'scale':
        return clip.scale
      case 'rotation':
        return clip.rotation
      case 'opacity':
      default:
        return clip.opacity ?? 1
    }
  }
}
