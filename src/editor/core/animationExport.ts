import { clipTimelineDuration } from './clipTime'
import { getTimeline } from './timeline'
import { hasVisualAnimation } from './animation'
import type { Clip, Project } from './types'

export interface AnimatedClipRef {
  clip: Clip
  /** 主轨为 null；叠加轨为轨道 id。 */
  trackId: string | null
  index: number
  /** 片段在所属轨道上的时间线起点（秒）。 */
  start: number
}

/** 工程里所有带视觉动画的片段（主轨在前，叠加轨按轨道顺序）。 */
export function animatedClips(project: Project): AnimatedClipRef[] {
  const list: AnimatedClipRef[] = []
  for (const segment of getTimeline(project.clips)) {
    if (hasVisualAnimation(segment.clip)) {
      list.push({ clip: segment.clip, trackId: null, index: segment.index, start: segment.start })
    }
  }
  for (const track of project.overlayTracks ?? []) {
    for (const segment of getTimeline(track.clips)) {
      if (hasVisualAnimation(segment.clip)) {
        list.push({ clip: segment.clip, trackId: track.id, index: segment.index, start: segment.start })
      }
    }
  }
  return list
}

/**
 * 是否有任何需要逐帧烘焙画面的动画片段。
 * 音量关键帧不触发视觉烘焙（否则会平白多一次 H.264 重编码，还会丢失音频动画）。
 */
export function hasAnyAnimation(project: Project): boolean {
  return animatedClips(project).length > 0
}

/** 单个动画片段需要渲染的帧数。 */
export function animationFrameCount(clip: Clip, fps: number): number {
  const duration = clipTimelineDuration(clip)
  return Math.max(1, Math.ceil(duration * Math.max(1, fps)))
}

/** 全工程动画帧总数（用于导出前的性能提示）。 */
export function estimateAnimationFrames(project: Project, fps: number): number {
  return animatedClips(project).reduce(
    (total, item) => total + animationFrameCount(item.clip, fps),
    0,
  )
}

/** 单个动画片段的帧数上限（约 60 秒 @30fps）。 */
export const ANIMATION_SINGLE_CLIP_FRAME_LIMIT = 1800
/** 全工程动画帧总数上限（约 100 秒 @30fps）。 */
export const ANIMATION_TOTAL_FRAME_LIMIT = 3000

/** 导出对话框用的性能提示文案；无需提示时返回 null。 */
export function animationPerformanceHint(project: Project, fps: number): string | null {
  const clips = animatedClips(project)
  if (clips.length === 0) return null
  const total = estimateAnimationFrames(project, fps)
  const perClip = Math.max(...clips.map((item) => animationFrameCount(item.clip, fps)))
  const heavyTotal = total > ANIMATION_TOTAL_FRAME_LIMIT
  const heavyClip = perClip > ANIMATION_SINGLE_CLIP_FRAME_LIMIT
  if (!heavyTotal && !heavyClip) return null
  const parts = [`动画片段较多，导出预计需要较长时间（共 ${total} 帧）`]
  if (heavyClip) parts.push(`单个片段最长 ${perClip} 帧`)
  return parts.join('；')
}
/**
 * 逐帧烘焙时，Clip 每个字段的归属。
 *
 * - `baked`：渲染器已经把它画进中间视频，烘焙后必须重置/清空，
 *   否则 exportPlan 会在烘焙结果上**再做一遍**（蒙版被二次裁切、抠像二次处理等）。
 * - `kept`：渲染器不处理（时间轴结构 / 音频 / 转场），保留原值。
 * - `replaced`：被替换成中间视频（sourceUrl）。
 * - `partial`：部分烘焙、部分保留（anim 的视觉关键帧烘掉，音量关键帧留给音频链）。
 *
 * 用 `satisfies Record<keyof Clip, …>` 穷举：Clip 新增字段却没在这里表态时，
 * `pnpm typecheck` 会直接报错（防止以后加新效果又漏掉烘焙重置）。
 */
export type AnimatedClipFieldHandling = 'baked' | 'kept' | 'replaced' | 'partial'

export const ANIMATED_CLIP_FIELD_HANDLING = {
  id: 'kept',
  sourceUrl: 'replaced',
  sourceStart: 'baked',
  sourceEnd: 'baked',
  type: 'baked',
  rotation: 'baked',
  flipH: 'baked',
  flipV: 'baked',
  crop: 'baked',
  scale: 'baked',
  position: 'baked',
  // 时间轴上的空档：不是画面效果，保留。
  gapBefore: 'kept',
  // 定格帧已经画进中间视频；烘焙后是普通视频，不再需要。
  freezeFrameTime: 'baked',
  // 声音由中间视频自带的音轨 + exportPlan 音频链接管（音量/淡入淡出是音频链参数）。
  volume: 'kept',
  fadeIn: 'kept',
  fadeOut: 'kept',
  speed: 'baked',
  keepPitch: 'baked',
  opacity: 'baked',
  blendMode: 'baked',
  speedSegments: 'baked',
  speedCurve: 'baked',
  // 转场发生在片段之间，渲染器不处理，保留。
  transitionOut: 'kept',
  background: 'baked',
  anim: 'partial',
  // 蒙版与抠像：animationRenderer 在渲染每一帧时已经应用（PNG 含 alpha），必须清掉。
  mask: 'baked',
  chromaKey: 'baked',
  color: 'baked',
} satisfies Record<keyof Clip, AnimatedClipFieldHandling>

/**
 * 把「带动画的片段」烘焙成指向中间视频的普通片段：
 * 几何/不透明度/调色/蒙版/抠像/动画都已烘进画面，因此这里把相关字段全部重置为
 * 默认值，让 exportPlan 把它当成一段普通素材处理（exportPlan 一行都不用改）。
 *
 * 尤其注意 mask / chromaKey：animationRenderer 渲染每一帧时已经画过，
 * 留着会被 exportPlan 的 alphamerge / chromakey **再应用一次**（画面被二次裁切）。
 */
export function bakeAnimatedClip(clip: Clip, sourceUrl: string, duration: number): Clip {
  return {
    ...clip,
    sourceUrl,
    type: 'video',
    sourceStart: 0,
    sourceEnd: duration,
    speed: 1,
    // 变速必须整条清掉：中间视频是按「时间轴时长」逐帧渲染的，画面里已经含了
    // speedSegments / speedCurve 的效果；如果留着，exportPlan 会在烘焙结果上再变速
    // 一次（时长被二次缩放，且 setpts 与帧序列对不上）。
    speedSegments: undefined,
    speedCurve: undefined,
    keepPitch: true,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    scale: 1,
    position: { x: 0, y: 0 },
    rotation: 0,
    flipH: false,
    flipV: false,
    freezeFrameTime: undefined,
    opacity: 1,
    blendMode: 'normal',
    background: undefined,
    color: undefined,
    // 渲染器已把蒙版/抠像画进画面；保留会被再应用一次。
    mask: undefined,
    chromaKey: undefined,
    // 视觉动画已烘进画面；音量关键帧仍必须留给 exportPlan 的音频链使用。
    anim: clip.anim?.volume?.length ? { volume: clip.anim.volume } : undefined,
  }
}
