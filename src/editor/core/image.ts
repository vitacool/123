import type { Clip } from './types'

/** 图片素材拖到时间轴时的默认时长（秒）。 */
export const IMAGE_DEFAULT_DURATION = 3
/** 图片片段可拉伸的最短时长（秒）。 */
export const IMAGE_MIN_DURATION = 0.2
/** 图片片段可拉伸的最长时长（秒），远大于素材本身也无妨——静帧可以任意停留。 */
export const IMAGE_MAX_DURATION = 60 * 60

/** 该片段是否为图片（静帧）片段。 */
export function isImageClip(clip: Clip): boolean {
  return clip.type === 'image'
}

/** 由图片素材创建一个默认 3 秒的静帧片段的数据（不含 id/视觉参数，由调用方补齐）。 */
export function imageClipSpan(
  duration: number = IMAGE_DEFAULT_DURATION,
): { sourceStart: number; sourceEnd: number } {
  const safe = Number.isFinite(duration)
    ? Math.max(IMAGE_MIN_DURATION, Math.min(IMAGE_MAX_DURATION, duration))
    : IMAGE_DEFAULT_DURATION
  return { sourceStart: 0, sourceEnd: safe }
}

/** 图片片段拉伸/裁剪时允许的时长范围（不受素材真实时长限制）。 */
export function imageDurationBounds(): { min: number; max: number } {
  return { min: IMAGE_MIN_DURATION, max: IMAGE_MAX_DURATION }
}