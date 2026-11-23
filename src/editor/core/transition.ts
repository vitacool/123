import { clipTimelineDuration } from './clipTime'
import type { Clip, TransitionType } from './types'

/** 转场分组（UI 按分组展示；顺序即展示顺序）。 */
export const TRANSITION_GROUPS = [
  { id: 'basic', label: '基础' },
  { id: 'wipe', label: '擦除' },
  { id: 'smooth', label: '柔边擦除' },
  { id: 'slide', label: '滑动' },
  { id: 'shape', label: '形状' },
  { id: 'effect', label: '特效' },
] as const

export type TransitionGroupId = (typeof TRANSITION_GROUPS)[number]['id']

/**
 * 转场类型（与 FFmpeg xfade 的 transition 名称一一对应）。
 * 前 5 项保持历史顺序不变（旧草稿/测试依赖它们）。
 */
export const TRANSITION_TYPES: readonly {
  value: TransitionType
  label: string
  group: TransitionGroupId
}[] = [
  // 基础
  { value: 'fade', label: '淡入淡出', group: 'basic' },
  { value: 'fadeblack', label: '黑场过渡', group: 'basic' },
  { value: 'fadewhite', label: '白场过渡', group: 'basic' },
  { value: 'fadegrays', label: '灰度过渡', group: 'basic' },
  // 擦除（硬边）
  { value: 'wipeleft', label: '向左擦除', group: 'wipe' },
  { value: 'wiperight', label: '向右擦除', group: 'wipe' },
  { value: 'wipeup', label: '向上擦除', group: 'wipe' },
  { value: 'wipedown', label: '向下擦除', group: 'wipe' },
  // 柔边擦除
  { value: 'smoothleft', label: '向左柔擦', group: 'smooth' },
  { value: 'smoothright', label: '向右柔擦', group: 'smooth' },
  { value: 'smoothup', label: '向上柔擦', group: 'smooth' },
  { value: 'smoothdown', label: '向下柔擦', group: 'smooth' },
  // 滑动
  { value: 'slideleft', label: '向左滑动', group: 'slide' },
  { value: 'slideright', label: '向右滑动', group: 'slide' },
  { value: 'slideup', label: '向上滑动', group: 'slide' },
  { value: 'slidedown', label: '向下滑动', group: 'slide' },
  // 形状
  { value: 'circleopen', label: '圆形展开', group: 'shape' },
  { value: 'circleclose', label: '圆形收缩', group: 'shape' },
  { value: 'circlecrop', label: '圆形遮罩', group: 'shape' },
  { value: 'rectcrop', label: '矩形遮罩', group: 'shape' },
  { value: 'vertopen', label: '竖向开门', group: 'shape' },
  { value: 'vertclose', label: '竖向关门', group: 'shape' },
  { value: 'horzopen', label: '横向开门', group: 'shape' },
  { value: 'horzclose', label: '横向关门', group: 'shape' },
  { value: 'radial', label: '时钟擦除', group: 'shape' },
  // 特效
  { value: 'dissolve', label: '溶解', group: 'effect' },
  { value: 'pixelize', label: '像素化', group: 'effect' },
  { value: 'hblur', label: '模糊过渡', group: 'effect' },
  { value: 'zoomin', label: '放大进入', group: 'effect' },
  { value: 'squeezeh', label: '横向挤压', group: 'effect' },
  { value: 'squeezev', label: '纵向挤压', group: 'effect' },
]

export const TRANSITION_MIN_DURATION = 0.1
export const TRANSITION_MAX_DURATION = 2
/** 转场重叠判定容差。 */
export const TRANSITION_EPSILON = 1e-6

const TRANSITION_VALUES = new Set<string>(TRANSITION_TYPES.map((item) => item.value))

/** 收敛成合法转场类型，非法值回退 fade。 */
export function normalizeTransitionType(value: unknown): TransitionType {
  return typeof value === 'string' && TRANSITION_VALUES.has(value)
    ? (value as TransitionType)
    : 'fade'
}

/** 转场类型的中文名。 */
export function transitionLabel(type: TransitionType): string {
  return TRANSITION_TYPES.find((item) => item.value === type)?.label ?? '淡入淡出'
}

/** 把转场时长夹到 0.1–2s；非法值回退最小可用值。 */
export function clampTransitionDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return TRANSITION_MIN_DURATION
  }
  return Math.max(TRANSITION_MIN_DURATION, Math.min(TRANSITION_MAX_DURATION, value))
}

/** 片段是否设置了转场。 */
export function clipTransitionOut(clip: Clip): { type: TransitionType; duration: number } | null {
  const value = clip.transitionOut
  if (!value) return null
  return {
    type: normalizeTransitionType(value.type),
    duration: clampTransitionDuration(value.duration),
  }
}

/**
 * 两个相邻片段之间允许的最大转场时长：
 * 上限 2s，且不超过两侧较短片段的一半。
 */
export function maxTransitionDuration(left: Clip, right: Clip): number {
  const shorter = Math.min(
    Math.max(0, clipTimelineDuration(left)),
    Math.max(0, clipTimelineDuration(right)),
  )
  const limit = Math.min(TRANSITION_MAX_DURATION, shorter / 2)
  return limit >= TRANSITION_MIN_DURATION ? limit : 0
}

/**
 * 计算相邻两片段之间的实际重叠时长（秒）。
 * 有间隙（gapBefore > 0）或任一侧是定格/图片以外的不可用情况时返回 0。
 */
export function resolveTransitionDuration(
  left: Clip,
  right: Clip,
  rightGapBefore: number,
): number {
  if (rightGapBefore > TRANSITION_EPSILON) return 0
  const transition = clipTransitionOut(left)
  if (!transition) return 0
  if (left.type === 'freeze' || right.type === 'freeze') return 0
  const limit = maxTransitionDuration(left, right)
  if (limit <= 0) return 0
  const duration = Math.min(transition.duration, limit)
  return duration >= TRANSITION_MIN_DURATION ? duration : 0
}

/** 该片段之后是否存在可用转场（用于时间轴标记显隐）。 */
export function hasTransitionPair(left: Clip, right: Clip | null, rightGapBefore: number): boolean {
  if (!right) return false
  if (rightGapBefore > TRANSITION_EPSILON) return false
  if (left.type === 'freeze' || right.type === 'freeze') return false
  return maxTransitionDuration(left, right) > 0
}

/** 转场在时间轴上的进度 0–1（用于预览的合成权重）。 */
export function transitionProgress(overlapStart: number, overlapEnd: number, time: number): number {
  const span = overlapEnd - overlapStart
  if (span <= TRANSITION_EPSILON) return 1
  return Math.max(0, Math.min(1, (time - overlapStart) / span))
}