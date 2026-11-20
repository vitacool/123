import { evalAnimation, normalizedTime } from './animation'
import { TEXT_ANIMATABLE_PROPERTIES } from './animationTargets'
import { textClipDuration } from './text'
import { isTextTrackVisible } from './tracks'
import type { TextOverlayInterval } from './textOverlay'
import type { TextRenderOverrides } from './textRender'
import type { Project, TextClip } from './types'

/** 单条文本/字幕是否需要逐帧渲染（position.x / position.y / scale / opacity）。 */
export function hasTextAnimation(clip: { anim?: TextClip['anim'] }): boolean {
  const anim = clip.anim
  if (!anim) return false
  return TEXT_ANIMATABLE_PROPERTIES.some((prop) => (anim[prop]?.length ?? 0) > 0)
}

/** 工程里是否有任何会参与导出的动画文本/字幕。 */
export function hasAnyTextAnimation(project: Project): boolean {
  return (project.textTracks ?? []).some(
    (track) =>
      isTextTrackVisible(track) &&
      track.clips.some(
        (clip) => !clip.link?.linkHidden && hasTextAnimation(clip),
      ),
  )
}

/**
 * 文本在片段本地时间处的动画覆盖值。
 *
 * 时间基准是该文本片段自身的 start/end（通过 textClipDuration 取时长），
 * **不是** link 的源区间。字幕跟随片段（link）时 link 只会重算 start/end，
 * 不会改 anim.t；因此这里不需要额外重映射：归一化关键帧位置保持不变，
 * 视觉效果随裁剪后的字幕时长压缩/拉伸。
 */
export function resolveTextOverrides(
  clip: TextClip,
  localSeconds: number,
  resolvedStyle: TextClip,
): TextRenderOverrides {
  const duration = textClipDuration(clip)
  const t = normalizedTime(localSeconds, duration)
  const anim = clip.anim
  return {
    position: {
      x: evalAnimation(anim?.['position.x'], t, resolvedStyle.x),
      y: evalAnimation(anim?.['position.y'], t, resolvedStyle.y),
    },
    scale: Math.max(
      0.01,
      evalAnimation(anim?.scale, t, resolvedStyle.scale ?? 1),
    ),
    opacity: Math.max(
      0,
      Math.min(1, evalAnimation(anim?.opacity, t, resolvedStyle.opacity ?? 1)),
    ),
  }
}

/** 一段需要绘制的文本覆盖区间（按输出帧对齐）。 */
export interface TextOverlayRenderSegment {
  startFrame: number
  endFrame: number
  /** 秒，= startFrame / fps */
  start: number
  /** 秒，= endFrame / fps */
  end: number
  frames: number
  /** 该区间内可见的文本（与 buildTextOverlayTimeline 的 clip 集合一致）。 */
  clips: TextClip[]
  /** 是否包含动画文本；静态区间只需绘制 1 张 PNG 再循环编码。 */
  animated: boolean
}

/**
 * 把「状态区间」映射到输出帧。
 *
 * - 静态区间：只画 1 帧，编码时按 frames 循环，不产生逐帧 PNG；
 * - 含动画文本的区间：该区间的每一帧都要重画（同一画布按绘制顺序画所有
 *   可见文本，保证与静态路径相同的层级顺序）。
 *
 * 用累计的 frameCursor 对齐区间边界，避免各边界独立 round 产生 1 帧缝隙。
 */
export function buildTextOverlayRenderSegments(
  intervals: readonly TextOverlayInterval[],
  totalDuration: number,
  fps: number,
): TextOverlayRenderSegment[] {
  const safeFps = Math.max(1, fps)
  const totalFrames = Math.max(1, Math.ceil(totalDuration * safeFps - 1e-9))
  const segments: TextOverlayRenderSegment[] = []
  let frameCursor = 0
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index]
    const isLast = index === intervals.length - 1
    const rawEnd = isLast
      ? totalFrames
      : Math.round(interval.end * safeFps)
    const endFrame = Math.max(frameCursor, Math.min(totalFrames, rawEnd))
    if (endFrame <= frameCursor) continue
    const clips = interval.clips.filter((clip) => !clip.link?.linkHidden)
    segments.push({
      startFrame: frameCursor,
      endFrame,
      start: frameCursor / safeFps,
      end: endFrame / safeFps,
      frames: endFrame - frameCursor,
      clips,
      animated: clips.some((clip) => hasTextAnimation(clip)),
    })
    frameCursor = endFrame
  }
  return segments
}

/** 单条动画文本需要渲染的帧数。 */
export function textAnimationFrameCount(clip: TextClip, fps: number): number {
  return Math.max(1, Math.ceil(textClipDuration(clip) * Math.max(1, fps)))
}

/** 全工程动画文本片段的帧总数（用于导出前性能提示）。 */
export function estimateTextAnimationFrames(project: Project, fps: number): number {
  let total = 0
  for (const track of project.textTracks ?? []) {
    if (!isTextTrackVisible(track)) continue
    for (const clip of track.clips) {
      if (clip.link?.linkHidden) continue
      if (!hasTextAnimation(clip)) continue
      total += textAnimationFrameCount(clip, fps)
    }
  }
  return total
}

/** 动画文本每多少帧编码成一个中间片段，避免一次堆积几百张 PNG。 */
export const TEXT_ANIMATION_CHUNK_FRAMES = 30

/** 动画文本总帧数超过这个值时，导出对话框给出警告。 */
export const TEXT_ANIMATION_FRAME_WARNING = 900

/** 导出对话框的性能提示；无需提示时返回 null。 */
export function textAnimationPerformanceHint(project: Project, fps: number): string | null {
  const total = estimateTextAnimationFrames(project, fps)
  if (total <= TEXT_ANIMATION_FRAME_WARNING) return null
  return `带动画的文本/字幕约 ${total} 帧，导出会逐帧渲染并分批编码，预计需要较长时间。`
}