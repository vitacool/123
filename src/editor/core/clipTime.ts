import type { Clip } from './types'

/**
 * 片段时间映射的唯一入口。
 *
 * 现有模型里只有 `sourceStart` / `sourceEnd` 与 `freeze`：
 * - 普通片段：时间轴时长 = sourceEnd - sourceStart；时间轴局部时间 t 对应源时间 sourceStart + t。
 * - 定格片段（freeze）：`sourceStart..sourceEnd` 编码的是「停留时长」，显示帧恒为
 *   `freezeFrameTime ?? sourceStart`。
 *
 * `speed`（倍率）与 `reversed`（倒放）为预留参数：当前所有片段都不带这两个字段，
 * 走默认值 speed=1 / reversed=false，因此调用本模块与旧实现完全等价。
 */

export interface ClipTimeOptions {
  /** 播放倍率，>0。默认 1。 */
  speed?: number
  /** 是否倒放。默认 false。 */
  reversed?: boolean
}

/**
 * 只需这些字段即可做时间映射，`Clip` 与 `AudioClip` 都满足。
 * （音频片段没有 type/freezeFrameTime，自然按普通片段的规则处理。）
 */
export interface TimeMappable {
  sourceStart: number
  sourceEnd: number
  /** 视频片段才有；音频片段缺省，按普通片段处理。 */
  type?: Clip['type']
  freezeFrameTime?: number
  /** 播放倍率（0.1–10），缺省 1。 */
  speed?: number
  /** 变速时是否保持音调，缺省 true。 */
  keepPitch?: boolean
}

/** 静帧片段（定格 / 图片）：显示帧恒定，没有可跳转的源时间。 */
function isStill(clip: TimeMappable): boolean {
  return clip.type === 'freeze' || clip.type === 'image'
}

const DEFAULT_SPEED = 1

/** 解析倍率：显式传入的 options.speed 优先，其次片段自身的 speed，非法值回退 1。 */
export function clipSpeed(clip: TimeMappable, options: ClipTimeOptions = {}): number {
  const raw = options.speed ?? clip.speed
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_SPEED
  return raw
}

/** 是否倒放。 */
export function clipReversed(_clip: TimeMappable, options: ClipTimeOptions = {}): boolean {
  return options.reversed === true
}

/** 源时间跨度（freeze 时该跨度即停留时长）。 */
export function clipSourceSpan(clip: TimeMappable): { start: number; end: number } {
  return { start: clip.sourceStart, end: clip.sourceEnd }
}

/** 时间轴时长 = 源跨度 / 倍率。不做下限裁剪，由调用方决定是否 clamp。 */
export function clipTimelineDuration(
  clip: TimeMappable,
  options: ClipTimeOptions = {},
): number {
  const span = clip.sourceEnd - clip.sourceStart
  const speed = clipSpeed(clip, options)
  return speed === DEFAULT_SPEED ? span : span / speed
}

/** 定格片段显示的那一帧；非定格片段返回 sourceStart。 */
export function clipFreezeFrame(clip: TimeMappable): number {
  return clip.freezeFrameTime ?? clip.sourceStart
}

/**
 * 用「另一个倍率」计算该片段的时间轴时长（不改动片段本身）。
 * 供实时预览使用：组件层只需传倍率，换算仍全部留在本模块。
 */
export function clipTimelineDurationAt(
  clip: TimeMappable,
  speed: number,
  options: ClipTimeOptions = {},
): number {
  return clipTimelineDuration(clip, { ...options, speed })
}

/**
 * 时间轴局部时间（0..clipTimelineDuration）→ 源时间的「跨度坐标」。
 * freeze 不取定格帧（因为它用 sourceStart/sourceEnd 编码时长），
 * 供 split / trim / resize 这类改写时长的操作使用。
 */
export function clipSpanSourceAt(
  clip: TimeMappable,
  localTime: number,
  options: ClipTimeOptions = {},
): number {
  const speed = clipSpeed(clip, options)
  const localSource = localTime * speed
  if (clipReversed(clip, options)) return clip.sourceEnd - localSource
  return clip.sourceStart + localSource
}

/**
 * 时间轴局部时间 → 实际要显示的源时间（freeze 恒为定格帧）。
 * 供预览取帧与导出滤镜使用，保证两者视觉一致。
 */
export function clipFrameSourceAt(
  clip: TimeMappable,
  localTime: number,
  options: ClipTimeOptions = {},
): number {
  if (isStill(clip)) return clipFreezeFrame(clip)
  return clipSpanSourceAt(clip, localTime, options)
}

/**
 * 源时间 → 时间轴局部时间（clipSpanSourceAt 的逆运算）。
 * freeze 片段没有可逆的局部时间（恒定格），返回 0。
 */
export function clipLocalAt(
  clip: TimeMappable,
  sourceTime: number,
  options: ClipTimeOptions = {},
): number {
  if (isStill(clip)) return 0
  const speed = clipSpeed(clip, options)
  const raw = clipReversed(clip, options)
    ? clip.sourceEnd - sourceTime
    : sourceTime - clip.sourceStart
  const local = speed === DEFAULT_SPEED ? raw : raw / speed
  return Number.isFinite(local) ? local : 0
}