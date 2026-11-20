import { clipVolume } from './clipAudio'
import { audioClipDuration, findAudioClipLocation } from './audio'
import { clipOpacity } from './blend'
import { findTextClipLocation, resolveCaptionStyle, textClipDuration } from './text'
import { findClipLocation } from './timeline'
import type {
  AnimatableProperty,
  AnimationMap,
  AudioClip,
  Clip,
  Project,
  TextClip,
} from './types'

/** 文本/字幕允许的关键帧属性（与 UI 一致，不含旋转/音量）。 */
export const TEXT_ANIMATABLE_PROPERTIES: AnimatableProperty[] = [
  'position.x',
  'position.y',
  'scale',
  'opacity',
]

/**
 * 关键帧编辑的统一目标：视频片段（主轨/叠加轨）与音频片段。
 *
 * 关键帧时间始终是「该对象在自身所属轨道上的本地归一化时间 0…1」：
 * - 视频：findClipLocation 给出的 segment.start / segment.duration（含 gap/变速）；
 * - 音频：clip.start / audioClipDuration；
 * - 文本/字幕：clip.start / (clip.end − clip.start)。link 只重算 start/end，
 *   不改 anim.t，所以不需要额外按 link 源区间重映射。
 *
 * 这样 UI、命令、预览与导出都共用同一套时间基准。
 */
export type AnimationTargetKind = 'clip' | 'audio' | 'text'

export interface AnimationTarget {
  kind: AnimationTargetKind
  clipId: string
  clip: Clip | AudioClip | TextClip
  /** 视频主轨为 null；叠加轨/音频轨/文本轨为对应轨道 id。 */
  trackId: string | null
  /** 在时间线上的起点（秒）。 */
  start: number
  /** 时间线时长（秒）。 */
  duration: number
  /** 文本/字幕合并组样式后的生效值；其它目标缺省。 */
  textStyle?: TextClip
}

export function findAnimationTarget(
  project: Project,
  id: string | null,
): AnimationTarget | null {
  if (!id) return null
  const video = findClipLocation(project, id)
  if (video) {
    return {
      kind: 'clip',
      clipId: id,
      clip: video.clip,
      trackId: video.track?.id ?? null,
      start: video.segment.start,
      duration: video.segment.duration,
    }
  }
  const audio = findAudioClipLocation(project, id)
  if (audio) {
    const duration = audioClipDuration(audio.clip)
    return {
      kind: 'audio',
      clipId: id,
      clip: audio.clip,
      trackId: audio.track.id,
      start: audio.clip.start,
      duration,
    }
  }
  const text = findTextClipLocation(project, id)
  if (text) {
    return {
      kind: 'text',
      clipId: id,
      clip: text.clip,
      trackId: text.track.id,
      start: text.clip.start,
      duration: textClipDuration(text.clip),
      textStyle: resolveCaptionStyle(text.clip, text.track.captionStyle),
    }
  }
  return null
}

/** 该目标是否允许在某个属性上做关键帧。 */
export function isPropertyAnimatizable(
  target: AnimationTarget,
  prop: AnimatableProperty,
): boolean {
  if (target.kind === 'audio') return prop === 'volume'
  if (target.kind === 'text') return TEXT_ANIMATABLE_PROPERTIES.includes(prop)
  return true
}

/** 目标的基础值（新增关键帧时取当前生效值）。 */
export function animationBaseValue(
  target: AnimationTarget,
  prop: AnimatableProperty,
): number {
  if (target.kind === 'audio') return clipVolume(target.clip as AudioClip)
  if (target.kind === 'text') {
    const style = target.textStyle ?? (target.clip as TextClip)
    switch (prop) {
      case 'position.x':
        return style.x
      case 'position.y':
        return style.y
      case 'scale':
        return style.scale ?? 1
      case 'opacity':
        return Math.max(0, Math.min(1, style.opacity ?? 1))
      default:
        return 1
    }
  }
  const clip = target.clip as Clip
  switch (prop) {
    case 'position.x':
      return clip.position.x
    case 'position.y':
      return clip.position.y
    case 'scale':
      return clip.scale
    case 'rotation':
      return clip.rotation
    case 'volume':
      return clipVolume(clip)
    case 'opacity':
    default:
      return clipOpacity(clip)
  }
}

/** 播放头在目标内的本地时间 0…1。 */
export function animationTimeAt(target: AnimationTarget, playhead: number): number {
  if (!(target.duration > 0)) return 0
  return Math.min(1, Math.max(0, (playhead - target.start) / target.duration))
}

/** 播放头在目标内的本地秒数。 */
export function animationLocalSeconds(target: AnimationTarget, playhead: number): number {
  return Math.max(0, Math.min(target.duration, playhead - target.start))
}

/**
 * 用新的 anim 值替换目标对象。
 * 只改目标自身，不动同轨其他片段；返回 null 表示目标已不存在。
 */
export function replaceAnimationTarget(
  project: Project,
  target: AnimationTarget,
  updated: Clip | AudioClip | TextClip,
): Project | null {
  if (target.kind === 'clip') {
    if (target.trackId === null) {
      if (!project.clips.some((clip) => clip.id === target.clipId)) return null
      return {
        ...project,
        clips: project.clips.map((clip) =>
          clip.id === target.clipId ? (updated as Clip) : clip,
        ),
      }
    }
    const tracks = project.overlayTracks ?? []
    if (!tracks.some((track) => track.id === target.trackId)) return null
    return {
      ...project,
      overlayTracks: tracks.map((track) =>
        track.id === target.trackId
          ? {
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === target.clipId ? (updated as Clip) : clip,
              ),
            }
          : track,
      ),
    }
  }

  if (target.kind === 'text') {
    const tracks = project.textTracks ?? []
    if (!tracks.some((track) => track.id === target.trackId)) return null
    return {
      ...project,
      textTracks: tracks.map((track) =>
        track.id === target.trackId
          ? {
              ...track,
              clips: track.clips.map((clip) =>
                clip.id === target.clipId ? (updated as TextClip) : clip,
              ),
            }
          : track,
      ),
    }
  }

  const tracks = project.audioTracks ?? []
  if (!tracks.some((track) => track.id === target.trackId)) return null
  return {
    ...project,
    audioTracks: tracks.map((track) =>
      track.id === target.trackId
        ? {
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === target.clipId ? (updated as AudioClip) : clip,
            ),
          }
        : track,
    ),
  }
}

/** 仅保留目标类型的合法属性（写入前防御旧草稿/手工数据）。 */
export function sanitizeTargetAnimation(
  target: AnimationTarget,
  anim: AnimationMap | undefined,
): AnimationMap | undefined {
  if (!anim) return undefined
  if (target.kind === 'audio') {
    return anim.volume?.length ? { volume: anim.volume } : undefined
  }
  if (target.kind === 'text') {
    const next: AnimationMap = {}
    for (const prop of TEXT_ANIMATABLE_PROPERTIES) {
      const keys = anim[prop]
      if (keys?.length) next[prop] = keys
    }
    return Object.keys(next).length > 0 ? next : undefined
  }
  return anim
}
