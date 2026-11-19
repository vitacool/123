import { clipTimelineDuration } from './clipTime'
import type { Clip } from './types'

/**
 * 片段级音频参数（主轨与叠加轨通用）。旧草稿没有这些字段，一律按默认值处理：
 * volume=1、fadeIn=0、fadeOut=0，因此与既有行为完全一致。
 */

export const DEFAULT_CLIP_VOLUME = 1
export const MAX_CLIP_VOLUME = 2
export const MIN_CLIP_VOLUME = 0

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 片段增益，夹在 0–2；缺省 1。 */
export function clipVolume(clip: Clip): number {
  const raw = finiteOr(clip.volume, DEFAULT_CLIP_VOLUME)
  return Math.max(MIN_CLIP_VOLUME, Math.min(MAX_CLIP_VOLUME, raw))
}

/** 是否设置了片段级音频参数（用于判断是否需要生成音频滤镜）。 */
export function hasClipAudioSettings(clip: Clip): boolean {
  return clipVolume(clip) !== DEFAULT_CLIP_VOLUME || clipFadeIn(clip) > 0 || clipFadeOut(clip) > 0
}

/** 淡入时长（秒），不小于 0 且不超过片段时长。 */
export function clipFadeIn(clip: Clip): number {
  const duration = Math.max(0, clipTimelineDuration(clip))
  const raw = Math.max(0, finiteOr(clip.fadeIn, 0))
  return Math.min(raw, duration)
}

/** 淡出时长（秒），不小于 0 且不超过片段时长。 */
export function clipFadeOut(clip: Clip): number {
  const duration = Math.max(0, clipTimelineDuration(clip))
  const raw = Math.max(0, finiteOr(clip.fadeOut, 0))
  return Math.min(raw, duration)
}

/**
 * 片段内在局部时间处的增益包络：volume × 淡入/淡出线性包络。
 * 预览与导出共用同一套计算，保证听感一致。
 */
export function clipGainAt(clip: Clip, localTime: number): number {
  const volume = clipVolume(clip)
  const duration = Math.max(0, clipTimelineDuration(clip))
  if (duration <= 0) return volume
  const t = Math.max(0, Math.min(duration, localTime))
  const fadeIn = clipFadeIn(clip)
  const fadeOut = clipFadeOut(clip)
  let envelope = 1
  if (fadeIn > 0 && t < fadeIn) envelope = Math.min(envelope, t / fadeIn)
  if (fadeOut > 0 && t > duration - fadeOut) {
    envelope = Math.min(envelope, (duration - t) / fadeOut)
  }
  return volume * Math.max(0, envelope)
}