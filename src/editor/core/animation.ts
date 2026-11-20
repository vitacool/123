import { clipOpacity } from './blend'
import type { AnimatableProperty, AnimationMap, Clip, Easing, Keyframe, Point } from './types'

/** 关键帧列表按时间排序后的求值：p ∈ [0,1] 映射到缓动后的插值比例。 */
export function easeValue(ease: Easing, p: number): number {
  const clamped = Math.min(1, Math.max(0, p))
  switch (ease) {
    case 'hold':
      return 0
    case 'easeIn':
      return clamped * clamped * clamped
    case 'easeOut':
      return 1 - (1 - clamped) ** 3
    case 'easeInOut':
      return clamped < 0.5 ? 4 * clamped ** 3 : 1 - 4 * (1 - clamped) ** 3
    case 'linear':
    default:
      return clamped
  }
}

/**
 * 求某个属性在本地时间 `t`（0…1 归一化）的取值。
 *
 * - keys 为空 / undefined → fallback
 * - t 在首帧之前 → 首帧值；在末帧之后 → 末帧值
 * - 两帧之间按**后一帧**的 ease 插值；hold 表示保持前一帧的值直到该帧
 */
export function evalAnimation(
  keys: Keyframe[] | undefined,
  t: number,
  fallback: number,
): number {
  if (!keys || keys.length === 0) return fallback
  const sorted = [...keys].sort((a, b) => a.t - b.t)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (t <= first.t) return first.value
  if (t >= last.t) return last.value
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index]
    const to = sorted[index + 1]
    if (t < from.t || t >= to.t) continue
    const span = to.t - from.t
    if (span <= 0) return to.value
    const p = (t - from.t) / span
    if (to.ease === 'hold') return from.value
    return from.value + (to.value - from.value) * easeValue(to.ease, p)
  }
  return last.value
}

/** 该片段是否有任何关键帧。 */
export function hasAnimation(clip: { anim?: AnimationMap }): boolean {
  const anim = clip.anim
  if (!anim) return false
  return Object.values(anim).some((keys) => Array.isArray(keys) && keys.length > 0)
}

/** 该片段是否有需要逐帧烘焙画面的视觉动画（音量关键帧不算）。 */
export function hasVisualAnimation(clip: { anim?: AnimationMap }): boolean {
  const anim = clip.anim
  if (!anim) return false
  const visual: AnimatableProperty[] = ['position.x', 'position.y', 'scale', 'rotation', 'opacity']
  return visual.some((prop) => (anim[prop]?.length ?? 0) > 0)
}

/** 该片段是否带音量关键帧。 */
export function hasVolumeAnimation(clip: { anim?: AnimationMap }): boolean {
  return (clip.anim?.volume?.length ?? 0) > 0
}

/** 该片段有哪些属性带关键帧（顺序固定，便于 UI 稳定渲染）。 */
export function animatedProps(clip: { anim?: AnimationMap }): AnimatableProperty[] {
  const anim = clip.anim
  if (!anim) return []
  const order: AnimatableProperty[] = [
    'position.x',
    'position.y',
    'scale',
    'rotation',
    'opacity',
    'volume',
  ]
  return order.filter((prop) => (anim[prop]?.length ?? 0) > 0)
}

/** 片段在时间线内的本地时间（秒）换算成动画归一化时间 0…1。 */
export function normalizedTime(localTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(1, Math.max(0, localTime / duration))
}

/**
 * 把动画求值成一组属性覆盖值（与 clip 的基础值合并后就是该时刻的最终属性）。
 * 没有关键帧的属性回落到 clip 自身的基础值。
 */
export function resolveClipOverrides(
  clip: Clip,
  localTime: number,
  duration?: number,
): { position: Point; scale: number; rotation: number; opacity: number } {
  const total = duration ?? 1
  const t = normalizedTime(localTime, total)
  const anim: AnimationMap = clip.anim ?? {}
  return {
    position: {
      x: evalAnimation(anim['position.x'], t, clip.position.x),
      y: evalAnimation(anim['position.y'], t, clip.position.y),
    },
    scale: evalAnimation(anim.scale, t, clip.scale),
    rotation: evalAnimation(anim.rotation, t, clip.rotation),
    opacity: evalAnimation(anim.opacity, t, clipOpacity(clip)),
  }
}