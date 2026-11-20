import { clipTimelineDuration } from './clipTime'
import { hasAnimation } from './animation'
import type { Clip, Project } from './types'

export interface AnimatedClipRef {
  clip: Clip
  /** 主轨为 null；叠加轨为轨道 id。 */
  trackId: string | null
  index: number
}

/** 工程里所有带动画的片段（主轨在前，叠加轨按轨道顺序）。 */
export function animatedClips(project: Project): AnimatedClipRef[] {
  const list: AnimatedClipRef[] = []
  project.clips.forEach((clip, index) => {
    if (hasAnimation(clip)) list.push({ clip, trackId: null, index })
  })
  for (const track of project.overlayTracks ?? []) {
    track.clips.forEach((clip, index) => {
      if (hasAnimation(clip)) list.push({ clip, trackId: track.id, index })
    })
  }
  return list
}

/** 是否有任何动画片段（没有就走原来的导出路径，零额外开销）。 */
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
 * 把「带动画的片段」烘焙成指向中间视频的普通片段：
 * 几何/不透明度/调色/动画都已烘进画面，因此这里把相关字段全部重置为默认值，
 * 让 exportPlan 把它当成一段普通素材处理（exportPlan 一行都不用改）。
 */
export function bakeAnimatedClip(clip: Clip, sourceUrl: string, duration: number): Clip {
  return {
    ...clip,
    sourceUrl,
    type: 'video',
    sourceStart: 0,
    sourceEnd: duration,
    speed: 1,
    keepPitch: true,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    scale: 1,
    position: { x: 0, y: 0 },
    rotation: 0,
    flipH: false,
    flipV: false,
    opacity: 1,
    blendMode: 'normal',
    background: undefined,
    color: undefined,
    anim: undefined,
  }
}
