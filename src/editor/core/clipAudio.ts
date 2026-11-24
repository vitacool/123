import { evalAnimation, normalizedTime } from './animation'
import { clipTimelineDuration, type TimeMappable } from './clipTime'
import type { AnimationMap, FadeCurve } from './types'

/**
 * 片段级音频参数（主轨与叠加轨通用）。旧草稿没有这些字段，一律按默认值处理：
 * volume=1、fadeIn=0、fadeOut=0，因此与既有行为完全一致。
 *
 * 这里用 `TimeMappable` 作为公共基底，`Clip` / `AudioClip` 都能直接传入。
 */

export const DEFAULT_CLIP_VOLUME = 1
export const MAX_CLIP_VOLUME = 2
export const MIN_CLIP_VOLUME = 0

/** 有音量关键帧的片段：Clip 与 AudioClip 都满足。 */
export interface VolumeAnimatable extends TimeMappable {
  volume?: number
  fadeIn?: number
  fadeOut?: number
  fadeInCurve?: FadeCurve
  fadeOutCurve?: FadeCurve
  anim?: AnimationMap
}

/** 曲线名 → FFmpeg `afade=curve=` 值（linear 用 tri，保持历史默认）。 */
export function ffmpegFadeCurve(curve: FadeCurve | undefined): 'tri' | 'exp' | 'log' {
  if (curve === 'exp') return 'exp'
  if (curve === 'log') return 'log'
  return 'tri'
}

/** 非默认曲线才追加参数，保证既有工程的滤镜图不变。 */
export function fadeCurveSuffix(curve: FadeCurve | undefined): string {
  return curve && curve !== 'linear' ? `:curve=${ffmpegFadeCurve(curve)}` : ''
}

/** 淡入淡出进度（0→1）经曲线整形；与 FFmpeg exp/log 近似。 */
export function fadeProgress(progress: number, curve: FadeCurve | undefined): number {
  const x = Math.max(0, Math.min(1, progress))
  if (curve === 'exp') return (Math.exp(x) - 1) / (Math.E - 1)
  if (curve === 'log') return Math.log10(1 + 9 * x)
  return x
}

function finiteOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

/** 片段增益，夹在 0–2；缺省 1。 */
export function clipVolume(clip: VolumeAnimatable): number {
  const raw = finiteOr(clip.volume, DEFAULT_CLIP_VOLUME)
  return Math.max(MIN_CLIP_VOLUME, Math.min(MAX_CLIP_VOLUME, raw))
}

/** 是否设置了片段级音频参数（用于判断是否需要生成音频滤镜）。 */
export function hasClipAudioSettings(clip: VolumeAnimatable): boolean {
  return (
    clipVolume(clip) !== DEFAULT_CLIP_VOLUME ||
    clipFadeIn(clip) > 0 ||
    clipFadeOut(clip) > 0 ||
    (clip.anim?.volume?.length ?? 0) > 0
  )
}

/** 淡入时长（秒），不小于 0 且不超过片段时长。 */
export function clipFadeIn(clip: VolumeAnimatable): number {
  const duration = Math.max(0, clipTimelineDuration(clip))
  const raw = Math.max(0, finiteOr(clip.fadeIn, 0))
  return Math.min(raw, duration)
}

/** 淡出时长（秒），不小于 0 且不超过片段时长。 */
export function clipFadeOut(clip: VolumeAnimatable): number {
  const duration = Math.max(0, clipTimelineDuration(clip))
  const raw = Math.max(0, finiteOr(clip.fadeOut, 0))
  return Math.min(raw, duration)
}

/**
 * 片段在本地时间 `localTime` 处的音量（不含淡入淡出）：
 * 无关键帧 → `baseVolume`（缺省用 clip.volume 夹取到 0…2）；
 * 有关键帧 → 与导出表达式完全相同的 `evalAnimation` 求值。
 *
 * 注意：关键帧值本身是**绝对增益**，不是相对基础值的倍率；这与导出
 * `volume='<expr>':eval=frame` 以及 0…2 的取值约定一致。
 */
export function clipVolumeAt(
  clip: VolumeAnimatable,
  localTime: number,
  baseVolume?: number,
): number {
  const fallback = Math.max(
    MIN_CLIP_VOLUME,
    Math.min(MAX_CLIP_VOLUME, finiteOr(baseVolume, clipVolume(clip))),
  )
  const keys = clip.anim?.volume
  if (!keys || keys.length === 0) return fallback
  const duration = Math.max(0, clipTimelineDuration(clip))
  const t = normalizedTime(localTime, duration)
  return Math.max(
    MIN_CLIP_VOLUME,
    Math.min(MAX_CLIP_VOLUME, evalAnimation(keys, t, fallback)),
  )
}

/**
 * 片段内在局部时间处的增益包络：音量（含关键帧）× 淡入/淡出线性包络。
 * 预览与导出共用同一套计算，保证听感一致；导出侧 volume 在前、afade 在后，
 * 正好对应这里的乘法顺序。
 */
export function clipGainAt(
  clip: VolumeAnimatable,
  localTime: number,
  baseVolume?: number,
): number {
  const volume = clipVolumeAt(clip, localTime, baseVolume)
  const duration = Math.max(0, clipTimelineDuration(clip))
  if (duration <= 0) return volume
  const t = Math.max(0, Math.min(duration, localTime))
  const fadeIn = clipFadeIn(clip)
  const fadeOut = clipFadeOut(clip)
  let envelope = 1
  if (fadeIn > 0 && t < fadeIn) {
    envelope = Math.min(envelope, fadeProgress(t / fadeIn, clip.fadeInCurve))
  }
  if (fadeOut > 0 && t > duration - fadeOut) {
    envelope = Math.min(
      envelope,
      fadeProgress((duration - t) / fadeOut, clip.fadeOutCurve),
    )
  }
  return volume * Math.max(0, envelope)
}